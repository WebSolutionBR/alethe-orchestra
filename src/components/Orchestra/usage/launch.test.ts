import { describe, expect, it } from 'vitest'

import { accountsPromptHint, EMPTY_LAUNCH, launchArgs, resolveLaunch, shortModel } from './launch'
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

  it('builds an ascii-safe accounts hint for the orchestrator', () => {
    expect(accountsPromptHint([])).toContain('--effort <low|medium|high|xhigh|max>')
    expect(accountsPromptHint([])).not.toContain('--account')
    expect(accountsPromptHint([{ id: 'a1', name: 'Contábil (RJ)' }])).toContain(
      'Claude accounts available for --account <id>: a1=Contabil RJ.',
    )
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
