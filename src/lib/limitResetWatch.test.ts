import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUTO_WAIT_STORAGE_KEY } from '../components/Orchestra/accounts/limitPrefs'
import { classifyScreen } from '../components/Orchestra/screenClassifier'
import { useUsageStore } from '../components/Orchestra/usage/usageStore'
import { type OrchestraSession, useOrchestraStore } from '../stores/orchestraStore'
import {
  autoArmLimitWaits,
  cancelLimitWait,
  checkLimitWaits,
  continueAfterLimitReset,
  forgetResumeInProgress,
  LIMIT_MAX_REARMS,
  LIMIT_REARM_DELAY_MS,
  LIMIT_REBLOCK_WINDOW_MS,
  LIMIT_RESUME_GRACE_MS,
  LIMIT_RESUME_STAGGER_MS,
  LIMIT_RESUME_TEXT,
  limitBlockedAgents,
  limitWaitOf,
  resetAutoArmed,
  USAGE_LIMIT_REASON,
} from './limitResetWatch'

const RESET = Date.parse('2026-10-12T18:00:00Z')

function agent(
  id: string,
  state: string,
  reason: string | null,
  account: string | null,
  extra: { progress?: number; resetAt?: number } = {},
) {
  return {
    id,
    state,
    progress: extra.progress ?? 0,
    blocked: reason ? { reason, text: '', at: 0, resetAt: extra.resetAt ?? null } : null,
    launchedWith: { account, model: null, effort: null },
  }
}

/** Lets a finished resume turn settle (its bookkeeping runs after the last send). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function patchAgent(id: string, patch: Record<string, unknown>) {
  useOrchestraStore.setState((state) => {
    const session = state.sessions.s1
    if (!session) return state
    const agents = session.agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
    return { sessions: { s1: { ...session, agents } } }
  })
}

/** The screen watcher sees the limit on the agent's screen again, at `at`. */
function limitAgain(id: string, at: number) {
  patchAgent(id, { state: 'blocked', blocked: { reason: USAGE_LIMIT_REASON, text: '', at } })
}

function seed(agents: ReturnType<typeof agent>[], session: Partial<OrchestraSession> = {}) {
  useOrchestraStore.setState({
    sessions: { s1: { id: 's1', agents, ...session } as unknown as OrchestraSession },
  })
}

