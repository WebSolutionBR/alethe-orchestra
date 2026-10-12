import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentBlock, OrchestraAgent, OrchestraSession } from '../../../stores/orchestraStore'
import { blockedAlike, preflightBlock, screenNotice, signInErrorText } from './blocking'
import { dueEscalations } from './escalation'
import {
  createScreenWatch,
  KNOWN_STILL_MS,
  PROCEED_STILL_MS,
  UNKNOWN_STILL_MS,
} from './screenWatch'
import { setSigningIn, signInKey, useAttentionStore } from './store'

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), 'src/components/Orchestra/fixtures/screens', name), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')

const agent = (patch: Partial<OrchestraAgent> = {}): OrchestraAgent => ({
  id: 'claude-1',
  area: 'backend',
  task: 't',
  after: [],
  ptyId: 'pty-1',
  state: 'thinking',
  progress: 10,
  note: '',
  lines: [],
  files: [],
  toolCalls: 0,
  startedAt: 0,
  finishedAt: null,
  history: [],
  account: null,
  model: null,
  effort: null,
  ...patch,
})

function rig(initial: OrchestraAgent) {
  let current = initial
  let screen: string[] = fixture('working.txt')
  let now = 1_000_000
  const blocks: (AgentBlock | null)[] = []
  const stalls: (number | null)[] = []
  const session = () =>
    ({ id: 's1', agents: [current], stoppedAt: null }) as unknown as OrchestraSession
  const watch = createScreenWatch(
    {
      getState: () => ({ sessions: { s1: session() } }),
      subscribe: () => () => {},
      screenBlock: (_s, _a, block) => {
        blocks.push(block)
        current = block
          ? { ...current, state: 'blocked', blocked: block }
          : { ...current, state: 'thinking', blocked: null }
      },
      setStalled: (_s, _a, since) => {
        stalls.push(since)
        current = { ...current, stalledSince: since }
      },
    },
    {
      now: () => now,
      screen: () => screen,
      stallMs: () => 15 * 60_000,
      isMainWindow: () => true,
      every: () => () => {},
    },
  )
  return {
    blocks,
    stalls,
    get agent() {
      return current
    },
    show(lines: string[]) {
      screen = lines
    },
    at(ms: number) {
      now += ms
      watch.tick()
    },
    report() {
      const before = { sessions: { s1: session() } }
      current = { ...current, progress: current.progress + 1 }
      watch.onState({ sessions: { s1: session() } }, before)
    },
  }
}

