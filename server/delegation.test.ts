import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOfficeSnapshot, buildOfficeSummary } from './mission-control.js'
import { collectSubagents, parseManifest } from './delegation.js'

// Local wall clock, the format Hermes writes into the manifest (`%Y-%m-%d %H:%M:%S`).
const STARTED = '2026-11-18 20:00:00'
const START = Date.parse(STARTED.replace(' ', 'T'))
const AT = START + 5_000

const runtime = {
  profiles: { availability: 'available' as const, data: [{ name: 'default', model: 'm', gateway: 'Running' as const }, { name: 'coder', model: 'm', gateway: 'Running' as const }] },
  openCode: { availability: 'available' as const, data: '1.0.0' },
  fetchedAt: '2026-11-18T12:00:00.000Z',
}
const emptyBoard = { tasks: { availability: 'available' as const, data: [] }, fetchedAt: runtime.fetchedAt }
const emptyActivity = { sessions: { availability: 'available' as const, data: [] }, fetchedAt: runtime.fetchedAt }

async function writeBatch(root: string, options: { id: string; manifest: unknown; logs?: string[]; logAgeMs?: number; profile?: string }): Promise<void> {
  const directory = path.join(root, ...(options.profile ? ['profiles', options.profile] : []), 'cache', 'delegation', 'live', options.id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(options.manifest))
  for (const name of options.logs ?? []) {
    const file = path.join(directory, name)
    await writeFile(file, 'working\n')
    const stamp = new Date(AT - (options.logAgeMs ?? 0))
    await utimes(file, stamp, stamp)
  }
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delegation_id: 'deleg_abc123',
    started: STARTED,
    task_count: 2,
    model: 'wf/deepseek-v4.1-flash',
    provider: 'wflab',
    tasks: [
      { index: 0, goal: 'Petakan repo onjourneyv2 secara read-only\nmore detail', log: 'task-0.log', status: 'running' },
      { index: 1, goal: 'Audit CI: api_key=abcdef123456 should never appear', log: 'task-1.log', status: 'running' },
    ],
    ...overrides,
  }
}

describe('delegation manifest', () => {
  it('reads one agent per child, live while its transcript is fresh', () => {
    const runs = parseManifest(manifest(), { delegation: 'deleg_abc123', profile: 'default', now: AT, logModified: new Map([[0, AT - 3_000], [1, AT - 4_000]]) })
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ id: 'sub:deleg_abc123#0', short: 'abc123', index: 0, total: 2, status: 'running', live: true, profile: 'default', model: 'wf/deepseek-v4.1-flash', label: 'Petakan repo onjourneyv2 secara read-only' })
    expect(runs[1].label).toContain('[redacted]')
    expect(runs[1].goal).not.toContain('abcdef123456')
  })

  it('never calls a child live once the batch is completed or its output is old', () => {
    const completed = parseManifest(manifest({ completed: STARTED, tasks: [{ index: 0, goal: 'done', log: 'task-0.log', status: 'completed' }] }), { delegation: 'deleg_abc123', profile: 'default', now: AT, logModified: new Map([[0, AT - 1_000]]) })
    const quiet = parseManifest(manifest(), { delegation: 'deleg_abc123', profile: 'default', now: AT, logModified: new Map([[0, AT - 20 * 60_000], [1, AT - 20 * 60_000]]) })
    expect(completed[0]).toMatchObject({ status: 'completed', live: false })
    expect(quiet.map((run) => run.live)).toEqual([false, false])
    expect(quiet[0].status).toBe('running')
  })

  it('keeps a failed child out of the working state and skips tasks it cannot place', () => {
    const runs = parseManifest(manifest({ completed: STARTED, tasks: [{ index: 0, goal: 'boom', status: 'failed', exit_reason: 'HTTP 400' }, { goal: 'no index' }, null] }), { delegation: 'deleg_abc123', profile: 'default', now: AT })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ index: 0, status: 'failed', live: false })
  })

  it('ignores anything that is not a delegation id', () => {
    expect(parseManifest(manifest({ delegation_id: '../etc/passwd' }), { delegation: 'deleg_abc123', profile: 'default', now: AT })).toEqual([])
    expect(parseManifest('not an object', { delegation: 'deleg_abc123', profile: 'default', now: AT })).toEqual([])
  })
})

