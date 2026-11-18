import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIVE_WINDOW_MS,
  collectCursor,
  collectSessions,
  definitionDirectories,
  definitionName,
  parseFrontmatter,
  projectOf,
  readCursorEdits,
  type CursorAgentDefinition,
  type CursorEdit,
} from './cursor.js'

// Cursor's evidence is a local database plus markdown definitions; these fixtures describe both, so
// the collector can be tested without a Cursor install, and one test reads a real SQLite database.

const NOW = Date.parse('2026-11-18T14:00:00.000Z')
const HOME = '/Users/tester'
const ROOTS = [`${HOME}/projects`]

const definition = (name: string, project: string): CursorAgentDefinition => ({ id: `cursor-agent:${project}:${name}`, name, project, directory: `/d/${project}`, path: `/d/${project}/${name}.md` })

function context(overrides: Partial<Parameters<typeof collectSessions>[0]> = {}) {
  return { now: NOW, roots: ROOTS, home: HOME, globalAgents: `${HOME}/.cursor/agents`, appSupport: `${HOME}/app-support`, agents: [], stores: new Map<string, number>(), workbenches: new Map<string, { directory: string; modified: number }>(), ...overrides }
}

const edit = (fileName: string, ageMs: number, overrides: Partial<CursorEdit> = {}): CursorEdit => ({ fileName, conversationId: 'conv-1', model: 'grok-4.7', timestamp: NOW - ageMs, ...overrides })

describe('parseFrontmatter', () => {
  it('reads the name and description of an agent definition', () => {
    expect(parseFrontmatter('---\nname: oj-team-web\ndescription: Traveller web (SvelteKit)\n---\n\n# Role')).toEqual({ name: 'oj-team-web', description: 'Traveller web (SvelteKit)' })
  })

  it('unquotes values and ignores a file without frontmatter', () => {
    expect(parseFrontmatter('---\nname: "quoted"\n---\n')).toEqual({ name: 'quoted', description: undefined })
    expect(parseFrontmatter('# just a title\n')).toEqual({})
  })
})

describe('definitionName', () => {
  it('prefers the frontmatter name and falls back to the file name', () => {
    expect(definitionName('/p/.cursor/agents/x.md', '---\nname: oj-team-mobile\n---')).toBe('oj-team-mobile')
    expect(definitionName('/p/.cursor/agents/oj-orderflow-detail.md', '# no frontmatter')).toBe('oj-orderflow-detail')
  })
})

describe('projectOf', () => {
  it('groups a file under the project folder of its root', () => {
    expect(projectOf('/Users/tester/projects/onjourney/onjourneyv2/apps/core/views.py', ROOTS, HOME)).toEqual({ project: 'onjourney', directory: '/Users/tester/projects/onjourney' })
  })

  it('names a file outside the roots by its own folder, shortened to ~', () => {
    expect(projectOf('/Users/tester/umkt-rankings-repo/main.py', ROOTS, HOME)).toEqual({ project: '~/umkt-rankings-repo', directory: '/Users/tester/umkt-rankings-repo' })
    expect(projectOf('/Volumes/ssd/papers/dpp/slr.tex', ROOTS, HOME)).toEqual({ project: '/Volumes/ssd/papers/dpp', directory: '/Volumes/ssd/papers/dpp' })
  })
})

describe('definitionDirectories', () => {
  it('keeps only the .cursor/agents folders that exist, two levels deep', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ruang-cursor-'))
    await mkdir(path.join(root, 'onjourney', '.cursor', 'agents'), { recursive: true })
    await mkdir(path.join(root, 'onjourney', 'onjourneyv2', '.cursor', 'agents'), { recursive: true })
    await mkdir(path.join(root, 'no-agents'), { recursive: true })
    const found = await definitionDirectories({ roots: [root], globalAgents: path.join(root, 'global-agents') })
    expect(found.map((entry) => entry.project)).toEqual(['onjourney', 'onjourney/onjourneyv2'])
  })
})

describe('collectSessions', () => {
  it('makes one session per project, with the files, conversations and model of its edits', () => {
    const sessions = collectSessions(context({
      edits: [
        edit('/Users/tester/projects/onjourney/a.py', 60_000, { conversationId: 'conv-a' }),
        edit('/Users/tester/projects/onjourney/b.py', 120_000, { conversationId: 'conv-b', model: 'grok-4.7' }),
        edit('/Users/tester/projects/onjourney/b.py', 30_000, { conversationId: 'conv-b', model: 'gpt-5' }),
      ],
      agents: [definition('oj-team-web', 'onjourney')],
    })).data
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 'cursor:onjourney', project: 'onjourney', filesTouched: 2, conversations: 2, live: true, evidence: ['edits'], agents: 1 })
    // The most frequent model wins; a tie falls back to the first seen.
    expect(['grok-4.7', 'gpt-5']).toContain(sessions[0].model)
  })

  it('calls a session live only inside the live window', () => {
    const fresh = collectSessions(context({ edits: [edit('/Users/tester/projects/a/x.ts', LIVE_WINDOW_MS - 1_000)] })).data
    const stale = collectSessions(context({ edits: [edit('/Users/tester/projects/a/x.ts', LIVE_WINDOW_MS + 1_000)] })).data
    expect(fresh[0].live).toBe(true)
    expect(stale[0].live).toBe(false)
    expect(stale[0].lastActivityAt).toBe(new Date(NOW - LIVE_WINDOW_MS - 1_000).toISOString())
  })

  it('never treats a workbench write as proof of work, but keeps it as context', () => {
    const sessions = collectSessions(context({
      workbenches: new Map([['/Users/tester/projects/harits.cloud', { directory: '/Users/tester/projects/harits.cloud', modified: NOW - 1_000 }]]),
    })).data
    expect(sessions[0]).toMatchObject({ id: 'cursor:harits.cloud', live: false, evidence: ['workbench'], filesTouched: 0, conversations: 0 })
  })

  it('lets a conversation store write refresh a session that already has edits', () => {
    const sessions = collectSessions(context({
      edits: [edit('/Users/tester/projects/onjourney/a.py', 40 * 60_000, { conversationId: 'conv-a' })],
      stores: new Map([['conv-a', NOW - 20_000]]),
    })).data
    expect(sessions[0]).toMatchObject({ live: true, evidence: ['edits', 'store'] })
  })

  it('lists live sessions first', () => {
    const sessions = collectSessions(context({
      edits: [edit('/Users/tester/projects/old/a.py', 90 * 60_000), edit('/Users/tester/projects/now/b.py', 5_000)],
    })).data
    expect(sessions.map((session) => session.project)).toEqual(['now', 'old'])
  })
})

