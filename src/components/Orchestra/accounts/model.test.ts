import { describe, expect, it } from 'vitest'

import type { ClaudeAccountIdentity } from '../../../lib/tauri/orchestra'
import type { OrchestraAgent } from '../../../stores/orchestraStore'
import type { SessionLaunch } from '../usage/launch'
import { restartPlan } from './actions'
import {
  agentsByAccount,
  agentsOffAccount,
  cardError,
  duplicateAccounts,
  emailMismatch,
  limitedUntil,
  limitResetAt,
  MAX_LIMIT_REARMS,
  nearLimit,
  switchRisks,
  waitingText,
} from './model'

const identity = (id: string, uuid: string | null, email: string | null = null) =>
  ({ id, email, account_uuid: uuid, organization_name: null }) as ClaudeAccountIdentity

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: 'api',
    task: '',
    after: [],
    ptyId: `pty-${id}`,
    state: 'editing',
    progress: 0,
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
    launchedWith: { account: 'acc-a', model: null, effort: null },
    ...patch,
  }
}

describe('duplicate accounts', () => {
  const accounts = [
    { id: 'est', name: 'Estatística' },
    { id: 'com', name: 'Compras' },
    { id: 'pri', name: 'Pricing' },
    { id: 'con', name: 'Contábil' },
  ]

  it('flags linked accounts signed in to the same Claude account (the 06/10/2026 case)', () => {
    const found = duplicateAccounts(accounts, {
      est: identity('est', 'u-contabil'),
      com: identity('com', 'u-contabil'),
      pri: identity('pri', 'u-pricing'),
      con: identity('con', 'u-contabil'),
    })
    expect(found.get('est')).toEqual(['com', 'con'])
    expect(found.get('con')).toEqual(['est', 'com'])
    expect(found.has('pri')).toBe(false)
  })

  it('ignores the default account and folders without a sign-in', () => {
    const found = duplicateAccounts(accounts, {
      '': identity('', 'u-1'),
      est: identity('est', 'u-1'),
      com: identity('com', null),
      pri: identity('pri', null),
    })
    expect(found.size).toBe(0)
  })
})

describe('real sign-in', () => {
  it('warns when the expected e-mail is not the real one, ignoring case and blanks', () => {
    expect(emailMismatch({ email: 'Compras@x.com ' }, identity('a', 'u', 'compras@x.com'))).toBe(
      false,
    )
    expect(emailMismatch({ email: 'compras@x.com' }, identity('a', 'u', 'contabil@x.com'))).toBe(
      true,
    )
    expect(emailMismatch({}, identity('a', 'u', 'contabil@x.com'))).toBe(false)
    expect(emailMismatch({ email: 'compras@x.com' }, undefined)).toBe(false)
  })
})

describe('agents per account', () => {
  const launch: SessionLaunch = { policy: 'single', account: 'acc-b', model: null, effort: null }

  it('counts running agents on the account they started with, not exited or waiting ones', () => {
    const agents = [
      agent('orchestrator'),
      agent('claude-1', { launchedWith: { account: 'acc-b', model: null, effort: null } }),
      agent('claude-2', { launchedWith: { account: null, model: null, effort: null } }),
      agent('claude-3', { state: 'exited' }),
      agent('claude-4', { state: 'waiting', launchedWith: null }),
    ]
    const by = agentsByAccount(agents, launch)
    expect(by.get('acc-a')?.map((a) => a.id)).toEqual(['orchestrator'])
    expect(by.get('acc-b')?.map((a) => a.id)).toEqual(['claude-1'])
    expect(by.get('')?.map((a) => a.id)).toEqual(['claude-2'])
    expect(agentsOffAccount(agents, launch).map((a) => a.id)).toEqual(['orchestrator', 'claude-2'])
  })

  it('plans each restart: carry a known conversation, start over without one', () => {
    const agents = [
      agent('orchestrator', { claudeSessionId: 'c-0' }),
      agent('claude-1', { claudeSessionId: null }),
      agent('claude-2', {
        claudeSessionId: 'c-2',
        launchedWith: { account: 'acc-b', model: null, effort: null },
      }),
    ]
    expect(restartPlan(agents, 'acc-b')).toEqual({ carry: ['orchestrator'], fresh: ['claude-1'] })
  })
})

