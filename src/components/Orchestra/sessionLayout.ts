/** Pure helpers of the session tab strip and the side-by-side view. */
import { type OrchestraSession, ORCHESTRATOR_ID } from '../../stores/orchestraStore'
import { isFailed, overallProgress, workersOf } from './shared'

export type SessionStatus = 'working' | 'blocked' | 'done' | 'error' | 'stopped'

/** What a tab shows about its session; flat, so a `useShallow` selector stays cheap. */
export type TabSummary = {
  projectId: string | null
  cwd: string | null
  goal: string
  status: SessionStatus
  overall: number
  blocked: number
  failed: number
  /** The orchestrator itself is gone (or never launched). */
  orchestratorDown: boolean
}

const EMPTY_SUMMARY: TabSummary = {
  projectId: null,
  cwd: null,
  goal: '',
  status: 'working',
  overall: 0,
  blocked: 0,
  failed: 0,
  orchestratorDown: false,
}

/**
 * Stopped first (read-only), then an error (the orchestrator went down, a launch failed, or every
 * worker ended with some failing), then a blocked worker, then done (every worker reported done),
 * else working. A failed worker is never counted as done.
 */
export function tabSummary(session: OrchestraSession | undefined): TabSummary {
  if (!session) return EMPTY_SUMMARY
  const workers = workersOf(session.agents)
  const blocked = workers.filter((w) => w.state === 'blocked').length
  const failed = workers.filter(isFailed).length
  const orchestrator = session.agents.find((a) => a.id === ORCHESTRATOR_ID)
  const orchestratorDown = Boolean(orchestrator && isFailed(orchestrator))
  const ended = workers.length > 0 && workers.every((w) => w.state === 'done' || isFailed(w))
  // A stopped session is read-only history: it reads as stopped, whatever was left open.
  const status: SessionStatus = session.stoppedAt
    ? 'stopped'
    : orchestratorDown || session.error || (ended && failed > 0)
      ? 'error'
      : blocked > 0
        ? 'blocked'
        : ended
          ? 'done'
          : 'working'
  return {
    projectId: session.projectId,
    cwd: session.cwd,
    goal: session.goal,
    status,
    overall: overallProgress(session.agents),
    blocked,
    failed,
    orchestratorDown,
  }
}

/** Last folder of a path: the name of a session that has no project. */
export function folderName(path: string | null): string {
  if (!path) return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The tab `step` places away from `current`, wrapping around; from none, the first or last. */
export function cycleId(order: string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null
  const index = current ? order.indexOf(current) : -1
  if (index === -1) return step > 0 ? order[0] : order[order.length - 1]
  return order[(index + step + order.length) % order.length]
}

type KeyChord = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/**
 * Alt+PageUp / Alt+PageDown cycle the tabs. Ctrl+PageUp/PageDown and Ctrl+Tab already cycle
 * workspace panes and tabs, and Ctrl+Alt is AltGr on many layouts, so neither is used here.
 */
export function tabCycleStep(e: KeyChord): 1 | -1 | 0 {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0
  return e.key === 'PageDown' ? 1 : e.key === 'PageUp' ? -1 : 0
}

/**
 * Status each session had when it was last on screen. Module state on purpose: it outlives the
 * view, so a session that got blocked or finished while the user was elsewhere still shows it.
 */
const seenStatus = new Map<string, SessionStatus>()

export function markSeen(id: string, status: SessionStatus): void {
  seenStatus.set(id, status)
}

/** Drops sessions that no longer exist. */
export function forgetUnseen(alive: readonly string[]): void {
  for (const id of seenStatus.keys()) if (!alive.includes(id)) seenStatus.delete(id)
}

/** An off-screen session that got blocked or finished since the user last saw it. */
export function needsAttention(id: string, status: SessionStatus, onScreen: boolean): boolean {
  // Stopping is the user's own act: it never calls for attention.
  return !onScreen && status !== 'working' && status !== 'stopped' && seenStatus.get(id) !== status
}

export const tabElementId = (sessionId: string) => `orchestra-tab-${sessionId}`
export const paneElementId = (sessionId: string) => `orchestra-pane-${sessionId}`

/* ---------------------------------------------------------------- side-by-side split */

const SPLIT_KEY = 'orchestra.splitRatio'
export const SPLIT_DEFAULT = 0.5
/** Narrowest side-by-side pane, in px: its fully degraded top bar (about 370px) still fits. */
export const PANE_MIN = 400

/** Share of the left pane that leaves both panes `min` px of a `width` px view (50/50 if too narrow). */
export function clampSplitRatio(ratio: number, width: number | null, min = PANE_MIN): number {
  const value = Number.isFinite(ratio) ? ratio : SPLIT_DEFAULT
  const edge = width && width > 0 ? Math.min(0.5, min / width) : 0.2
  return Math.min(1 - edge, Math.max(edge, value))
}

export function readSplitRatio(): number {
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY))
    return saved > 0 && saved < 1 ? saved : SPLIT_DEFAULT
  } catch {
    return SPLIT_DEFAULT
  }
}

export function writeSplitRatio(ratio: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, ratio.toFixed(3))
  } catch {
    // The remembered ratio is a convenience only.
  }
}
