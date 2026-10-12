import { getLocale, intlLocale, type MessageKey, type TFunction } from '../../lib/i18n'
import type {
  ActivityKind,
  AgentState,
  BusMessage,
  OrchestraAgent,
} from '../../stores/orchestraStore'
import { ORCHESTRATOR_ID } from '../../stores/orchestraStore'
import { blockReasonKey } from './attention/blocking'
import { isCreativeArea } from './creative/role'
import { isScribeParty } from './scribe/identity'

/** Blocked on a permission, a question or its own report, or failed: the user should look. */
export { needsYou } from './attention/rules'
/** Its process is gone (failed, ended after done, stopped): a transcript, never a live terminal. */
export { processEnded } from '../../stores/orchestraStore'

/** Ended before reporting done: its process exited or was killed, or it never launched. */
export function isFailed(agent: Pick<OrchestraAgent, 'state'>): boolean {
  return agent.state === 'exited'
}

/**
 * The shared label of an agent the user ended: 'stopped' (Stop on the session) or 'cancelled'
 * (Cancel while it waited). Null for any other agent, which each view labels by its state.
 */
export function endedByUserKey(
  agent: Pick<OrchestraAgent, 'state' | 'exitReason'>,
): 'orchestra.state.stopped' | 'orchestra.state.cancelled' | null {
  if (agent.exitReason === 'cancelled') return 'orchestra.state.cancelled'
  if (agent.exitReason === 'stopped' && agent.state === 'idle') return 'orchestra.state.stopped'
  return null
}

type Described = { key: MessageKey; params?: Record<string, string | number> }

/** How a failed agent ended, as an i18n key and its parameters. */
export function exitDescription(agent: Pick<OrchestraAgent, 'exitCode' | 'exitReason'>): Described {
  switch (agent.exitReason) {
    case 'launch-failed':
      return { key: 'orchestra.agents.exit.launchFailed' }
    case 'launch-timeout':
      return { key: 'orchestra.agents.exit.launchTimeout' }
    case 'killed':
      return { key: 'orchestra.agents.exit.killed' }
    case 'suspended':
      return { key: 'orchestra.agents.exit.suspended' }
    case 'restarted':
      return { key: 'orchestra.agents.exit.restarted' }
    case 'stopped':
      return { key: 'orchestra.agents.exit.stopped' }
    case 'cancelled':
      return { key: 'orchestra.state.cancelled' }
    default:
      return typeof agent.exitCode === 'number'
        ? { key: 'orchestra.agents.exit.exited', params: { code: agent.exitCode } }
        : { key: 'orchestra.agents.exit.exitedNoCode' }
  }
}

/** How a failed agent ended, in the user's language. */
export function describeExit(
  t: TFunction,
  agent: Pick<OrchestraAgent, 'exitCode' | 'exitReason'>,
): string {
  const { key, params } = exitDescription(agent)
  return t(key, params)
}

/** What a blocked agent waits on, as an i18n key: the label shown before its question. */
export function blockDescription(agent: Pick<OrchestraAgent, 'blocked'>): Described | null {
  const block = agent.blocked
  if (!block) return null
  switch (block.reason) {
    case 'permission':
      return { key: 'orchestra.agents.blocked.permission' }
    case 'question':
      return { key: 'orchestra.agents.blocked.question' }
    case 'report':
      return { key: 'orchestra.agents.blocked.report' }
    case 'dependency':
      return { key: 'orchestra.agents.blocked.dependency', params: { deps: block.text } }
    case 'usage-limit':
      return block.resetAt
        ? {
            key: 'orchestra.agents.blocked.usageLimitUntil',
            params: {
              time: new Date(block.resetAt).toLocaleTimeString(intlLocale(getLocale()), {
                hour: '2-digit',
                minute: '2-digit',
              }),
            },
          }
        : { key: 'orchestra.agents.blocked.usageLimit' }
    default:
      return { key: blockReasonKey(block.reason) }
  }
}

/** Braille spinner frames used by every view for "agent is working". */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const isOrchestrator = (agent: Pick<OrchestraAgent, 'id'>) => agent.id === ORCHESTRATOR_ID
export const workersOf = (agents: OrchestraAgent[]) => agents.filter((a) => !isOrchestrator(a))

export function isBusy(state: AgentState): boolean {
  return state === 'thinking' || state === 'editing' || state === 'testing' || state === 'starting'
}

/** CSS custom property for an agent state, from theme tokens only. */
export function stateColor(state: AgentState): string {
  switch (state) {
    case 'done':
      return 'var(--status-working)'
    case 'blocked':
      return 'var(--status-waiting)'
    case 'exited':
      return 'var(--status-offline)'
    case 'idle':
    case 'waiting':
      return 'var(--status-stopped)'
    default:
      return 'var(--agent-claude)'
  }
}

export function activityColor(kind: ActivityKind): string {
  switch (kind) {
    case 'reading':
      return 'var(--agent-codex)'
    case 'editing':
      return 'var(--agent-claude)'
    case 'testing':
      return 'var(--status-working)'
    case 'running':
      return 'var(--agent-freebuff)'
    case 'blocked':
      return 'var(--status-waiting)'
    case 'idle':
      return 'var(--status-stopped)'
    default:
      return 'var(--fg-faint)'
  }
}

/**
 * Orchestrator is drawn cyan, workers orange, the user neutral, the Obsidian scribe purple and a
 * worker in the creative area pink. Pass the agent's `area` when it is known (see `areaOf`).
 */
export function agentColor(id: string, area?: string | null): string {
  if (id === ORCHESTRATOR_ID) return 'var(--agent-codex)'
  if (id === 'you') return 'var(--fg)'
  if (isScribeParty(id)) return 'var(--agent-obsidian)'
  if (isCreativeArea(area)) return 'var(--agent-creative)'
  return 'var(--agent-claude)'
}

/** Area of a session agent by id, for coloring bus lines that only carry ids. */
export function areaOf(
  agents: readonly Pick<OrchestraAgent, 'id' | 'area'>[],
  id: string,
): string | undefined {
  return agents.find((a) => a.id === id)?.area
}

/** mm:ss.mmm relative to the session start, like the reference message bus. */
export function busClock(at: number, startedAt: number): string {
  const ms = Math.max(0, at - startedAt)
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

export function elapsed(from: number, to = Date.now()): string {
  const total = Math.max(0, Math.floor((to - from) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function messagesFor(messages: BusMessage[], agentId: string | null): BusMessage[] {
  if (!agentId) return messages
  return messages.filter((m) => m.from === agentId || m.to === agentId || m.to === 'all')
}

export function overallProgress(agents: OrchestraAgent[]): number {
  const workers = workersOf(agents)
  if (workers.length === 0) return 0
  return Math.round(workers.reduce((sum, a) => sum + a.progress, 0) / workers.length)
}
