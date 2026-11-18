export type Availability = 'available' | 'unavailable'
export type GatewayState = 'Running' | 'Stopped' | 'Unknown'
export interface Source<T> { availability: Availability; data: T; error?: { code: string; message: string } }
export interface RuntimeSnapshot {
  /** Every Hermes profile is an agent; `gateway` comes from `hermes profile list`. */
  profiles: Source<{ name: string; model: string; gateway: GatewayState }[]>
  openCode: Source<string>
  fetchedAt: string
}
export interface Task { title: string; status: string; id?: string; assignee?: string; priority?: number; board?: string; private?: boolean }
export interface KanbanBoard { slug: string; name: string; current: boolean; total: number }
/** `agent` is the Hermes profile the job belongs to (cron jobs are stored per profile). */
export interface ScheduledJob { private?: boolean; name: string; schedule: string; id?: string; nextRun?: string; overdue?: boolean; status?: string; repeat?: string; lastRun?: string; lastRunOk?: boolean; agent?: string }
export interface Session { title: string; preview: string; lastActive: string; id?: string; workspace?: string; source?: string; actor?: string; active?: boolean }
export interface Skill { name: string; category: string; source: string; trust: string; status: 'enabled' }
export interface TaskBoardSnapshot { tasks: Source<Task[]>; boards?: KanbanBoard[]; failedBoards?: string[]; fetchedAt: string }
/** `failedProfiles` lists profiles whose cron list could not be read while others could. */
export interface CalendarSnapshot { jobs: Source<ScheduledJob[]>; failedProfiles?: string[]; fetchedAt: string }
export interface ActivitySnapshot { sessions: Source<Session[]>; fetchedAt: string }
export interface KnowledgeSnapshot { skills: Source<Skill[]>; fetchedAt: string }
export interface Channel { name: string; status: 'Configured' | 'Connected' }
export interface ChannelSnapshot { channels: Source<Channel[]>; activeSessions?: number; fetchedAt: string }
export type OfficeState = 'Idle' | 'Working' | 'Reviewing' | 'Collaborating' | 'Offline' | 'Unknown'
export type OfficeRoom = 'Workspace' | 'Lounge'
/** A delegation child: an agent that exists only while its batch runs (read from the live transcript manifest). */
export interface SubagentRun {
  id: string
  delegation: string
  /** The delegation id without its `deleg_` prefix. */
  short: string
  index: number
  total: number
  label: string
  goal: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  /** True only while it is running and its transcript was written recently. */
  live: boolean
  /** The Hermes profile whose delegation this child belongs to. */
  profile: string
  model?: string
  startedAt?: string
  lastOutputAt?: string
}
export interface SubagentSnapshot { runs: Source<SubagentRun[]>; live: number; fetchedAt: string }
/** One Cursor agent definition: a markdown file the user wrote, with a name in its frontmatter. */
export interface CursorAgentDefinition {
  id: string
  name: string
  /** The project folder it belongs to, or `global` for `~/.cursor/agents`. */
  project: string
  directory: string
  path: string
  description?: string
  modifiedAt?: string
}
/** One project Cursor is working in, from Cursor's own local records. */
export interface CursorSession {
  id: string
  project: string
  directory: string
  model?: string
  conversations: number
  filesTouched: number
  lastActivityAt: string
  live: boolean
  /** Which local evidence the session rests on; the workbench write alone is never proof of work. */
  evidence: ('edits' | 'store' | 'workbench')[]
  /** How many Cursor agent definitions this project holds. */
  agents: number
}
export interface CursorSnapshot { agents: Source<CursorAgentDefinition[]>; sessions: Source<CursorSession[]>; live: number; fetchedAt: string }
/** What a subagent station carries about its own child. */
export interface SubagentFacts { delegation: string; index: number; total: number; label: string; goal: string; model?: string; status: SubagentRun['status']; startedAt?: string; lastOutputAt?: string }
export interface OfficeStation {
  /** Agent id: the Hermes profile name, `opencode`, or `sub:<delegation>#<index>` for a delegation child. */
  id: string
  /** Set on agents that are not plain Hermes profiles: OpenCode, delegation children, Cursor sessions. */
  kind?: 'opencode' | 'subagent' | 'cursor'
  /** Subagent stations only: the Hermes profile whose delegation this child belongs to. */
  parent?: string
  /** Subagent stations only: the child's own facts (there is no profile folder or memory behind it). */
  subagent?: SubagentFacts
  /** Cursor stations only: the project session Cursor's own local records show it working in. */
  cursor?: CursorSession
  /** Profile lock: `locked` withholds its private data in this browser, `unlocked` is opened with the PIN. */
  privacy?: 'locked' | 'unlocked'
  name: string
  role: string
  room: OfficeRoom
  roomPosition: string
  state: OfficeState
  currentTask: string
  recentActivity: string
  activity: string
  seat: number
  provenance: string
  freshness: string
}
export interface OfficeSummary { declared: number; active: number; idle: number; offline: number; unknown: number; /** Delegation children working right now; present only while there are any. */ subagents?: number; /** Cursor sessions working right now; present only while there are any. */ cursor?: number; gatewaysReachable: number; gatewaysDeclared: number }
export interface OfficeSnapshot { stations: OfficeStation[]; summary: OfficeSummary; fetchedAt: string }
export interface UsageInsights {
  days: number
  sessions: number
  messages: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost?: string
  costUsd?: number
  models: { model: string; sessions: number; tokens: number }[]
  tools: { tool: string; calls: number }[]
  sources: { source: string; sessions: number; tokens: number }[]
  topSession?: { tokens: number; date: string }
}
export interface AgentUsage { agent: string; availability: Availability; usage?: UsageInsights; error?: string }
export interface UsageSnapshot {
  days: number
  agents: AgentUsage[]
  totals: { sessions: number; messages: number; toolCalls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number }
  models: { model: string; sessions: number; tokens: number }[]
  sources: { source: string; sessions: number; tokens: number }[]
  tools: { tool: string; calls: number }[]
  fetchedAt: string
}
export interface CountSource { availability: Availability; total: number }
export interface CommandHealth { total: number; failed: number; averageMs: number }
export interface DashboardSnapshot {
  runtime: RuntimeSnapshot
  tasks: CountSource & { byStatus: Record<string, number>; assigned: number }
  calendar: CountSource & { active: number; paused: number; nextRun?: string }
  activity: CountSource & { latest?: Session }
  knowledge: CountSource & { byCategory: Record<string, number> }
  channels: CountSource & { connected: number; activeSessions?: number }
  office: OfficeSummary
  commands: CommandHealth
  fetchedAt: string
}
export interface CommandLogEntry { command: string; ok: boolean; durationMs: number; at: string; error?: string }
export interface CommandLogSnapshot { entries: CommandLogEntry[]; health: CommandHealth; fetchedAt: string }
export type LogLevel = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' | 'OTHER'
export interface LogLine { text: string; level: LogLevel }
export interface LogFile { name: string; label: string; source: Source<LogLine[]> }
export interface LogsSnapshot { files: LogFile[]; fetchedAt: string }
export interface FolderAgent { profile: string; label: string; available: boolean; path: string; reason?: string; warning?: string }
export interface FolderAgentsSnapshot { agents: FolderAgent[]; fetchedAt: string }
export interface FolderEntry { name: string; path: string; type: 'dir' | 'file'; size: number; modified: string; sensitive: boolean; unreadable?: boolean }
export interface FolderListing { profile: string; path: string; entries: FolderEntry[]; truncated: boolean; hiddenCount: number }
export interface FolderFile { profile: string; path: string; size: number; modified: string; kind: 'text' | 'binary' | 'sensitive' | 'too-large'; content?: string; truncated?: boolean; redactions?: number }
export interface TaskDetail {
  id: string
  title: string
  status: string
  assignee?: string
  priority?: number
  tenant?: string
  workspace?: string
  branch?: string
  skills: string[]
  model?: string
  createdAt?: string
  createdBy?: string
  startedAt?: string
  completedAt?: string
  body?: string
  result?: string
  lastError?: string
  parents: string[]
  children: string[]
  comments: { author: string; body: string; createdAt?: string }[]
  events: { kind: string; detail?: string; createdAt?: string; runId?: string }[]
  runs: { id: string; profile?: string; status?: string; outcome?: string; summary?: string; error?: string; startedAt?: string; endedAt?: string }[]
}
export interface TaskDetailSnapshot { task: Source<TaskDetail | null>; fetchedAt: string }
export interface MemoryDocument { name: string; path: string; exists: boolean; size?: number; modified?: string; chars?: number; content?: string; truncated?: boolean; redactions?: number; error?: string }
export interface MemoryStore extends MemoryDocument { entries: string[]; limit: number; used: number; percent: number }
export interface MemorySettings { memoryEnabled: boolean; userProfileEnabled: boolean; writeApproval: boolean; provider?: string; memoryLimit: number; userLimit: number; source: 'config.yaml' | 'defaults' }
export interface AgentMemory { profile: string; label: string; path: string; kind: 'hermes' | 'opencode'; available: boolean; reason?: string; soul?: MemoryDocument; memory?: MemoryStore; user?: MemoryStore; contextFiles: MemoryDocument[]; settings?: MemorySettings; locked?: boolean }
export interface MemorySnapshot { agents: AgentMemory[]; fetchedAt: string }
