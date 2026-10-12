/**
 * Watches the usage windows of Claude and Codex and tells the user when one resets (a
 * notification, if the preference is on). It also runs the Orchestra's "wait for the reset"
 * (see `continueAfterLimitReset`): one heartbeat per minute checks both, so a PC that slept
 * catches up when it wakes.
 */
import { readAutoWaitOnLimit } from '../components/Orchestra/accounts/limitPrefs'
import { limitResetAt, MAX_LIMIT_REARMS } from '../components/Orchestra/accounts/model'
import { sessionLaunchOf } from '../components/Orchestra/usage/launchDefaults'
import { DEFAULT_ACCOUNT_KEY, useUsageStore } from '../components/Orchestra/usage/usageStore'
import {
  accountLabel,
  type LimitWait,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
  useOrchestraStore,
} from '../stores/orchestraStore'
import { useProjectsStore } from '../stores/projectsStore'
import { getLocale, translate } from './i18n'
import { checkSoftLanding } from './limitSoftLanding'
import { notifyLimitReset } from './notifications'
import type { ClaudeUsage, CodexUsage } from './tauri'
import type { AgentType } from './types'

type WindowKind = '5h' | 'week' | 'opus'
type Entry = { resetsAt: number; notified: boolean; agent: AgentType; kind: WindowKind }

const entries = new Map<string, Entry>()
const HEARTBEAT_MS = 60_000
// A new reset time this close to the old one means the window rolled over: the old
// one is notified before it is replaced. Further away it is a different window (the
// usage API moved it), and it is just replaced.
const RESET_ROLLOVER_GRACE_MS = 5 * 60_000
let heartbeat: number | null = null

function agentLabel(agent: AgentType): string {
  return agent === 'codex' ? 'Codex' : 'Claude'
}

function windowLabel(kind: WindowKind): string {
  if (kind === 'week') return translate(getLocale(), 'widget.week')
  return kind // '5h' | 'opus'
}

function fire(entry: Entry): void {
  if (!useProjectsStore.getState().preferences.notifyOnLimitReset) return
  const locale = getLocale()
  void notifyLimitReset(
    translate(locale, 'notif.limitResetTitle'),
    translate(locale, 'notif.limitResetBody', {
      agent: agentLabel(entry.agent),
      window: windowLabel(entry.kind),
    }),
    entry.agent,
  )
}

function ensureHeartbeat(): void {
  if (heartbeat !== null) return
  heartbeat = window.setInterval(() => {
    const now = Date.now()
    for (const entry of entries.values()) {
      if (!entry.notified && now >= entry.resetsAt) {
        fire(entry)
        entry.notified = true
      }
    }
    checkLimitWaits(now)
    checkSoftLanding((sessionId, agentId, text) =>
      useOrchestraStore.getState().tellAgent(sessionId, agentId, text),
    )
  }, HEARTBEAT_MS)
}