describe('continueAfterLimitReset', () => {
  let calls: string[]
  let original: ReturnType<typeof useOrchestraStore.getState>
  let originalRows: ReturnType<typeof useUsageStore.getState>['rows']
  let sendTo: ReturnType<typeof vi.fn>
  let tellAgent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    original = useOrchestraStore.getState()
    originalRows = useUsageStore.getState().rows
    calls = []
    sendTo = vi.fn((_s: string, id: string, text: string) => {
      calls.push(`send ${id} ${text}`)
      return Promise.resolve()
    })
    tellAgent = vi.fn()
    useOrchestraStore.setState({
      sendTo,
      tellAgent,
      interruptAgent: vi.fn((_s: string, id: string) => {
        calls.push(`esc ${id}`)
        return Promise.resolve()
      }),
      // Like the store: clearing a screen block sets the agent going again.
      screenBlock: vi.fn((_s: string, id: string, block: unknown) => {
        if (block !== null) return
        calls.push(`unblock ${id}`)
        patchAgent(id, { state: 'thinking', blocked: null })
      }),
    } as never)
    seed([
      agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a'),
      agent('claude-2', 'blocked', 'permission', 'acct-a'),
      agent('claude-3', 'thinking', null, 'acct-a'),
      agent('claude-4', 'blocked', USAGE_LIMIT_REASON, 'acct-b'),
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
    forgetResumeInProgress()
    resetAutoArmed()
    localStorage.clear()
    useUsageStore.setState({ rows: originalRows } as never)
    useOrchestraStore.setState({
      sendTo: original.sendTo,
      tellAgent: original.tellAgent,
      interruptAgent: original.interruptAgent,
      screenBlock: original.screenBlock,
      sessions: {},
    } as never)
  })

  it('picks only agents stopped by the limit on that account', () => {
    expect(limitBlockedAgents('s1', 'acct-a')).toEqual(['claude-1'])
    expect(limitBlockedAgents('s1', 'acct-b')).toEqual(['claude-4'])
    expect(limitBlockedAgents('s1', null)).toEqual([])
    expect(limitBlockedAgents('missing', 'acct-a')).toEqual([])
  })

  it('keeps the wait in the session and tells the orchestrator once, not to replan', () => {
    continueAfterLimitReset({
      sessionId: 's1',
      account: 'acct-a',
      resetsAt: '2026-10-12T18:00:00Z',
    })
    expect(useOrchestraStore.getState().sessions.s1.limitWait).toEqual({
      account: 'acct-a',
      resetsAt: RESET,
    })
    expect(tellAgent).toHaveBeenCalledTimes(1)
    const [, to, text] = tellAgent.mock.calls[0] as [string, string, string]
    expect(to).toBe('orchestrator')
    expect(text).toMatch(
      /^account acct-a hit its usage limit; the workers resume on their own at \d\d:\d\d\. Do not replan/,
    )
    // The same wait again (a second click) says nothing new.
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    expect(tellAgent).toHaveBeenCalledTimes(1)
  })

  it('closes the limit screen, clears the block, then sends continue, once', async () => {
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    expect(limitWaitOf('s1')).toEqual({ account: 'acct-a', resetsAt: RESET })

    checkLimitWaits(RESET + LIMIT_RESUME_GRACE_MS - 1)
    expect(calls).toEqual([])

    checkLimitWaits(RESET + LIMIT_RESUME_GRACE_MS)
    await vi.waitFor(() => expect(sendTo).toHaveBeenCalledTimes(1))
    expect(calls).toEqual([
      'esc claude-1',
      'unblock claude-1',
      `send claude-1 ${LIMIT_RESUME_TEXT}`,
    ])
    // The wait stays until a check finds nobody limited any more.
    expect(limitWaitOf('s1')).toMatchObject({ resumedAt: RESET + LIMIT_RESUME_GRACE_MS })
    await vi.waitFor(() => {
      checkLimitWaits(RESET + 2 * LIMIT_RESUME_GRACE_MS)
      expect(limitWaitOf('s1')).toBeNull()
    })

    checkLimitWaits(RESET + 10 * LIMIT_RESUME_GRACE_MS)
    await Promise.resolve()
    expect(sendTo).toHaveBeenCalledTimes(1)
  })

  it('a reload in the middle of the staggered resume still resumes the rest', async () => {
    vi.useFakeTimers()
    seed([
      agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { progress: 30 }),
      agent('claude-2', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { progress: 90 }),
      agent('orchestrator', 'blocked', USAGE_LIMIT_REASON, 'acct-a'),
    ])
    const start = RESET + LIMIT_RESUME_GRACE_MS
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    checkLimitWaits(start)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendTo.mock.calls.map((c) => c[1])).toEqual(['orchestrator'])
    // While the turn runs, the heartbeat schedules nothing twice.
    checkLimitWaits(start + 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendTo).toHaveBeenCalledTimes(1)

    // Reload: the timers die with the page; the wait came back with the session.
    vi.clearAllTimers()
    forgetResumeInProgress()
    expect(limitWaitOf('s1')).toMatchObject({ resumedAt: start })
    checkLimitWaits(start + 60_000)
    await vi.advanceTimersByTimeAsync(LIMIT_RESUME_STAGGER_MS)
    expect(sendTo.mock.calls.map((c) => c[1])).toEqual(['orchestrator', 'claude-2', 'claude-1'])
    checkLimitWaits(start + 120_000)
    expect(limitWaitOf('s1')).toBeNull()
  })

  it('re-arms for 5 min when the limit comes back within 10 min, at most 3 times', async () => {
    seed([agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a')])
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    let now = RESET + LIMIT_RESUME_GRACE_MS
    for (let rearm = 1; rearm <= LIMIT_MAX_REARMS; rearm++) {
      checkLimitWaits(now)
      await vi.waitFor(() => expect(sendTo).toHaveBeenCalledTimes(rearm))
      await flush()
      limitAgain('claude-1', now + 30_000)
      now += 60_000
      checkLimitWaits(now)
      expect(limitWaitOf('s1')).toEqual({
        account: 'acct-a',
        resetsAt: now + LIMIT_REARM_DELAY_MS,
        rearms: rearm,
      })
      expect(tellAgent.mock.calls.at(-1)?.[2]).toContain(`(${rearm} of 3)`)
      now += LIMIT_REARM_DELAY_MS + LIMIT_RESUME_GRACE_MS
    }
    // A fourth time: the owner decides; the orchestrator is told not to replan yet.
    checkLimitWaits(now)
    await vi.waitFor(() => expect(sendTo).toHaveBeenCalledTimes(LIMIT_MAX_REARMS + 1))
    await flush()
    limitAgain('claude-1', now + 30_000)
    checkLimitWaits(now + 60_000)
    expect(limitWaitOf('s1')).toBeNull()
    expect(tellAgent.mock.calls.at(-1)?.[2]).toContain('came back 3 times')
  })

  it('a limit long after the resume is a new one: the wait is dropped, not re-armed', async () => {
    seed([agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a')])
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    const start = RESET + LIMIT_RESUME_GRACE_MS
    checkLimitWaits(start)
    await vi.waitFor(() => expect(sendTo).toHaveBeenCalledTimes(1))
    await flush()
    limitAgain('claude-1', start + LIMIT_REBLOCK_WINDOW_MS + 1)
    checkLimitWaits(start + LIMIT_REBLOCK_WINDOW_MS + 60_000)
    expect(limitWaitOf('s1')).toBeNull()
  })

  it('unblocks an agent on the menu screen of the fixture', async () => {
    const screen = readFileSync(
      join(__dirname, '../components/Orchestra/fixtures/screens/usage-limit-menu.txt'),
      'utf8',
    )
    const verdict = classifyScreen(screen.split(/\r?\n/), new Date(RESET - 3_600_000))
    expect(verdict?.kind).toBe(USAGE_LIMIT_REASON)
    seed([agent('claude-1', 'blocked', verdict!.kind, 'acct-a')])
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    checkLimitWaits(RESET + LIMIT_RESUME_GRACE_MS)
    await vi.waitFor(() => expect(sendTo).toHaveBeenCalled())
    // Esc ("Esc to cancel"), never Enter: the cursor may sit on "extra usage".
    expect(calls[0]).toBe('esc claude-1')
  })

  it('resumes the orchestrator first, then the workers closest to done, 20 s apart', async () => {
    vi.useFakeTimers()
    seed([
      agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { progress: 30 }),
      agent('claude-2', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { progress: 90 }),
      agent('orchestrator', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { progress: 0 }),
    ])
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    checkLimitWaits(RESET + LIMIT_RESUME_GRACE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendTo.mock.calls.map((c) => c[1])).toEqual(['orchestrator'])
    await vi.advanceTimersByTimeAsync(LIMIT_RESUME_STAGGER_MS)
    expect(sendTo.mock.calls.map((c) => c[1])).toEqual(['orchestrator', 'claude-2'])
    await vi.advanceTimersByTimeAsync(LIMIT_RESUME_STAGGER_MS)
    expect(sendTo.mock.calls.map((c) => c[1])).toEqual(['orchestrator', 'claude-2', 'claude-1'])
  })

  it('skips agents that got going again before the reset', async () => {
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    seed([agent('claude-1', 'thinking', null, 'acct-a')], {
      limitWait: { account: 'acct-a', resetsAt: RESET },
    })
    checkLimitWaits(RESET + LIMIT_RESUME_GRACE_MS)
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('cancels: by the returned function, by cancelLimitWait, and ignores a bad time', () => {
    const cancel = continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    cancel()
    expect(limitWaitOf('s1')).toBeNull()

    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: RESET })
    cancelLimitWait('s1')
    checkLimitWaits(RESET + LIMIT_RESUME_GRACE_MS)
    expect(sendTo).not.toHaveBeenCalled()

    continueAfterLimitReset({ sessionId: 's1', account: 'acct-a', resetsAt: 'not a date' })
    expect(limitWaitOf('s1')).toBeNull()
  })

  it('a stale cancel does not drop a newer wait of the same session', () => {
    const cancelOld = continueAfterLimitReset({
      sessionId: 's1',
      account: 'acct-a',
      resetsAt: RESET,
    })
    continueAfterLimitReset({ sessionId: 's1', account: 'acct-b', resetsAt: RESET })
    cancelOld()
    expect(limitWaitOf('s1')).toEqual({ account: 'acct-b', resetsAt: RESET })
  })

  it('arms the wait by itself on the first limit block, once per reset time', () => {
    const launch = { policy: 'single', account: 'acct-a', model: null, effort: null }
    seed([agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { resetAt: RESET })], {
      launch,
    } as Partial<OrchestraSession>)
    autoArmLimitWaits(RESET - 60_000)
    expect(limitWaitOf('s1')).toEqual({ account: 'acct-a', resetsAt: RESET, auto: true })
    // The owner cancelled it: the same limit window does not arm it again.
    cancelLimitWait('s1')
    autoArmLimitWaits(RESET - 30_000)
    expect(limitWaitOf('s1')).toBeNull()
  })

  it('arms with the reset of the usage cache before the one on screen', () => {
    const launch = { policy: 'single', account: 'acct-a', model: null, effort: null }
    const cached = RESET + 3_600_000
    useUsageStore.setState({
      rows: [{ id: 'acct-a', usage: { five_hour: { resets_at: new Date(cached).toISOString() } } }],
    } as never)
    seed([agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { resetAt: RESET })], {
      launch,
    } as Partial<OrchestraSession>)
    autoArmLimitWaits(RESET - 60_000)
    expect(limitWaitOf('s1')).toEqual({ account: 'acct-a', resetsAt: cached, auto: true })
  })

  it('does not arm by itself with the preference off or no reset time on screen', () => {
    const launch = { policy: 'single', account: 'acct-a', model: null, effort: null }
    localStorage.setItem(AUTO_WAIT_STORAGE_KEY, '0')
    seed([agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a', { resetAt: RESET })], {
      launch,
    } as Partial<OrchestraSession>)
    autoArmLimitWaits(RESET - 60_000)
    expect(limitWaitOf('s1')).toBeNull()

    localStorage.setItem(AUTO_WAIT_STORAGE_KEY, '1')
    seed([agent('claude-1', 'blocked', USAGE_LIMIT_REASON, 'acct-a')], {
      launch,
    } as Partial<OrchestraSession>)
    autoArmLimitWaits(RESET - 60_000)
    expect(limitWaitOf('s1')).toBeNull()
  })
})
