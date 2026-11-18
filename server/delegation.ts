// Subagents of a running delegation. Hermes writes one manifest plus one append-only transcript
// per child under `<hermes root>/cache/delegation/live/<delegation_id>/`, and the manifest is
// created before the children start with every task `status: "running"`. That directory is the
// only durable, read-only evidence that a delegation child is working right now, so Ruang reads
// it directly (like the Folders page reads a profile folder) instead of running a command.
//
// Nothing here is raw: only the delegation id, the child's 1-based index, the goal label Hermes
// already capped at 500 characters (redacted again by us), the model, and timestamps. Transcript
// contents are never read — only their last-modified time, as the proof of recent output.

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hermesRoot } from './folders.js'
import { redactLogLine } from './redact.js'
import type { Source } from './mission-control.js'

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'unknown'

/** One delegation child: an agent that exists only while its batch runs. */
export interface SubagentRun {
  /** Station id, unique per child: `sub:<delegation>#<index>`. */
  id: string
  delegation: string
  /** The delegation id without its `deleg_` prefix, for compact labels. */
  short: string
  /** 0-based index in the batch (the dispatch order). */
  index: number
  total: number
  /** Short human label of what this child is doing: the first line of its goal, redacted. */
  label: string
  /** The child's goal as Hermes wrote it (capped, redacted again): the dialog's detail text. */
  goal: string
  status: SubagentStatus
  /** True only while the child is running and its transcript was written recently. */
  live: boolean
  /** The Hermes profile whose delegation this child belongs to. */
  profile: string
  model?: string
  startedAt?: string
  /** Last write to the child's transcript: its last visible sign of output. */
  lastOutputAt?: string
}

export interface SubagentSnapshot {
  runs: Source<SubagentRun[]>
  /** How many of those children are working right now (the office shows exactly these). */
  live: number
  fetchedAt: string
}

/** A child with no transcript write for this long is not shown as working: Ruang never invents work. */
export const LIVE_WINDOW_MS = 5 * 60_000
/** A batch older than this is history even if its manifest was never completed (a killed run). */
export const MAX_RUN_MS = 6 * 60 * 60_000
/** Bounds, so a machine with months of delegations stays cheap to read. */
const MAX_BATCHES = 20
const MAX_RUNS = 40
const MAX_PROFILE_ROOTS = 50
export const LABEL_MAX = 72
export const GOAL_MAX = 240

