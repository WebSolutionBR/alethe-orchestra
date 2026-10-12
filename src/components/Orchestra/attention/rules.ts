/**
 * What deserves the user's attention in the running orchestrations. Pure: the service turns these
 * events into notices; the sidebar badge counts `needsYou`. Only types come from the store, which
 * installs the service, so nothing here imports its values.
 */
import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import type { AgentState, OrchestraAgent, OrchestraSession } from '../../../stores/orchestraStore'
import { SCREEN_REASONS } from './blocking'

/** Same as the store's `ORCHESTRATOR_ID` (kept local: the store imports this module). */
export const ORCHESTRATOR = 'orchestrator'

/**
 * Blocks that wait on the user; `dependency` waits on another agent instead. Stuck screens and
 * refused accounts (see blocking.ts) only the user can clear too.
 */
const ASKS = new Set<string>(['permission', 'question', 'report', ...SCREEN_REASONS])

export type AttentionKind = 'blocked' | 'failed' | 'allDone' | 'waiting'

export type AttentionEvent = {
  kind: AttentionKind
  sessionId: string
  /** Null for a whole-session event (all done). */
  agentId: string | null
  /** The question, the exit summary or the orchestrator's last answer; '' when unknown. */
  text: string
  /** Identifies this occurrence, so the same one is never announced twice. */
  key: string
  at: number
}

type Agent = Pick<OrchestraAgent, 'id' | 'state' | 'note' | 'finishedAt'> &
  Partial<Pick<OrchestraAgent, 'blocked' | 'exitCode' | 'exitReason'>>

export function isBusyState(state: AgentState): boolean {
  return state === 'thinking' || state === 'editing' || state === 'testing' || state === 'starting'
}

/** An agent waiting on the user: asking for a permission or an answer, or gone without done. */
export function needsYou(agent: Agent): boolean {
  if (agent.state === 'exited') return true
  return agent.state === 'blocked' && Boolean(agent.blocked && ASKS.has(agent.blocked.reason))
}

const workersOf = <T extends { id: string }>(agents: T[]) =>
  agents.filter((a) => a.id !== ORCHESTRATOR)

function allDone(agents: Agent[]): boolean {
  const workers = workersOf(agents)
  return workers.length > 0 && workers.every((w) => w.state === 'done')
}

/**
 * Attention events between two snapshots of the sessions: an agent that starts waiting on the
 * user (a new question each time `blocked.at` changes), one that ends without done, and a session
 * whose workers all just finished. A session seen for the first time only sets the baseline.
 */
export function attentionEvents(
  prev: Record<string, Pick<OrchestraSession, 'agents' | 'stoppedAt'>>,
  next: Record<string, Pick<OrchestraSession, 'agents' | 'stoppedAt'>>,
  at: number,
): AttentionEvent[] {
  const events: AttentionEvent[] = []
  for (const [sessionId, session] of Object.entries(next)) {
    const before = prev[sessionId]
    // A stopped session only stays on screen to be read; it has nothing left to announce.
    if (!before || session.stoppedAt) continue
    const old = new Map(before.agents.map((a) => [a.id, a]))
    for (const agent of session.agents as Agent[]) {
      const was = old.get(agent.id) as Agent | undefined
      const block = agent.state === 'blocked' ? agent.blocked : null
      if (block && ASKS.has(block.reason)) {
        const fresh = !was || was.state !== 'blocked' || was.blocked?.at !== block.at
        if (fresh) {
          events.push({
            kind: 'blocked',
            sessionId,
            agentId: agent.id,
            text: block.text.trim(),
            key: `${sessionId}:${agent.id}:blocked:${block.at}`,
            at,
          })
        }
      }
      if (agent.state === 'exited' && was?.state !== 'exited') {
        events.push({
          kind: 'failed',
          sessionId,
          agentId: agent.id,
          text: agent.note.trim(),
          key: `${sessionId}:${agent.id}:failed:${agent.finishedAt ?? at}`,
          at,
        })
      }
    }
    if (allDone(session.agents as Agent[]) && !allDone(before.agents as Agent[])) {
      events.push({
        kind: 'allDone',
        sessionId,
        agentId: null,
        text: '',
        key: `${sessionId}:allDone:${workersOf(session.agents).length}`,
        at,
      })
    }
  }
  return events
}

/**
 * The orchestrator reading as "waiting for you": Claude Code's idle notice while no worker is
 * still busy. With busy workers the orchestrator is only waiting on them.
 */
export function isOrchestratorIdleNotice(
  event: OrchestraEvent,
  agents: Pick<OrchestraAgent, 'id' | 'state'>[],
): boolean {
  if (event.kind !== 'hook' || event.agent_id !== ORCHESTRATOR) return false
  if (event.hook.hook_event_name !== 'Notification') return false
  if (event.hook.notification_type !== 'idle_prompt') return false
  return !workersOf(agents).some((w) => isBusyState(w.state))
}

/** The orchestrator acting again (a prompt or a tool call), which ends its wait. */
export function isOrchestratorActive(event: OrchestraEvent): boolean {
  if (event.kind !== 'hook' || event.agent_id !== ORCHESTRATOR) return false
  const name = event.hook.hook_event_name
  return name === 'UserPromptSubmit' || name === 'PreToolUse'
}