describe('screen watch', () => {
  it('blocks on a known screen once it holds, and clears when it moves on', () => {
    const r = rig(agent())
    r.at(0)
    r.show(fixture('trust.txt'))
    r.at(1000)
    expect(r.blocks).toEqual([])
    r.at(KNOWN_STILL_MS)
    expect(r.agent.blocked?.reason).toBe('trust')
    r.at(5000)
    expect(r.blocks).toHaveLength(1)
    r.show(fixture('working.txt'))
    r.at(5000)
    expect(r.blocks.at(-1)).toBeNull()
    expect(r.agent.state).toBe('thinking')
  })

  it('gives the hooks time on "Do you want to proceed?"', () => {
    const r = rig(agent())
    r.show(fixture('proceed.txt'))
    r.at(0)
    r.at(KNOWN_STILL_MS + 1000)
    expect(r.blocks).toEqual([])
    r.at(PROCEED_STILL_MS)
    expect(r.agent.blocked?.reason).toBe('proceed')
  })

  it('reports a still unknown screen with its last lines', () => {
    const r = rig(agent())
    r.show(fixture('unknown.txt'))
    r.at(0)
    r.at(UNKNOWN_STILL_MS - 1000)
    expect(r.blocks).toEqual([])
    r.at(1000)
    expect(r.agent.blocked?.reason).toBe('unknown-screen')
    expect(r.agent.blocked?.text).toContain('56%')
  })

  it('reads the usage limit with its reset time', () => {
    const r = rig(agent())
    r.show(fixture('usage-limit-menu.txt'))
    r.at(0)
    r.at(KNOWN_STILL_MS)
    expect(r.agent.blocked?.reason).toBe('usage-limit')
    expect(typeof r.agent.blocked?.resetAt).toBe('number')
  })

  it('releases the usage limit at its reset time, even with the old notice still on screen', () => {
    const r = rig(agent())
    r.show(fixture('usage-limit.txt'))
    r.at(0)
    r.at(KNOWN_STILL_MS)
    const resetAt = r.agent.blocked?.resetAt
    expect(r.agent.blocked?.reason).toBe('usage-limit')
    expect(typeof resetAt).toBe('number')
    // Before the reset the unchanged screen keeps it blocked.
    r.at(5000)
    expect(r.agent.state).toBe('blocked')
    r.at(resetAt! - 1_000_000)
    expect(r.blocks.at(-1)).toBeNull()
    expect(r.agent.state).toBe('thinking')
    // The same screen does not block again (nor as an unknown screen)...
    r.at(UNKNOWN_STILL_MS * 2)
    expect(r.blocks.filter(Boolean)).toHaveLength(1)
    // ...but a new limit notice does.
    r.show(fixture('usage-limit-menu.txt'))
    r.at(0)
    r.at(KNOWN_STILL_MS)
    expect(r.agent.blocked?.reason).toBe('usage-limit')
  })

  it('never touches a block the hooks reported', () => {
    const r = rig(
      agent({ state: 'blocked', blocked: { reason: 'permission', text: 'Allow?', at: 1 } }),
    )
    r.show(fixture('unknown.txt'))
    r.at(0)
    r.at(UNKNOWN_STILL_MS * 2)
    expect(r.blocks).toEqual([])
  })

  it('reports a still screen nothing matches even while reports keep coming', () => {
    const r = rig(agent())
    r.show(['● Bash(cargo build --release)'])
    r.at(0)
    for (let i = 0; i < 2; i++) {
      r.at(60_000)
      r.report()
    }
    expect(r.stalls).toEqual([])
    expect(r.agent.blocked?.reason).toBe('unknown-screen')
  })

  it('marks stalled when the screen keeps still and nothing reports, then clears it', () => {
    const r = rig(agent({ state: 'starting' }))
    // Its spinner line says it works (so not an unknown screen), but nothing moves or reports.
    r.show(['✻ Pondering… (esc to interrupt)'])
    r.at(0)
    r.at(15 * 60_000)
    expect(r.agent.stalledSince).toBe(1_000_000)
    r.report()
    r.at(1000)
    expect(r.agent.stalledSince).toBeNull()
  })
})

describe('blocking helpers', () => {
  const base = {
    email: 'contabil@x.com',
    account_uuid: 'u',
    expected_email: 'compras@x.com',
    refreshed: false,
    seed_errors: [],
  }

  it('turns a refused preflight into a block, and a ready one into none', () => {
    expect(preflightBlock({ ...base, status: 'ready' }, 1)).toBeNull()
    expect(preflightBlock({ ...base, status: 'account_mismatch' }, 1)).toEqual({
      reason: 'account',
      text: 'contabil@x.com|compras@x.com',
      at: 1,
    })
    const login = preflightBlock({ ...base, status: 'login_expired' }, 1)!
    expect(login).toEqual({ reason: 'login', text: 'login_expired', at: 1 })
    expect(screenNotice(login)).toBe('cannot start: its account login expired')
  })

  it('tells the orchestrator when the usage limit resets', () => {
    const resetAt = new Date(2026, 9, 12, 18, 30).getTime()
    expect(screenNotice({ reason: 'usage-limit', text: '', at: 1, resetAt })).toBe(
      'hit the usage limit of its account until 18:30',
    )
  })
})

