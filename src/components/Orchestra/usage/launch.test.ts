import { describe, expect, it } from 'vitest'

import {
  accountsPromptHint,
  agentLaunch,
  EMPTY_LAUNCH,
  ignoredAccount,
  launchArgs,
  moveOutcome,
  parseAccountSwitches,
  parseSessionLaunch,
  resolveLaunch,
  restoredLaunch,
  type SessionLaunch,
  shortModel,
} from './launch'
import { peakUtilization, resetLabel, usageLevel } from './usageStore'

describe('resolveLaunch', () => {
  it('prefers per-agent values and falls back to session defaults', () => {
    const defaults = { account: 'acc-a', model: 'sonnet', effort: 'high' }
    expect(resolveLaunch({ model: 'opus', account: '  ' }, defaults)).toEqual({
      account: 'acc-a',
      model: 'opus',
      effort: 'high',
    })
    expect(resolveLaunch(undefined, EMPTY_LAUNCH)).toEqual(EMPTY_LAUNCH)
  })
})

describe('launchArgs', () => {
  it('passes model and a known effort level', () => {
    expect(launchArgs({ account: 'x', model: 'opus', effort: 'max' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'max',
    ])
  })

  it('drops unknown effort levels and empty options', () => {
    expect(launchArgs({ account: null, model: null, effort: 'turbo' })).toEqual([])
  })
})

describe('labels', () => {
  it('shortens full model ids', () => {
    expect(shortModel('claude-fable-5-1')).toBe('fable-5-1')
    expect(shortModel('opus')).toBe('opus')
  })

  it('lists the accounts only when the session spreads work across them', () => {
    const accounts = [{ id: 'a1', name: 'Contábil (RJ)' }]
    expect(accountsPromptHint([], 'spread')).toContain('--effort <low|medium|high|xhigh|max>')
    expect(accountsPromptHint([], 'spread')).not.toContain('--account <id>')
    expect(accountsPromptHint(accounts, 'spread')).toContain(
      'Claude accounts available for --account <id>: a1=Contabil RJ.',
    )
    expect(accountsPromptHint(accounts, 'spread')).toContain('Spread heavy work across accounts')
    expect(accountsPromptHint(accounts, 'spread')).toContain('"orch spawn"')
  })

  it('in a one-account session, neither lists the accounts nor suggests spreading', () => {
    const hint = accountsPromptHint([{ id: 'a1', name: 'Contábil' }])
    expect(hint).toContain('--model <')
    expect(hint).not.toContain('a1=')
    expect(hint).not.toMatch(/spread/i)
    expect(hint).toContain('it is ignored')
    expect(hint).not.toContain('orch.cmd')
  })
})

describe('session account policy', () => {
  const single: SessionLaunch = {
    policy: 'single',
    account: 'acc-a',
    model: 'sonnet',
    effort: null,
  }
  const spread: SessionLaunch = { ...single, policy: 'spread' }

  it('one account: an agent asking for another account still runs on the session one', () => {
    const asked = { account: 'acc-b', model: 'opus', effort: 'high' }
    expect(agentLaunch(asked, single)).toEqual({ account: 'acc-a', model: 'opus', effort: 'high' })
    expect(ignoredAccount(asked, single)).toBe('acc-b')
    expect(ignoredAccount({ account: 'acc-a' }, single)).toBeNull()
    expect(ignoredAccount({}, single)).toBeNull()
  })

  it('one account on the default account drops the flag too', () => {
    const onDefault: SessionLaunch = { ...single, account: null }
    expect(agentLaunch({ account: 'acc-b' }, onDefault).account).toBeNull()
    expect(ignoredAccount({ account: 'acc-b' }, onDefault)).toBe('acc-b')
  })

  it('spread: the agent flag wins, the session account is the fallback', () => {
    expect(agentLaunch({ account: 'acc-b' }, spread).account).toBe('acc-b')
    expect(agentLaunch({}, spread)).toEqual({ account: 'acc-a', model: 'sonnet', effort: null })
    expect(ignoredAccount({ account: 'acc-b' }, spread)).toBeNull()
  })

  it('parses saved launch settings and switches, refusing malformed ones', () => {
    expect(
      parseSessionLaunch({ policy: 'spread', account: 'x', model: null, effort: ' ' }),
    ).toEqual({
      policy: 'spread',
      account: 'x',
      model: null,
      effort: null,
    })
    expect(parseSessionLaunch({ policy: 'many', account: null })).toBeNull()
    expect(parseSessionLaunch({ policy: 'single', account: 3 })).toBeNull()
    expect(parseSessionLaunch(null)).toBeNull()
    expect(
      parseAccountSwitches([
        { at: 20, from: 'a', to: null },
        { at: 'x', from: 'a', to: 'b' },
        { at: 10, from: null, to: 'a' },
        null,
      ]),
    ).toEqual([
      { at: 10, from: null, to: 'a' },
      { at: 20, from: 'a', to: null },
    ])
    expect(parseAccountSwitches('nope')).toEqual([])
  })

  it('a resumed session keeps its saved settings, else one account: the orchestrator one', () => {
    const defaults: SessionLaunch = {
      policy: 'spread',
      account: 'acc-z',
      model: 'haiku',
      effort: 'low',
    }
    expect(restoredLaunch(spread, 'acc-q', defaults)).toEqual(spread)
    expect(restoredLaunch(undefined, 'acc-q', defaults)).toEqual({
      policy: 'single',
      account: 'acc-q',
      model: 'haiku',
      effort: 'low',
    })
    expect(restoredLaunch(undefined, undefined, defaults).account).toBe('acc-z')
  })

  it('moving to another account carries a known conversation, else starts over', () => {
    const ran = { account: 'acc-a', model: null, effort: null }
    expect(moveOutcome({ launchedWith: ran, claudeSessionId: 'c' }, 'acc-a')).toBe('same')
    expect(moveOutcome({ launchedWith: ran, claudeSessionId: 'c' }, 'acc-b')).toBe('carry')
    expect(moveOutcome({ launchedWith: ran, claudeSessionId: null }, null)).toBe('fresh')
    expect(moveOutcome({ account: null, launchedWith: null }, null)).toBe('same')
  })
})

describe('usage helpers', () => {
  const window = (utilization: number) => ({ utilization, resets_at: '' })

  it('takes the worst window and buckets it', () => {
    const usage = { five_hour: window(40), seven_day: window(92), seven_day_opus: window(0) }
    expect(peakUtilization(usage)).toBe(92)
    expect(peakUtilization(null)).toBeNull()
    expect(usageLevel(92)).toBe('hot')
    expect(usageLevel(75)).toBe('warn')
    expect(usageLevel(10)).toBe('ok')
    expect(usageLevel(null)).toBe('none')
  })

  it('formats reset times relative to now', () => {
    const now = Date.parse('2026-10-04T12:00:00Z')
    expect(resetLabel('2026-10-04T12:30:00Z', now)).toBe('30m')
    expect(resetLabel('2026-10-04T14:05:00Z', now)).toBe('2h05')
    expect(resetLabel('2026-10-07T12:00:00Z', now)).toBe('3d')
    expect(resetLabel('nope', now)).toBe('')
    expect(resetLabel(undefined, now)).toBe('')
  })
})