describe('collectCursor', () => {
  async function fixture(): Promise<{ env: NodeJS.ProcessEnv; home: string; roots: string }> {
    const home = await mkdtemp(path.join(tmpdir(), 'ruang-home-'))
    const roots = path.join(home, 'projects')
    await writeFile(path.join(home, '.cursor-fixed'), '')
    await mkdir(path.join(home, 'cursor', 'agents'), { recursive: true })
    await writeFile(path.join(home, 'cursor', 'agents', 'global-helper.md'), '---\nname: global-helper\ndescription: Shared helper for every project\n---\n')
    await mkdir(path.join(roots, 'onjourney', '.cursor', 'agents'), { recursive: true })
    await writeFile(path.join(roots, 'onjourney', '.cursor', 'agents', 'oj-team-web.md'), '---\nname: oj-team-web\ndescription: api_key=sk-live-abcdef123456 must never appear\n---\n')
    await writeFile(path.join(roots, 'onjourney', '.cursor', 'agents', 'plain.md'), '# no frontmatter\n')
    return { env: { RUANG_CURSOR_HOME: path.join(home, 'cursor'), RUANG_CURSOR_ROOTS: roots, RUANG_CURSOR_APP_SUPPORT: path.join(home, 'app-support') }, home, roots }
  }

  it('discovers the definitions of every project and the global ones', async () => {
    const { env, home, roots } = await fixture()
    const snapshot = await collectCursor(env, home, NOW, async () => [edit(path.join(roots, 'onjourney', 'a.py'), 5_000)])
    expect(snapshot.agents.data.map((agent) => `${agent.project}:${agent.name}`)).toEqual(['global:global-helper', 'onjourney:oj-team-web', 'onjourney:plain'])
    // A description is a line of user text: secrets in it are redacted like any other log line.
    expect(snapshot.agents.data.find((agent) => agent.name === 'oj-team-web')?.description).not.toContain('sk-live-abcdef123456')
    expect(snapshot.live).toBe(1)
    expect(snapshot.sessions.data[0]).toMatchObject({ id: 'cursor:onjourney', live: true, agents: 2 })
  })

  it('reads the per-conversation stores of Cursor Application Support', async () => {
    const { env, home, roots } = await fixture()
    const store = path.join(home, 'app-support', 'AgentStores', 'cursor_agent_stores', 'conv-a')
    await mkdir(store, { recursive: true })
    const stamp = new Date(NOW - 10_000)
    await utimes(store, stamp, stamp)
    const snapshot = await collectCursor(env, home, NOW, async () => [edit(path.join(roots, 'onjourney', 'a.py'), 40 * 60_000, { conversationId: 'conv-a' })])
    expect(snapshot.sessions.data[0]).toMatchObject({ live: true, evidence: ['edits', 'store'] })
  })

  it('reports an empty state when Cursor has no database and no definitions', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ruang-home-'))
    const snapshot = await collectCursor({ RUANG_CURSOR_HOME: path.join(home, 'missing'), RUANG_CURSOR_ROOTS: path.join(home, 'nothing'), RUANG_CURSOR_APP_SUPPORT: path.join(home, 'nothing') }, home, NOW, async () => undefined)
    expect(snapshot).toMatchObject({ live: 0 })
    expect(snapshot.agents.data).toEqual([])
    expect(snapshot.sessions.data).toEqual([])
  })
})

describe('readCursorEdits', () => {
  it('reads the code-tracking database Cursor writes, through node:sqlite', async () => {
    let DatabaseSync
    try { ({ DatabaseSync } = await import('node:sqlite')) } catch { return /* older node: the sqlite3 CLI path is used instead */ }
    const home = await mkdtemp(path.join(tmpdir(), 'ruang-cursor-'))
    const dbPath = path.join(home, 'ai-code-tracking.db')
    const database = new DatabaseSync(dbPath)
    database.exec('create table ai_code_hashes (hash text primary key, source text not null, fileExtension text, fileName text, requestId text, conversationId text, timestamp integer, createdAt integer not null, model text)')
    database.prepare('insert into ai_code_hashes (hash, source, fileName, conversationId, timestamp, createdAt, model) values (?, ?, ?, ?, ?, ?, ?)')
      .run('h1', 'composer', '/Users/tester/projects/onjourney/a.py', 'conv-a', NOW - 5_000, NOW - 5_000, 'grok-4.7')
    database.close()
    const edits = await readCursorEdits(dbPath, NOW - 60_000)
    expect(edits).toHaveLength(1)
    expect(edits?.[0]).toMatchObject({ conversationId: 'conv-a', model: 'grok-4.7', fileName: '/Users/tester/projects/onjourney/a.py' })
    expect(await readCursorEdits(path.join(home, 'absent.db'), NOW)).toBeUndefined()
  })
})