describe('signInErrorText', () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    `${key}${params ? JSON.stringify(params) : ''}`

  it('gives each known reject code its own words and quotes the rest', () => {
    expect(signInErrorText('account_mismatch: contabil@x.com', t)).toBe(
      'orchestra.attention.signIn.mismatch{"email":"contabil@x.com"}',
    )
    expect(signInErrorText('account_busy', t)).toBe('orchestra.attention.signIn.busy')
    expect(signInErrorText('login_timeout', t)).toBe('orchestra.attention.signIn.timeout')
    expect(signInErrorText('chrome_not_found', t)).toBe('orchestra.attention.signIn.noChrome')
    expect(signInErrorText('bad_profile', t)).toBe('orchestra.attention.signIn.badProfile')
    expect(signInErrorText('login_failed: exit 1', t)).toBe(
      'orchestra.attention.signIn.failed{"message":"exit 1"}',
    )
  })
})

describe('blockedAlike', () => {
  const login = (id: string, account: string | null, reason: 'login' | 'account' | 'trust') =>
    agent({
      id,
      state: 'blocked',
      blocked: { reason, text: 'login_expired', at: 1 },
      account,
      launchedWith: { account, model: null, effort: null },
    })
  const session = (policy: 'single' | 'spread', agents: OrchestraAgent[]) =>
    ({
      agents,
      stoppedAt: null,
      launch: { policy, account: 'acc', model: null, effort: null },
    }) as unknown as OrchestraSession

  it('in one-account mode, a sign-in clears every agent blocked on that account', () => {
    const agents = [
      login('claude-1', 'acc', 'login'),
      login('claude-2', 'acc', 'account'),
      login('claude-3', 'acc', 'trust'),
      login('claude-4', 'other', 'login'),
      agent({ id: 'claude-5', account: 'acc' }),
    ]
    expect(blockedAlike(session('single', agents), 'claude-1')).toEqual(['claude-2'])
    expect(blockedAlike(session('single', agents), 'claude-3')).toEqual([])
  })

  it('a folder trust clears the other agents stuck on the trust dialog', () => {
    const agents = [login('claude-1', 'acc', 'trust'), login('claude-2', 'acc', 'trust')]
    expect(blockedAlike(session('single', agents), 'claude-1')).toEqual(['claude-2'])
  })

  it('leaves a spread session and a stopped one alone', () => {
    const agents = [login('claude-1', 'acc', 'login'), login('claude-2', 'acc', 'login')]
    expect(blockedAlike(session('spread', agents), 'claude-1')).toEqual([])
    const stopped = { ...session('single', agents), stoppedAt: 5 } as OrchestraSession
    expect(blockedAlike(stopped, 'claude-1')).toEqual([])
  })

  it('records one sign-in per account at a time', () => {
    const key = signInKey('s1', 'acc')
    setSigningIn(key, 'claude-1')
    expect(useAttentionStore.getState().signingIn[key]).toBe('claude-1')
    setSigningIn(key, null)
    expect(useAttentionStore.getState().signingIn[key]).toBeUndefined()
    expect(signInKey('s1', null)).toBe('s1:')
  })
})

describe('dueEscalations', () => {
  const prefs = { thresholdMin: 10, repeatMin: 0, stallMin: 15 }
  const sessions = (block: AgentBlock | null) => ({
    s1: { stoppedAt: null, agents: [agent(block ? { state: 'blocked', blocked: block } : {})] },
  })

  it('reminds once with repeat 0, and forgets a block that ended', () => {
    const sent = new Map<string, number>()
    const block: AgentBlock = { reason: 'login', text: 'login_expired', at: 0 }
    expect(dueEscalations(sessions(block), 10 * 60_000, prefs, sent, {})).toHaveLength(1)
    expect(dueEscalations(sessions(block), 99 * 60_000, prefs, sent, {})).toHaveLength(0)
    expect(dueEscalations(sessions(null), 99 * 60_000, prefs, sent, {})).toHaveLength(0)
    expect(sent.size).toBe(0)
  })

  it('ignores blocks that wait on another agent', () => {
    const block: AgentBlock = { reason: 'dependency', text: 'claude-2', at: 0 }
    expect(dueEscalations(sessions(block), 60 * 60_000, prefs, new Map(), {})).toHaveLength(0)
  })
})
