import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageStore } from '../components/Orchestra/usage/usageStore'
import { type OrchestraSession, useOrchestraStore } from '../stores/orchestraStore'
import {
  checkSoftLanding,
  resetSoftLanding,
  SOFT_LANDING_ORCHESTRATOR_TEXT,
  SOFT_LANDING_WORKER_TEXT,
  softLandingDue,
} from './limitSoftLanding'
import type { ClaudeUsage } from './tauri'

const RESET_A = '2026-10-12T19:30:00Z'
const RESET_B = '2026-10-13T00:30:00Z'

function usage(pct: number, resetsAt = RESET_A): ClaudeUsage {
  return { five_hour: { utilization: pct, resets_at: resetsAt } } as unknown as ClaudeUsage
}

function seed(account: string | null, extra: Partial<OrchestraSession> = {}) {
  const agents = [
    { id: 'orchestrator', state: 'thinking' },
    { id: 'claude-1', state: 'editing' },
    { id: 'claude-2', state: 'done' },
    { id: 'claude-3', state: 'exited' },
  ]
  useOrchestraStore.setState({
    sessions: {
      s1: {
        id: 's1',
        agents,
        launch: { account, model: null, effort: null, policy: 'single' },
        ...extra,
      } as unknown as OrchestraSession,
    },
  })
}

function rows(id: string, pct: number, resetsAt = RESET_A) {
  useUsageStore.setState({ rows: [{ id, name: null, usage: usage(pct, resetsAt), error: null }] })
}

describe('limitSoftLanding', () => {
  beforeEach(() => resetSoftLanding())

  it('fires once per five-hour window at 90%', () => {
    expect(softLandingDue('s1', usage(89))).toBe(false)
    expect(softLandingDue('s1', usage(90))).toBe(true)
    expect(softLandingDue('s1', usage(95))).toBe(false)
    expect(softLandingDue('s1', usage(91, RESET_B))).toBe(true)
  })

  it('stays quiet without data or once the limit is already hit', () => {
    expect(softLandingDue('s1', null)).toBe(false)
    expect(softLandingDue('s1', usage(100))).toBe(false)
  })

  it('tells the orchestrator and the live workers of the session account', () => {
    seed('acc-1')
    rows('acc-1', 92)
    const notify = vi.fn()
    checkSoftLanding(notify)
    expect(notify.mock.calls).toEqual([
      ['s1', 'orchestrator', SOFT_LANDING_ORCHESTRATOR_TEXT],
      ['s1', 'claude-1', SOFT_LANDING_WORKER_TEXT],
    ])
    checkSoftLanding(notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('reads the default account row for a session on the default account', () => {
    seed(null)
    rows('', 90)
    const notify = vi.fn()
    checkSoftLanding(notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('ignores stopped sessions, other accounts and a failing notice', () => {
    seed('acc-1', { stoppedAt: 1 })
    rows('acc-1', 95)
    const notify = vi.fn()
    checkSoftLanding(notify)
    seed('acc-1')
    rows('acc-2', 95)
    checkSoftLanding(notify)
    expect(notify).not.toHaveBeenCalled()
    rows('acc-1', 95)
    expect(() =>
      checkSoftLanding(() => {
        throw new Error('pty gone')
      }),
    ).not.toThrow()
  })
})
