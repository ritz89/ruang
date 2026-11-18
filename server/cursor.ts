// Cursor agents and sessions. Cursor is a second way to run an agent on this machine, and it
// records two things locally that Ruang can read without asking Cursor anything:
//
//  1. the agent definitions the user wrote — `.cursor/agents/*.md` in a project, or `~/.cursor/agents`
//     for the global ones — each with a name and a description in its frontmatter;
//  2. the edits Cursor's AI actually made, in its own code-tracking database
//     (`~/.cursor/ai-tracking/ai-code-tracking.db`: conversation, model, file, timestamp), plus the
//     per-conversation stores Cursor keeps under Application Support, which show that a conversation
//     is still being written to.
//
// So the rule stays the same as for profiles and subagents: discovered, not configured. Nothing here
// is raw — a definition contributes its name and description (redacted again, capped); a session
// contributes the project folder, the model, counts and timestamps. Conversation titles, prompts and
// file contents are never read.
//
// Two limits are deliberate. Cursor does not record locally which *named* agent a session used (it
// keeps that on its servers), so a live station is named after its project, and the project's
// definitions are listed in the dialog instead of guessing one. And the workbench state file is read
// only as context, never as proof of work: macOS rewrites it for many workspaces at once on quit, so
// trusting it would invent five agents at a desk at the same second.

import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactLogLine } from './redact.js'
import type { Source } from './mission-control.js'

/** One agent the user defined for Cursor: a markdown file with a name in its frontmatter. */
export interface CursorAgentDefinition {
  /** Id, unique per definition: `cursor-agent:<project>:<name>`. */
  id: string
  name: string
  /** The project folder it belongs to, or `global` for `~/.cursor/agents`. */
  project: string
  /** The `.cursor/agents` directory holding it. */
  directory: string
  path: string
  description?: string
  modifiedAt?: string
}

/** One project Cursor has been working in: the unit Ruang shows at a desk. */
export interface CursorSession {
  /** Station id, unique per project: `cursor:<project>`. */
  id: string
  project: string
  directory: string
  model?: string
  /** Distinct conversations seen in the evidence window. */
  conversations: number
  /** Distinct files Cursor's AI wrote in the evidence window. */
  filesTouched: number
  lastActivityAt: string
  /** True only while an AI edit or a conversation store write is inside LIVE_WINDOW_MS. */
  live: boolean
  /** Which local evidence the session rests on, so the dialog can be honest about it. */
  evidence: ('edits' | 'store' | 'workbench')[]
  /** How many Cursor agent definitions this project holds. */
  agents: number
}

export interface CursorSnapshot {
  agents: Source<CursorAgentDefinition[]>
  sessions: Source<CursorSession[]>
  /** How many projects Cursor is working in right now (the office shows exactly these). */
  live: number
  fetchedAt: string
}

/** A Cursor session with no AI edit and no store write for this long is not shown as working. */
export const LIVE_WINDOW_MS = 10 * 60_000
/** How far back the edit evidence is read; older sessions are history. */
export const EVIDENCE_WINDOW_MS = 24 * 60 * 60_000
export const DESCRIPTION_MAX = 200
export const NAME_MAX = 60
/** Bounds, so a machine with years of Cursor history stays cheap to read. */
const MAX_ROOT_ENTRIES = 300
const MAX_DEFINITION_DIRS = 120
const MAX_DEFINITION_FILES = 300
const MAX_EDIT_ROWS = 800
const MAX_STORES = 60
const MAX_WORKSPACES = 250
const MAX_SESSIONS = 20
const SKIP_ENTRY = /^(node_modules|\.git|\.next|dist|build|vendor|Pods|\.venv|venv|__pycache__)$/

/** Where Cursor keeps its own state (`RUANG_CURSOR_HOME` overrides). */
export function cursorHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.RUANG_CURSOR_HOME?.trim()
  return override ? override.replace(/^~(?=\/|$)/, home) : join(home, '.cursor')
}

/** Cursor's Application Support directory, where the conversation stores and workbench state live. */
export function cursorAppSupport(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.RUANG_CURSOR_APP_SUPPORT?.trim()
  if (override) return override.replace(/^~(?=\/|$)/, home)
  return join(home, 'Library', 'Application Support', 'Cursor')
}

/** The folders searched for `.cursor/agents` definitions (`RUANG_CURSOR_ROOTS`, colon separated). */
export function cursorProjectRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.RUANG_CURSOR_ROOTS?.trim()
  if (override) return override.split(':').map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.replace(/^~(?=\/|$)/, home))
  return [join(home, 'projects')]
}