const DELEGATION_ID = /^deleg_[A-Za-z0-9_-]{1,64}$/
const PRIVATE_LABEL = 'Subagent'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstLine(value: string, max: number): string {
  const line = value.split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Local time, as Hermes writes it (`%Y-%m-%d %H:%M:%S`). */
function startedEpoch(value: unknown): number | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const parsed = Date.parse(raw.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function statusOf(value: unknown, batchCompleted: boolean): SubagentStatus {
  const status = (text(value) ?? '').toLowerCase()
  if (batchCompleted) return status === 'completed' ? 'completed' : status === 'running' ? 'unknown' : /fail|error|timed? ?out|interrupt|cancel|refus|abort/.test(status) ? 'failed' : 'unknown'
  if (status === 'running' || status === '') return 'running'
  if (status === 'completed') return 'completed'
  return /fail|error|timed? ?out|interrupt|cancel|refus|abort/.test(status) ? 'failed' : 'unknown'
}

export interface ManifestContext {
  delegation: string
  profile: string
  now: number
  /** Last-modified time of the batch directory, used when a manifest has no usable `started`. */
  dirModified?: number
  /** Last-modified time of one child's transcript, keyed by its `index`. */
  logModified?: Map<number, number>
  /** Whether the batch directory still exists; when false the manifest itself is the only evidence. */
  manifestModified?: number
}

/**
 * The manifest document of one delegation batch -> the children it declares. Pure, so the
 * shape Hermes writes is tested directly: unknown fields are ignored, a task without an index
 * is skipped, and the goal is redacted and capped before it leaves this function.
 */
export function parseManifest(value: unknown, context: ManifestContext): SubagentRun[] {
  if (!value || typeof value !== 'object') return []
  const manifest = value as Record<string, unknown>
  const delegation = text(manifest.delegation_id) ?? context.delegation
  if (!DELEGATION_ID.test(delegation)) return []
  const batchCompletedAt = startedEpoch(manifest.completed)
  const batchCompleted = batchCompletedAt !== undefined
  const startedAt = startedEpoch(manifest.started) ?? context.dirModified
  const total = typeof manifest.task_count === 'number' && Number.isFinite(manifest.task_count) && manifest.task_count > 0 ? manifest.task_count : Array.isArray(manifest.tasks) ? manifest.tasks.length : 0
  const batchModel = text(manifest.model)
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : []
  const runs: SubagentRun[] = []
  for (const item of tasks) {
    if (!item || typeof item !== 'object') continue
    const task = item as Record<string, unknown>
    const index = typeof task.index === 'number' && Number.isInteger(task.index) && task.index >= 0 && task.index < 10_000 ? task.index : undefined
    if (index === undefined) continue
    const status = statusOf(task.status, batchCompleted)
    const goal = redactLogLine(text(task.goal) ?? '', GOAL_MAX)
    const lastOutput = context.logModified?.get(index) ?? context.manifestModified ?? context.dirModified
    // `started` is kept for finished batches too: it is when the child ran, even if it is not live now.
    const start = startedAt
    const live = status === 'running' && !batchCompleted
      && start !== undefined && lastOutput !== undefined
      && context.now - start >= -60_000 && context.now - start <= MAX_RUN_MS
      && context.now - lastOutput >= -60_000 && context.now - lastOutput <= LIVE_WINDOW_MS
    runs.push({
      id: `sub:${delegation}#${index}`,
      delegation,
      short: delegation.replace(/^deleg_/, ''),
      index,
      total: Math.max(total, index + 1),
      label: firstLine(goal, LABEL_MAX) || PRIVATE_LABEL,
      goal,
      status,
      live,
      profile: context.profile,
      model: text(task.model) ?? batchModel,
      startedAt: start !== undefined ? new Date(start).toISOString() : undefined,
      lastOutputAt: lastOutput !== undefined ? new Date(lastOutput).toISOString() : undefined,
    })
  }
  return runs
}

interface Root { profile: string; dir: string }

/** The live-transcript roots to read: the default profile's, then one per Hermes profile that has one. */
export async function delegationRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<Root[]> {
  const root = hermesRoot(env, home)
  const roots: Root[] = [{ profile: 'default', dir: join(root, 'cache', 'delegation', 'live') }]
  try {
    const profiles = await readdir(join(root, 'profiles'), { withFileTypes: true })
    for (const entry of profiles.slice(0, MAX_PROFILE_ROOTS)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      roots.push({ profile: entry.name, dir: join(root, 'profiles', entry.name, 'cache', 'delegation', 'live') })
    }
  } catch { /* no profiles folder: the default root is all there is */ }
  return roots
}

async function modified(path: string): Promise<number | undefined> {
  try { return (await stat(path)).mtimeMs } catch { return undefined }
}

async function readBatch(directory: Root & { name: string }, now: number): Promise<SubagentRun[]> {
  const manifestPath = join(directory.dir, directory.name, 'manifest.json')
  const [manifestText, manifestModified, dirModified] = await Promise.all([
    readFile(manifestPath, 'utf8').catch(() => undefined),
    modified(manifestPath),
    modified(join(directory.dir, directory.name)),
  ])
  if (!manifestText) return []
  let parsed: unknown
  try { parsed = JSON.parse(manifestText.replace(/^\uFEFF/, '')) } catch { return [] }
  const tasks = (parsed as Record<string, unknown> | null)?.tasks
  const logModified = new Map<number, number>()
  if (Array.isArray(tasks)) {
    await Promise.all(tasks.map(async (item) => {
      const task = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const index = typeof task.index === 'number' ? task.index : undefined
      const log = text(task.log)
      // Only the log file's name inside this batch is trusted; anything else is ignored.
      if (index === undefined || !log || log.includes('/') || log.includes('\\') || !/^[\w.-]{1,64}$/.test(log)) return
      const time = await modified(join(directory.dir, directory.name, log))
      if (time !== undefined) logModified.set(index, time)
    }))
  }
  return parseManifest(parsed, { delegation: directory.name, profile: directory.profile, now, dirModified, logModified, manifestModified })
}

/**
 * Every child of every recent delegation batch. A missing delegation directory is an empty
 * state, not an error; a directory that exists but cannot be read is reported as unavailable.
 */
export async function collectSubagents(env: NodeJS.ProcessEnv = process.env, home = homedir(), now = Date.now()): Promise<Source<SubagentRun[]>> {
  const roots = await delegationRoots(env, home)
  const runs: SubagentRun[] = []
  let seen = 0
  for (const root of roots) {
    let batches: { name: string; modified: number }[] = []
    try {
      const entries = await readdir(root.dir, { withFileTypes: true })
      batches = entries.filter((entry) => entry.isDirectory() && DELEGATION_ID.test(entry.name)).map((entry) => ({ name: entry.name, modified: 0 }))
    } catch { continue }
    // Newest batches first, and only the newest few are opened.
    const withTimes = await Promise.all(batches.map(async (batch) => ({ ...batch, modified: (await modified(join(root.dir, batch.name))) ?? 0 })))
    withTimes.sort((a, b) => b.modified - a.modified)
    for (const batch of withTimes.slice(0, MAX_BATCHES)) {
      try {
        runs.push(...await readBatch({ ...root, name: batch.name }, now))
        seen += 1
      } catch { /* one unreadable batch never hides the others */ }
    }
  }
  runs.sort((a, b) => (Number(b.live) - Number(a.live)) || (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0) || a.index - b.index)
  void seen
  return { availability: 'available', data: runs.slice(0, MAX_RUNS) }
}

const CACHE_MS = 10_000
let entry: { value: SubagentSnapshot; expires: number } | undefined
let inflight: Promise<SubagentSnapshot> | undefined

/** Cached subagent snapshot; concurrent callers share one read. */
export function getSubagents(now = Date.now()): Promise<SubagentSnapshot> {
  if (entry && entry.expires > now) return Promise.resolve(entry.value)
  inflight ??= collectSubagents(process.env, homedir(), now).then((runs) => {
    const value: SubagentSnapshot = { runs, live: runs.data.filter((run) => run.live).length, fetchedAt: new Date().toISOString() }
    entry = { value, expires: Date.now() + CACHE_MS }
    return value
  }).catch((): SubagentSnapshot => {
    const value: SubagentSnapshot = { runs: { availability: 'unavailable', data: [], error: { code: 'COMMAND_FAILED', message: 'The delegation transcripts could not be read.' } }, live: 0, fetchedAt: new Date().toISOString() }
    entry = { value, expires: Date.now() + CACHE_MS }
    return value
  }).finally(() => { inflight = undefined })
  return inflight
}

export function clearSubagentCache(): void { entry = undefined }
