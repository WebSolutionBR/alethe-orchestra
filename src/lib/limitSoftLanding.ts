import { sessionLaunchOf } from '../components/Orchestra/usage/launchDefaults'
import { DEFAULT_ACCOUNT_KEY, useUsageStore } from '../components/Orchestra/usage/usageStore'
import { type OrchestraSession, ORCHESTRATOR_ID, useOrchestraStore } from '../stores/orchestraStore'
import type { ClaudeUsage } from './tauri'

/**
 * Soft landing before the usage limit: a session whose account crosses this share of the
 * five-hour window tells its agents once, so they stop at a compiling checkpoint instead of
 * dying mid-edit when the limit hits (12/10/2026: five workers stopped at once).
 */
export const SOFT_LANDING_PCT = 90

export const SOFT_LANDING_WORKER_TEXT =
  "This session's account is at 90% of its 5-hour usage limit. Finish the edit " +
  'in progress, leave the code compiling, record your state with orch report and do not ' +
  'start anything new.'

export const SOFT_LANDING_ORCHESTRATOR_TEXT =
  "This session's account is at 90% of its 5-hour usage limit. Record the map of " +
  'who owns what now, so the work can resume after the reset.'

/**
 * Delivers one line to an agent's terminal; in the app, the store's `tellAgent`, which adds
 * the [orchestra] prefix.
 */
export type SoftLandingNotify = (sessionId: string, agentId: string, text: string) => unknown

/** Windows already announced, by session: the `resets_at` of the five-hour window warned about. */
const warned = new Map<string, string>()

/** Agents that still read their terminal: not gone and not finished. */
function listeners(session: OrchestraSession): string[] {
  return session.agents
    .filter((a) => a.state !== 'exited' && a.state !== 'done' && a.exitCode == null)
    .map((a) => a.id)
}

/**
 * True when `usage` is at the soft-landing mark and this window was not announced yet for the
 * session. Marks the window as announced.
 */
export function softLandingDue(sessionId: string, usage: ClaudeUsage | null): boolean {
  const window = usage?.five_hour
  if (!window || (window.utilization ?? 0) < SOFT_LANDING_PCT) return false
  // Already at the limit: the limit strip takes over, a warning would only spend quota.
  if (window.utilization >= 100) return false
  const key = window.resets_at ?? ''
  if (warned.get(sessionId) === key) return false
  warned.set(sessionId, key)
  return true
}

/**
 * Checks every running session against its account's last usage reading and warns the ones
 * that crossed the mark. Cheap: reads the stores only, so it can run on every usage refresh.
 */
export function checkSoftLanding(notify: SoftLandingNotify): void {
  const rows = useUsageStore.getState().rows
  const { sessions } = useOrchestraStore.getState()
  for (const session of Object.values(sessions)) {
    if (session.stoppedAt) continue
    const account = sessionLaunchOf(session).account ?? DEFAULT_ACCOUNT_KEY
    const row = rows.find((r) => r.id === account)
    if (!softLandingDue(session.id, row?.usage ?? null)) continue
    for (const agentId of listeners(session)) {
      const text =
        agentId === ORCHESTRATOR_ID ? SOFT_LANDING_ORCHESTRATOR_TEXT : SOFT_LANDING_WORKER_TEXT
      try {
        void Promise.resolve(notify(session.id, agentId, text)).catch(() => {})
      } catch {
        // A failed notice must never break the usage refresh that runs this check.
      }
    }
  }
}

/** Forgets the announced windows; for tests. */
export function resetSoftLanding(): void {
  warned.clear()
}