/** One row of Cursor's code tracking: an AI edit, with the conversation and model that made it. */
export interface CursorEdit { conversationId?: string; model?: string; fileName?: string; timestamp: number }

/**
 * Reads Cursor's code-tracking database. Injectable so tests can describe evidence without one, and
 * so a machine without a usable database degrades to the other signals instead of failing.
 */
export type EditReader = (dbPath: string, sinceMs: number) => Promise<CursorEdit[] | undefined>

interface CollectContext {
  now: number
  roots: string[]
  home: string
  /** `~/.cursor/agents`: the global definitions, next to the project ones. */
  globalAgents: string
  /** Cursor's Application Support directory: the conversation stores and the workbench state. */
  appSupport: string
  agents: CursorAgentDefinition[]
  edits?: CursorEdit[]
  stores: Map<string, number>
  workbenches: Map<string, { directory: string; modified: number }>
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function modified(path: string): Promise<number | undefined> {
  try { return (await stat(path)).mtimeMs } catch { return undefined }
}

/** `name: value` pairs of a markdown frontmatter block; enough for agent definitions. */
export function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const value = pair[2].trim().replace(/^["']|["']$/g, '').trim()
    if (value) fields[pair[1].toLowerCase()] = value
  }
  return { name: fields.name, description: fields.description }
}

/** The display name Cursor itself uses: the frontmatter name, else the file name. */
export function definitionName(path: string, markdown: string): string {
  const parsed = parseFrontmatter(markdown).name
  return (parsed ?? path.split('/').pop()?.replace(/\.md$/i, '') ?? 'agent').slice(0, NAME_MAX)
}

function definitionId(project: string, name: string, taken: Set<string>): string {
  const base = `cursor-agent:${project}:${name}`
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

/** The `.cursor/agents` directories to read: the global one, then one per project (two levels deep). */
export async function definitionDirectories(context: Pick<CollectContext, 'roots' | 'globalAgents'>): Promise<{ dir: string; project: string }[]> {
  const candidates: { dir: string; project: string }[] = [{ dir: context.globalAgents, project: 'global' }]
  for (const root of context.roots) {
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.slice(0, MAX_ROOT_ENTRIES)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_ENTRY.test(entry.name)) continue
      candidates.push({ dir: join(root, entry.name, '.cursor', 'agents'), project: entry.name })
      // One level deeper, because a workspace can hold the project in a subfolder.
      let children
      try { children = await readdir(join(root, entry.name), { withFileTypes: true }) } catch { continue }
      for (const child of children.slice(0, MAX_ROOT_ENTRIES)) {
        if (!child.isDirectory() || child.name.startsWith('.') || SKIP_ENTRY.test(child.name)) continue
        candidates.push({ dir: join(root, entry.name, child.name, '.cursor', 'agents'), project: `${entry.name}/${child.name}` })
      }
    }
  }
  // Only directories that exist are opened, so the cap counts real agent folders, not every folder.
  const checked = await Promise.all(candidates.map(async (candidate) => ({ ...candidate, exists: await modified(candidate.dir) !== undefined })))
  return checked.filter((candidate) => candidate.exists).map(({ dir, project }) => ({ dir, project })).slice(0, MAX_DEFINITION_DIRS)
}

async function collectDefinitions(context: CollectContext, taken: Set<string>): Promise<void> {
  for (const { dir, project } of await definitionDirectories(context)) {
    let files
    try { files = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const file of files) {
      if (context.agents.length >= MAX_DEFINITION_FILES) return
      if (!file.isFile() || !file.name.toLowerCase().endsWith('.md') || file.name.startsWith('.')) continue
      const path = join(dir, file.name)
      const markdown = await readFile(path, 'utf8').catch(() => undefined)
      if (markdown === undefined) continue
      const name = definitionName(path, markdown)
      const description = parseFrontmatter(markdown).description
      const modifiedAt = await modified(path)
      context.agents.push({
        id: definitionId(project, name, taken),
        name,
        project,
        directory: dir,
        path,
        ...(description ? { description: redactLogLine(description, DESCRIPTION_MAX) } : {}),
        ...(modifiedAt ? { modifiedAt: new Date(modifiedAt).toISOString() } : {}),
      })
    }
  }
}