function observe(key: string, agent: AgentType, kind: WindowKind, resetsAt: number): void {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return
  ensureHeartbeat()
  const prev = entries.get(key)
  if (!prev) {
    // First reading of this window: nothing to notify yet.
    entries.set(key, { resetsAt, notified: false, agent, kind })
    return
  }
  if (resetsAt > prev.resetsAt) {
    // The window rolled over before the heartbeat saw it reset: notify the one that
    // ended now, unless it is far in the future (stale data replaced by fresh data).
    if (prev.resetsAt <= Date.now() + RESET_ROLLOVER_GRACE_MS && !prev.notified) {
      fire(prev)
    }
    entries.set(key, { resetsAt, notified: false, agent, kind })
  }
  // Same reset time: nothing changed.
  // resetsAt < prev.resetsAt: dado mais velho (cache), ignora.
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

export function observeClaudeReset(usage: ClaudeUsage): void {
  observe('claude:5h', 'claude', '5h', parseIso(usage.five_hour.resets_at))
  observe('claude:week', 'claude', 'week', parseIso(usage.seven_day.resets_at))
  observe('claude:opus', 'claude', 'opus', parseIso(usage.seven_day_opus.resets_at))
}

export function observeCodexReset(usage: CodexUsage): void {
  observe('codex:5h', 'codex', '5h', usage.primary.resets_at_ms)
  observe('codex:week', 'codex', 'week', usage.secondary.resets_at_ms)
}

/** Block reason the screen classifier gives an agent stopped by Claude Code's usage limit. */
export const USAGE_LIMIT_REASON = 'usage-limit'
/** Waits this long past the reset time: the usage API and the CLI roll over a little late. */
export const LIMIT_RESUME_GRACE_MS = 60_000
/** What the owner's "Wait" sends to each agent stopped by the limit. */
export const LIMIT_RESUME_TEXT = 'continue'

export type { LimitWait }

/** Workers resume one after the other, this far apart, after the orchestrator. */
export const LIMIT_RESUME_STAGGER_MS = 20_000

function resetTime(resetsAt: string | number): number {
  return typeof resetsAt === 'number' ? resetsAt : parseIso(resetsAt)
}

function isLimitBlocked(agent: OrchestraAgent, account: string | null): boolean {
  return (
    agent.state === 'blocked' &&
    (agent.blocked?.reason as string | undefined) === USAGE_LIMIT_REASON &&
    (agent.launchedWith?.account ?? null) === account
  )
}

/**
 * Agents of the session still stopped by the usage limit on `account` (null = the default
 * account), in the order they resume: the orchestrator first, then the workers that were
 * closest to done (last `orch report`). An agent restarted elsewhere or moving again is left
 * alone.
 */
export function limitBlockedAgents(sessionId: string, account: string | null): string[] {
  const session = useOrchestraStore.getState().sessions[sessionId]
  if (!session) return []
  return session.agents
    .filter((agent) => isLimitBlocked(agent, account))
    .sort(
      (a, b) =>
        Number(b.id === ORCHESTRATOR_ID) - Number(a.id === ORCHESTRATOR_ID) ||
        (b.progress ?? 0) - (a.progress ?? 0),
    )
    .map((agent) => agent.id)
}

/** HH:MM in the local clock, for the notice to the orchestrator. */
function clock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The accounts panel's "Wait" button (or the automatic wait, see `autoArmLimitWaits`): once the
 * session account's limit window resets, every agent of the session still stopped by that limit
 * is moved on again (see `checkLimitWaits`). Checked on the same one-minute heartbeat as the
 * reset notices, so a sleeping PC catches up when it wakes. The wait lives in the session
 * (`limitWait`), so a reload or a Resume keeps it; a new wait replaces the previous one, and the
 * orchestrator is told not to replan. Returns a cancel function.
 */
export function continueAfterLimitReset(options: {
  sessionId: string
  account: string | null
  /** `resets_at` of the five-hour window (ISO) or epoch ms. */
  resetsAt: string | number
  /** Armed by itself (`autoArmLimitWaits`), not by the owner. */
  auto?: boolean
}): () => void {
  const resetsAt = resetTime(options.resetsAt)
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return () => {}
  const { sessionId, account } = options
  const store = useOrchestraStore.getState()
  const before = limitWaitOf(sessionId)
  store.setLimitWait(sessionId, { account, resetsAt, ...(options.auto ? { auto: true } : {}) })
  ensureHeartbeat()
  if (before?.account !== account || before?.resetsAt !== resetsAt) {
    const name = accountLabel(account) ?? 'default'
    store.tellAgent(
      sessionId,
      ORCHESTRATOR_ID,
      `account ${name} hit its usage limit; the workers resume on their own at ` +
        `${clock(resetsAt + LIMIT_RESUME_GRACE_MS)}. Do not replan or spawn replacements.`,
    )
  }
  return () => {
    const wait = limitWaitOf(sessionId)
    if (wait?.account === account && wait.resetsAt === resetsAt) cancelLimitWait(sessionId)
  }
}

/** The pending wait of a session, for the "waiting until HH:MM" banner. */
export function limitWaitOf(sessionId: string): LimitWait | null {
  return useOrchestraStore.getState().sessions[sessionId]?.limitWait ?? null
}

/** Drops the session's wait, e.g. when the owner switches the session account instead. */
export function cancelLimitWait(sessionId: string): void {
  useOrchestraStore.getState().setLimitWait(sessionId, null)
}

/**
 * Moves an agent stopped by the limit on again: Esc closes the CLI's limit menu ("Esc to
 * cancel"; Enter could pick "extra usage" if the cursor moved), the screen block is cleared so
 * the message is not held, and "continue" goes in. If the limit still holds, the CLI shows it
 * again and the screen watcher blocks the agent anew.
 */
async function resumeAgent(sessionId: string, agentId: string, account: string | null) {
  const store = useOrchestraStore.getState()
  const agent = store.sessions[sessionId]?.agents.find((a) => a.id === agentId)
  // It got going (or was restarted elsewhere) while the ones before it resumed.
  if (!agent || !isLimitBlocked(agent, account)) return
  await store.interruptAgent(sessionId, agentId).catch(() => {})
  store.screenBlock(sessionId, agentId, null)
  await store.sendTo(sessionId, agentId, LIMIT_RESUME_TEXT).catch(() => {})
}

/** An agent stopped by the limit again this soon after its resume re-arms the wait... */
export const LIMIT_REBLOCK_WINDOW_MS = 10 * 60_000
/** ...for this long from then... */
export const LIMIT_REARM_DELAY_MS = 5 * 60_000
/** ...at most this many times; then the owner decides (switch the account or Wait again). */
export const LIMIT_MAX_REARMS = MAX_LIMIT_REARMS

/** Sessions whose staggered resume is running now: the heartbeat does not schedule it twice. */
const resuming = new Set<string>()

/** One at a time: a whole team waking at once would hit the fresh window together. */
function resumeInTurn(sessionId: string, agentIds: string[], account: string | null): void {
  resuming.add(sessionId)
  const steps = agentIds.map(
    (agentId, index) =>
      new Promise<void>((done) => {
        const run = () => void resumeAgent(sessionId, agentId, account).finally(done)
        if (index === 0) run()
        else window.setTimeout(run, index * LIMIT_RESUME_STAGGER_MS)
      }),
  )
  void Promise.all(steps).finally(() => resuming.delete(sessionId))
}

/**
 * Runs due waits; exported for tests (the heartbeat calls it every minute). A due wait stays in
 * the session until no agent is stopped by the limit any more, so a reload in the middle of the
 * staggered resume still resumes the rest. An agent stopped by the limit again within 10 min of
 * the resume re-arms the wait for 5 min from now, at most 3 times.
 */
export function checkLimitWaits(now = Date.now()): void {
  const { sessions } = useOrchestraStore.getState()
  for (const [sessionId, session] of Object.entries(sessions)) {
    const wait = session.limitWait
    if (!wait || now < wait.resetsAt + LIMIT_RESUME_GRACE_MS) continue
    if (resuming.has(sessionId)) continue
    const blocked = limitBlockedAgents(sessionId, wait.account)
    if (!blocked.length) {
      cancelLimitWait(sessionId)
      continue
    }
    const since = wait.resumedAt
    const blockedAt = (id: string) =>
      session.agents.find((agent) => agent.id === id)?.blocked?.at ?? 0
    // Still on the block from before the resume (a reload stopped the turn before theirs).
    const pending = since === undefined ? blocked : blocked.filter((id) => blockedAt(id) < since)
    const again = since === undefined ? [] : blocked.filter((id) => blockedAt(id) >= since)
    if (again.length && since !== undefined && now - since <= LIMIT_REBLOCK_WINDOW_MS) {
      const store = useOrchestraStore.getState()
      const rearms = (wait.rearms ?? 0) + 1
      if (rearms > LIMIT_MAX_REARMS) {
        cancelLimitWait(sessionId)
        store.tellAgent(
          sessionId,
          ORCHESTRATOR_ID,
          `the usage limit came back ${LIMIT_MAX_REARMS} times right after the reset; ` +
            'the owner was asked to switch the account or wait again. Do not replan yet.',
        )
        continue
      }
      const resetsAt = now + LIMIT_REARM_DELAY_MS
      store.setLimitWait(sessionId, {
        account: wait.account,
        resetsAt,
        ...(wait.auto ? { auto: true } : {}),
        rearms,
      })
      store.tellAgent(
        sessionId,
        ORCHESTRATOR_ID,
        `the usage limit came back after the reset; trying again at ` +
          `${clock(resetsAt + LIMIT_RESUME_GRACE_MS)} (${rearms} of ${LIMIT_MAX_REARMS}). ` +
          'Do not replan or spawn replacements.',
      )
      continue
    }
    if (!pending.length) {
      // Limited again long after the resume: a new limit, armed afresh (or by the owner).
      cancelLimitWait(sessionId)
      continue
    }
    if (since === undefined) {
      useOrchestraStore.getState().setLimitWait(sessionId, { ...wait, resumedAt: now })
    }
    resumeInTurn(sessionId, pending, wait.account)
  }
}

/** Test hook: a reload forgets the resume in progress (its timers die with the page). */
export function forgetResumeInProgress(): void {
  resuming.clear()
}

/** The reset time each session's automatic wait was last armed for. */
const autoArmed = new Map<string, number>()

/**
 * With the "wait for the reset and continue" preference on, the first agent of a session
 * stopped by the usage limit on the session account arms the wait by itself, with the reset
 * time its screen showed. Once per reset time: a wait the owner cancels is not armed again
 * until a new limit window. Exported for tests (a store subscription runs it).
 */
export function autoArmLimitWaits(now = Date.now()): void {
  const { sessions } = useOrchestraStore.getState()
  const { rows } = useUsageStore.getState()
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.stoppedAt || session.limitWait) continue
    const launch = sessionLaunchOf(session)
    const blocked = session.agents.filter((agent) => isLimitBlocked(agent, launch.account))
    if (!blocked.length) continue
    // The same reset the limit strip shows: the usage cache first, then the screens.
    const row = rows.find((r) => r.id === (launch.account ?? DEFAULT_ACCOUNT_KEY))
    const resetAt = limitResetAt(
      row?.usage,
      blocked.map((agent) => agent.blocked?.resetAt),
      now,
    )
    // No source has the time, or it is already past: only the owner can decide.
    if (resetAt === null || now >= resetAt + LIMIT_RESUME_GRACE_MS) continue
    if (autoArmed.get(sessionId) === resetAt) continue
    if (!readAutoWaitOnLimit(launch.policy)) continue
    autoArmed.set(sessionId, resetAt)
    continueAfterLimitReset({ sessionId, account: launch.account, resetsAt: resetAt, auto: true })
  }
}

/** Test hook: forgets which reset times were armed automatically. */
export function resetAutoArmed(): void {
  autoArmed.clear()
}

// A wait restored with its session (reload, Resume) needs the heartbeat; a limit screen may
// arm one by itself.
useOrchestraStore.subscribe((state, prev) => {
  if (state.sessions === prev.sessions) return
  if (Object.values(state.sessions).some((s) => s.limitWait)) ensureHeartbeat()
  autoArmLimitWaits()
})