describe('limits', () => {
  const usage = (five: number, week: number) => ({
    five_hour: { utilization: five, resets_at: '2026-10-12T18:00:00Z' },
    seven_day: { utilization: week, resets_at: '2026-10-15T09:00:00Z' },
    seven_day_opus: { utilization: 0, resets_at: '' },
  })

  it('is near the limit from 90% of the 5h window', () => {
    expect(nearLimit(usage(90, 10))).toBe(true)
    expect(nearLimit(usage(89, 100))).toBe(false)
    expect(nearLimit(null)).toBe(false)
  })

  it('is limited until the reset of the full window, the later one when both are', () => {
    expect(limitedUntil(usage(50, 50))).toBeNull()
    expect(limitedUntil(usage(100, 40))).toBe(Date.parse('2026-10-12T18:00:00Z'))
    expect(limitedUntil(usage(100, 100))).toBe(Date.parse('2026-10-15T09:00:00Z'))
    expect(limitedUntil(undefined)).toBeNull()
  })
})

describe('card errors', () => {
  it('gives each usage error its own message and action', () => {
    expect(cardError({ error: 'login_expired', retryAt: null })).toEqual({ kind: 'login' })
    expect(cardError({ error: 'token_expired' })).toEqual({ kind: 'login' })
    expect(cardError({ error: 'rate_limited', retryAt: 5_000 })).toEqual({
      kind: 'rateLimited',
      retryAt: 5_000,
    })
    expect(cardError({ error: 'no_token' })).toEqual({ kind: 'signedOut' })
    expect(cardError({ error: 'http 500' })).toEqual({ kind: 'unavailable' })
    expect(cardError({ error: null })).toBeNull()
  })
})

describe('switch risks', () => {
  const usage = (five: number, week: number) =>
    ({
      five_hour: { utilization: five, resets_at: '' },
      seven_day: { utilization: week, resets_at: '' },
    }) as never
  it('asks for an error, 90% of either window or a duplicate sign-in', () => {
    expect(switchRisks({ usage: usage(10, 10), error: null }, [])).toEqual([])
    expect(switchRisks({ usage: null, error: 'login_expired' }, [])).toEqual(['error'])
    expect(switchRisks({ usage: usage(90, 0), error: null }, [])).toEqual(['near'])
    expect(switchRisks({ usage: usage(0, 95), error: null }, [])).toEqual(['near'])
    expect(switchRisks({ usage: usage(0, 0), error: null }, ['b'])).toEqual(['duplicate'])
  })
})

describe('limit reset fallback', () => {
  const now = Date.parse('2026-10-12T15:00:00Z')
  it('prefers the full window from the usage cache', () => {
    const usage = {
      five_hour: { utilization: 100, resets_at: '2026-10-12T17:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-10-15T00:00:00Z' },
    }
    expect(limitResetAt(usage as never, [now + 1], now)).toBe(Date.parse('2026-10-12T17:00:00Z'))
  })
  it('falls back to the latest blocked.resetAt when the cache has no reset (429)', () => {
    expect(limitResetAt(null, [now + 60_000, null, now + 120_000, 0], now)).toBe(now + 120_000)
  })
  it('has no time without either source: the strip shows "?"', () => {
    expect(limitResetAt(null, [null, undefined, 0], now)).toBeNull()
    expect(limitResetAt(null, [], now)).toBeNull()
  })
})

describe('waiting text', () => {
  it('says when the wait was armed again, by itself or by hand', () => {
    expect(waitingText({ rearms: 2, auto: true })).toEqual({
      key: 'orchestra.limit.rearmed',
      count: 2,
    })
    expect(waitingText({ rearms: 9 })).toEqual({
      key: 'orchestra.limit.rearmed',
      count: MAX_LIMIT_REARMS,
    })
    expect(waitingText({ auto: true })).toEqual({ key: 'orchestra.limit.waitingAuto' })
    expect(waitingText({})).toEqual({ key: 'orchestra.limit.waiting' })
  })
})