/** `~/projects/onjourney/onjourneyv2/apps/x.py` → the project `onjourney` under the root. */
export function projectOf(file: string, roots: readonly string[], home: string): { project: string; directory: string } {
  const clean = file.startsWith('/') ? file : join('/', file)
  for (const root of roots) {
    const base = root.endsWith('/') ? root : `${root}/`
    if (!clean.startsWith(base)) continue
    const rest = clean.slice(base.length).split('/').filter(Boolean)
    if (rest.length < 2) continue
    return { project: rest[0], directory: `${root.replace(/\/$/, '')}/${rest[0]}` }
  }
  // Outside the known roots (a dissertation folder, a scratch checkout): name it by its parent.
  const cut = clean.lastIndexOf('/')
  const parent = cut > 0 ? clean.slice(0, cut) : '/'
  return { project: shorten(parent, home), directory: parent }
}

/** Home paths become `~`, so a dialog never spends its width on `/Users/<name>`. */
function shorten(path: string, home: string): string {
  const clean = path.replace(/\/$/, '') || path
  if (home && (clean === home || clean.startsWith(`${home}/`))) return clean.replace(home, '~')
  return clean
}

async function readStores(context: CollectContext): Promise<void> {
  const dir = join(context.appSupport, 'AgentStores', 'cursor_agent_stores')
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  const stores = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).slice(0, MAX_STORES)
  await Promise.all(stores.map(async (entry) => {
    const time = await modified(join(dir, entry.name))
    if (time !== undefined) context.stores.set(entry.name.toLowerCase(), time)
  }))
}

async function readWorkbenches(context: CollectContext): Promise<void> {
  const dir = join(context.appSupport, 'User', 'workspaceStorage')
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries.filter((item) => item.isDirectory()).slice(0, MAX_WORKSPACES)) {
    const raw = await readFile(join(dir, entry.name, 'workspace.json'), 'utf8').catch(() => undefined)
    if (!raw) continue
    let folder: string | undefined
    try { folder = text((JSON.parse(raw) as Record<string, unknown>).folder) } catch { continue }
    if (!folder?.startsWith('file://')) continue
    const time = await modified(join(dir, entry.name, 'state.vscdb'))
    if (time === undefined) continue
    const key = decodeURIComponent(folder.replace('file://', '')).replace(/\/$/, '')
    const previous = context.workbenches.get(key)
    if (!previous || previous.modified < time) context.workbenches.set(key, { directory: key, modified: time })
  }
}

/** Reads Cursor's code-tracking database with node's built-in SQLite, or the `sqlite3` CLI. */
export const readCursorEdits: EditReader = async (dbPath, sinceMs) => {
  const query = `select conversationId, model, fileName, timestamp from ai_code_hashes where createdAt > ${Math.floor(sinceMs)} order by createdAt desc limit ${MAX_EDIT_ROWS}`
  const rows = (parsed: unknown): CursorEdit[] | undefined => {
    if (!Array.isArray(parsed)) return undefined
    return parsed.map((row) => {
      const item = row as Record<string, unknown>
      return { conversationId: text(item.conversationId), model: text(item.model), fileName: text(item.fileName), timestamp: Number(item.timestamp) || 0 }
    })
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(dbPath, { readOnly: true })
    try { return rows(database.prepare(query).all()) } finally { database.close() }
  } catch { /* no built-in sqlite, or an unreadable database: fall back to the CLI */ }
  return new Promise((resolve) => {
    const child = spawn('sqlite3', ['-readonly', '-json', dbPath, query], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => {
      if (code !== 0) return resolve(undefined)
      try { resolve(rows(JSON.parse(output.trim() || '[]'))) } catch { resolve(undefined) }
    })
  })
}

interface SessionDraft {
  project: string
  directory: string
  conversations: Set<string>
  files: Set<string>
  models: Map<string, number>
  /** Last evidence of work: an AI edit, a conversation store write, or a workspace state write. */
  last: { edits: number; store: number; workbench: number }
  evidence: Set<'edits' | 'store' | 'workbench'>
}

function draftFor(drafts: Map<string, SessionDraft>, project: string, directory: string): SessionDraft {
  const key = `${project}\u0000${directory}`
  let found = drafts.get(key)
  if (!found) {
    found = { project, directory, conversations: new Set(), files: new Set(), models: new Map(), last: { edits: 0, store: 0, workbench: 0 }, evidence: new Set() }
    drafts.set(key, found)
  }
  return found
}

