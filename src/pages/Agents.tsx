import { agentLabel } from '../format.ts'
import type { CursorSession, CursorSnapshot, OfficeSnapshot, RuntimeSnapshot, SubagentSnapshot } from '../types.ts'
import { usePolling } from '../polling.ts'
import { EmptyState, LoadingState, PageTitle, RuntimeBadge } from '../ui.tsx'
import { PixelCharacter } from './Office.tsx'

/** "12s ago", "3m ago", "2h ago": how long ago a subagent's own transcript was written. */
function since(iso?: string): string {
  if (!iso) return 'unknown'
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return 'unknown'
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

/** Cursor's evidence, said the way it is written: a workbench write on its own is not work. */
function evidenceLabel(evidence: CursorSession['evidence']): string {
  const names = evidence.map((item) => item === 'edits' ? 'AI file edits' : item === 'store' ? 'conversation store' : 'workbench state (context only)')
  return names.length > 0 ? names.join(' + ') : 'none yet'
}

/**
 * Every Hermes profile on this machine is an agent, plus OpenCode when it is installed, plus the
 * subagents of a running delegation, plus the Cursor agents the user defined and the projects
 * Cursor's own local records show it working in. All of it is discovered, none of it configured.
 */
export function Agents({ runtime, pending = false }: { runtime: RuntimeSnapshot | null; pending?: boolean }) {
  const office = usePolling<OfficeSnapshot>('/api/office', 15_000)
  const subagents = usePolling<SubagentSnapshot>('/api/subagents', 10_000)
  const cursor = usePolling<CursorSnapshot>('/api/cursor', 15_000)
  if (pending) return <><PageTitle eyebrow="CREW" title="Agents"/><LoadingState message="Reading runtime details..."/></>
  if (!runtime || runtime.profiles.availability === 'unavailable') return <><PageTitle eyebrow="CREW" title="Agents"/><EmptyState title="Not Available">The Hermes profile list could not be read. Is <code>hermes</code> on the PATH of the server?</EmptyState></>
  const states = new Map(office.status === 'ready' ? office.data.stations.map((station) => [station.id, station]) : [])
  const openCode = runtime.openCode.availability === 'available' ? runtime.openCode.data : undefined
  const cards = [
    ...runtime.profiles.data.map((profile) => ({ id: profile.name, kind: 'Hermes profile', model: profile.model, gateway: profile.gateway })),
    ...(openCode ? [{ id: 'opencode', kind: 'OpenCode (CLI tool)', model: openCode, gateway: undefined }] : []),
  ]
  const runs = subagents.status === 'ready' && subagents.data.runs.availability === 'available' ? subagents.data.runs.data : []
  const working = runs.filter((run) => run.live)
  const recent = runs.filter((run) => !run.live).slice(0, 8)
  const subagentCard = (run: SubagentSnapshot['runs']['data'][number]) => <article className="agent-card" key={run.id}>
    <span className="folder-glyph" aria-hidden="true"><PixelCharacter agent={run.id}/></span>
    <div className="agent-card-body">
      <h2>{run.index + 1}/{run.total} · {run.delegation}</h2>
      <p className="muted">Subagent of {agentLabel(run.profile)}</p>
      <dl>
        <div><dt>Model</dt><dd>{run.model ?? 'Inherited from its parent'}</dd></div>
        <div><dt>Status</dt><dd>{run.live ? 'Working' : run.status === 'completed' ? 'Done' : run.status === 'failed' ? 'Failed' : run.status === 'running' ? 'Started, no output in the last 5m' : 'Settled'}</dd></div>
        <div><dt>Doing</dt><dd>{run.label}</dd></div>
        <div><dt>Transcript</dt><dd>Started {since(run.startedAt)} · last output {since(run.lastOutputAt)}</dd></div>
      </dl>
    </div>
  </article>
  const cursorSessions = cursor.status === 'ready' ? cursor.data.sessions.data : []
  const cursorAgents = cursor.status === 'ready' ? cursor.data.agents.data : []
  const cursorLive = cursorSessions.filter((session) => session.live)
  const cursorRecent = cursorSessions.filter((session) => !session.live).slice(0, 6)
  const cursorCard = (session: CursorSession) => <article className="agent-card" key={session.id}>
    <span className="folder-glyph" aria-hidden="true"><PixelCharacter agent={session.id}/></span>
    <div className="agent-card-body">
      <h2>Cursor · {session.project}</h2>
      <p className="muted">Cursor agent session {session.live ? '· working now' : `· last seen ${since(session.lastActivityAt)}`}</p>
      <dl>
        <div><dt>Model</dt><dd>{session.model ?? 'Not recorded locally'}</dd></div>
        <div><dt>Evidence</dt><dd>{evidenceLabel(session.evidence)}</dd></div>
        <div><dt>Work seen</dt><dd>{session.filesTouched} file{session.filesTouched === 1 ? '' : 's'} edited · {session.conversations} conversation{session.conversations === 1 ? '' : 's'}</dd></div>
        <div><dt>Defined here</dt><dd>{session.agents} Cursor agent{session.agents === 1 ? '' : 's'}</dd></div>
        <div><dt>Project</dt><dd>{session.directory}</dd></div>
      </dl>
    </div>
  </article>
  return <><PageTitle eyebrow="CREW" title="Agents">Every Hermes profile on this machine (from <code>hermes profile list</code>) is an agent{openCode ? ', plus OpenCode' : ''}. So is every child of a running delegation, every Cursor agent defined in a project (or in <code>~/.cursor/agents</code>), and every project Cursor's own local records show it working in. They appear here and in the office while they work, and leave when they stop. Nothing is configured by hand.</PageTitle>
    <section className="agent-grid">{cards.map((card) => {
      const station = states.get(card.id)
      return <article className="agent-card" key={card.id}>
        <span className="folder-glyph" aria-hidden="true"><PixelCharacter agent={card.id}/></span>
        <div className="agent-card-body">
          <h2>{station?.privacy === 'locked' ? '🔒 ' : ''}{agentLabel(card.id)}</h2>
          <p className="muted">{card.kind}</p>
          <dl>
            <div><dt>Model</dt><dd>{card.model}</dd></div>
            <div><dt>Gateway</dt><dd>{card.gateway ? <RuntimeBadge source={{ availability: 'available', data: card.gateway }}/> : <span className="muted">None (CLI tool)</span>}</dd></div>
            <div><dt>In the office</dt><dd>{station ? `${station.state}${station.activity ? ` · ${station.activity}` : ''}` : '—'}</dd></div>
          </dl>
        </div>
      </article>
    })}</section>
    <section className="subagents">
      <p className="eyebrow">SUBAGENTS {working.length > 0 && <span className="badge good">{working.length} working</span>}</p>
      <h2>Working right now</h2>
      {subagents.status === 'pending' ? <LoadingState message="Reading delegation transcripts..."/>
        : subagents.status === 'failed' ? <EmptyState title="Not Available">The delegation transcripts could not be read.</EmptyState>
          : working.length === 0 ? <p className="muted">No subagent is working right now. A delegation child is an agent only while its batch runs: it appears in the office, at a desk, as soon as one starts.</p>
            : <div className="agent-grid">{working.map(subagentCard)}</div>}
      {recent.length > 0 && <><h2 className="subagent-recent">Recently finished</h2><div className="agent-grid">{recent.map(subagentCard)}</div></>}
      <small className="muted">Read from the read-only manifest and transcripts Hermes writes per child under the delegation cache. Only the child's goal label, model and timestamps are shown — never the transcript itself. A child with no transcript write for 5 minutes is not shown as working.</small>
    </section>
    <section className="subagents">
      <p className="eyebrow">CURSOR AGENTS {cursorLive.length > 0 && <span className="badge good">{cursorLive.length} working</span>}</p>
      <h2>Projects Cursor is working in</h2>
      {cursor.status === 'pending' ? <LoadingState message="Reading Cursor's own records..."/>
        : cursor.status === 'failed' ? <EmptyState title="Not Available">Cursor's agent definitions and records could not be read.</EmptyState>
          : cursorSessions.length === 0 ? <p className="muted">Cursor has not written anything locally in the last 24 hours. A session appears at a desk while Cursor's own records — an AI file edit, or a write to a conversation store — are less than 10 minutes old.</p>
            : <div className="agent-grid">{cursorLive.length > 0 ? cursorLive.map(cursorCard) : cursorRecent.map(cursorCard)}</div>}
      {cursorLive.length > 0 && cursorRecent.length > 0 && <><h2 className="subagent-recent">Recently seen</h2><div className="agent-grid">{cursorRecent.map(cursorCard)}</div></>}
      <h2 className="subagent-recent">Definitions ({cursorAgents.length})</h2>
      {cursorAgents.length === 0 ? <p className="muted">{cursor.status === 'ready' ? 'No Cursor agent definition was found. Ruang looks for `.cursor/agents/*.md` in each project under the configured roots, and in `~/.cursor/agents`.' : '—'}</p>
        : <div className="agent-grid">{cursorAgents.map((agent) => <article className="agent-card" key={agent.id}>
          <span className="folder-glyph" aria-hidden="true"><PixelCharacter agent={agent.id}/></span>
          <div className="agent-card-body">
            <h2>{agent.name}</h2>
            <p className="muted">{agent.project === 'global' ? 'Global (~/.cursor/agents)' : agent.project}</p>
            <dl>
              <div><dt>Definition</dt><dd>{agent.path}</dd></div>
              {agent.description && <div><dt>Description</dt><dd>{agent.description}</dd></div>}
              <div><dt>Edited</dt><dd>{since(agent.modifiedAt)}</dd></div>
            </dl>
          </div>
        </article>)}</div>}
      <small className="muted">Read only from this machine: the agent definitions the user wrote, and Cursor's code-tracking database (which project, which model, when) plus its per-conversation stores. Only names, counts and timestamps are shown — conversation titles, prompts and file contents are never read. Cursor keeps the name of the agent a session ran on its servers, so a session is named after its project; Ruang does not guess. A workbench state write alone never counts as work, because macOS rewrites it for many projects at once.</small>
    </section>
  </>
}