describe('delegation transcripts on disk', () => {
  it('finds working children across the default and profile roots, and never throws on a missing one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ruang-deleg-'))
    await writeBatch(root, { id: 'deleg_live1', manifest: manifest({ delegation_id: 'deleg_live1' }), logs: ['task-0.log', 'task-1.log'], logAgeMs: 2_000 })
    await writeBatch(root, { id: 'deleg_old1', manifest: manifest({ delegation_id: 'deleg_old1' }), logs: ['task-0.log', 'task-1.log'], logAgeMs: 30 * 60_000 })
    await writeBatch(root, { id: 'deleg_prof1', manifest: manifest({ delegation_id: 'deleg_prof1', tasks: [{ index: 0, goal: 'Recon for coder', log: 'task-0.log', status: 'running' }] }), logs: ['task-0.log'], logAgeMs: 1_000, profile: 'coder' })
    const snapshot = await collectSubagents({ RUANG_HERMES_ROOT: root }, '/nonexistent-home', AT)
    expect(snapshot.availability).toBe('available')
    expect(snapshot.data).toHaveLength(5)
    expect(snapshot.data.map((run) => run.live)).toEqual([true, true, true, false, false])
    expect(snapshot.data.filter((run) => run.profile === 'coder').map((run) => run.label)).toEqual(['Recon for coder'])
    const empty = await collectSubagents({ RUANG_HERMES_ROOT: path.join(root, 'nothing-here') }, '/nonexistent-home', AT)
    expect(empty).toMatchObject({ availability: 'available', data: [] })
  })

  it('skips a manifest it cannot parse instead of failing the read', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ruang-deleg-'))
    const directory = path.join(root, 'cache', 'delegation', 'live', 'deleg_bad1')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'manifest.json'), '{ not json')
    const snapshot = await collectSubagents({ RUANG_HERMES_ROOT: root }, '/nonexistent-home', AT)
    expect(snapshot).toMatchObject({ availability: 'available', data: [] })
  })
})

describe('office with subagents', () => {
  const snapshot = {
    runs: { availability: 'available' as const, data: [
      { id: 'sub:deleg_abc123#0', delegation: 'deleg_abc123', short: 'abc123', index: 0, total: 2, label: 'Petakan repo onjourneyv2', goal: 'Petakan repo onjourneyv2', status: 'running' as const, live: true, profile: 'default', model: 'wf/deepseek-v4.1-flash', startedAt: '2026-11-18T12:00:00.000Z', lastOutputAt: '2026-11-18T12:00:04.000Z' },
      { id: 'sub:deleg_abc123#1', delegation: 'deleg_abc123', short: 'abc123', index: 1, total: 2, label: 'Audit CI', goal: 'Audit CI', status: 'completed' as const, live: false, profile: 'default' },
    ] },
    live: 1,
    fetchedAt: '2026-11-18T12:00:05.000Z',
  }

  it('gives every working subagent a desk and keeps it out of the declared count', () => {
    const office = buildOfficeSnapshot(runtime, emptyBoard, emptyActivity, { now: AT, subagents: snapshot })
    expect(office.stations.map((station) => station.name)).toEqual(['default', 'coder', 'opencode', '1/2 · abc123'])
    expect(office.stations[3]).toMatchObject({ id: 'sub:deleg_abc123#0', kind: 'subagent', parent: 'default', role: 'Subagent (delegation child)', room: 'Workspace', roomPosition: 'assigned-desk', seat: 4, state: 'Working', activity: 'Subagent: Petakan repo onjourneyv2' })
    expect(office.stations[3].subagent).toMatchObject({ delegation: 'deleg_abc123', index: 0, total: 2, model: 'wf/deepseek-v4.1-flash' })
    expect(office.summary).toEqual({ declared: 3, active: 1, idle: 3, offline: 0, unknown: 0, subagents: 1, gatewaysReachable: 2, gatewaysDeclared: 2 })
    // The finished child is history: it is nowhere in the office.
    expect(office.stations.some((station) => station.id === 'sub:deleg_abc123#1')).toBe(false)
  })

  it('leaves the office exactly as before when no delegation is running', () => {
    const office = buildOfficeSnapshot(runtime, emptyBoard, emptyActivity, { now: AT })
    expect(office.stations).toHaveLength(3)
    expect(buildOfficeSummary(office.stations, runtime)).toEqual({ declared: 3, active: 0, idle: 3, offline: 0, unknown: 0, gatewaysReachable: 2, gatewaysDeclared: 2 })
  })
})