/**
 * One session per project, built from the three local signals Cursor leaves behind. Only an AI edit
 * or a store write can make a session live; a workbench write is context (macOS rewrites it for many
 * workspaces at once), so it never puts an agent at a desk.
 */
export function collectSessions(context: CollectContext): Source<CursorSession[]> {
  const drafts = new Map<string, SessionDraft>()
  for (const edit of context.edits ?? []) {
    if (!edit.fileName || !edit.timestamp) continue
    const where = projectOf(edit.fileName, context.roots, context.home)
    const session = draftFor(drafts, where.project, where.directory)
    if (edit.conversationId) session.conversations.add(edit.conversationId)
    session.files.add(edit.fileName)
    if (edit.model) session.models.set(edit.model, (session.models.get(edit.model) ?? 0) + 1)
    session.evidence.add('edits')
    if (edit.timestamp > session.last.edits) session.last.edits = edit.timestamp
  }
  for (const [store, time] of context.stores) {
    // A store is keyed by conversation: it can only refine a session the edit evidence already named.
    for (const session of drafts.values()) {
      if (!session.conversations.has(store)) continue
      session.evidence.add('store')
      if (time > session.last.store) session.last.store = time
    }
  }
  for (const { directory, modified: time } of context.workbenches.values()) {
    const where = projectOf(`${directory}/placeholder`, context.roots, context.home)
    const session = draftFor(drafts, where.project, where.directory)
    session.evidence.add('workbench')
    if (time > session.last.workbench) session.last.workbench = time
  }
  const sessions = [...drafts.values()].map((session): CursorSession => {
    const model = [...session.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const lastWork = Math.max(session.last.edits, session.last.store)
    return {
      id: `cursor:${session.project}`,
      project: session.project,
      directory: session.directory,
      ...(model ? { model } : {}),
      conversations: session.conversations.size,
      filesTouched: session.files.size,
      lastActivityAt: new Date(Math.max(lastWork, session.last.workbench) || 0).toISOString(),
      live: lastWork > 0 && context.now - lastWork <= LIVE_WINDOW_MS,
      evidence: [...session.evidence].sort(),
      agents: context.agents.filter((agent) => agent.project === session.project || agent.project.startsWith(`${session.project}/`)).length,
    }
  })
  sessions.sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || a.project.localeCompare(b.project))
  return { availability: 'available', data: sessions.slice(0, MAX_SESSIONS) }
}

/** Every Cursor agent definition, and every project Cursor has been working in recently. */
export async function collectCursor(env: NodeJS.ProcessEnv = process.env, home = homedir(), now = Date.now(), readEdits: EditReader = readCursorEdits): Promise<CursorSnapshot> {
  const cursorDir = cursorHome(env, home)
  const context: CollectContext = { now, roots: cursorProjectRoots(env, home), home, globalAgents: join(cursorDir, 'agents'), appSupport: cursorAppSupport(env, home), agents: [], stores: new Map(), workbenches: new Map() }
  await collectDefinitions(context, new Set())
  const dbPath = join(cursorDir, 'ai-tracking', 'ai-code-tracking.db')
  context.edits = await readEdits(dbPath, now - EVIDENCE_WINDOW_MS).catch(() => undefined)
  await Promise.all([readStores(context), readWorkbenches(context)])
  const sessions = collectSessions(context)
  return { agents: { availability: 'available', data: context.agents }, sessions, live: sessions.data.filter((session) => session.live).length, fetchedAt: new Date().toISOString() }
}

const CACHE_MS = 15_000
let entry: { value: CursorSnapshot; expires: number } | undefined
let inflight: Promise<CursorSnapshot> | undefined

/** Cached Cursor snapshot; concurrent callers share one read. */
export function getCursor(now = Date.now()): Promise<CursorSnapshot> {
  if (entry && entry.expires > now) return Promise.resolve(entry.value)
  inflight ??= collectCursor(process.env, homedir(), now).then((value) => {
    entry = { value, expires: Date.now() + CACHE_MS }
    return value
  }).catch((): CursorSnapshot => {
    const unavailable = { availability: 'unavailable' as const, data: [], error: { code: 'COMMAND_FAILED' as const, message: 'The Cursor agent definitions could not be read.' } }
    const value: CursorSnapshot = { agents: unavailable, sessions: unavailable, live: 0, fetchedAt: new Date().toISOString() }
    entry = { value, expires: Date.now() + CACHE_MS }
    return value
  }).finally(() => { inflight = undefined })
  return inflight
}

export function clearCursorCache(): void { entry = undefined }
