import { describe, expect, it, vi } from 'vitest'

import { formatResetDiff, formatResetMs, formatResetTime } from './usageReset'

describe('formatResetDiff', () => {
  it('shows minutes only below one hour', () => {
    expect(formatResetDiff(60_000)).toBe('1m')
    expect(formatResetDiff(59 * 60_000)).toBe('59m')
  })

  it('shows hours and minutes between one hour and one day', () => {
    expect(formatResetDiff(3_600_000)).toBe('1h 0m')
    expect(formatResetDiff(2 * 3_600_000 + 13 * 60_000)).toBe('2h 13m')
    expect(formatResetDiff(23 * 3_600_000 + 59 * 60_000)).toBe('23h 59m')
  })

  it('shows days and hours from 24h on, which is the weekly window', () => {
    expect(formatResetDiff(24 * 3_600_000)).toBe('1d 0h')
    expect(formatResetDiff(3 * 24 * 3_600_000 + 4 * 3_600_000)).toBe('3d 4h')
    expect(formatResetDiff(6 * 24 * 3_600_000 + 23 * 3_600_000)).toBe('6d 23h')
  })

  it('treats an elapsed window as resetting', () => {
    expect(formatResetDiff(0)).toBe('resetting…')
    expect(formatResetDiff(-5_000)).toBe('resetting…')
  })

  it('falls back to a dash when the value is not a number', () => {
    expect(formatResetDiff(Number.NaN)).toBe('—')
  })
})

describe('formatResetTime', () => {
  it('turns the API ISO string into the distance from now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))
    expect(formatResetTime('2026-08-17T14:13:00Z')).toBe('2h 13m')
    expect(formatResetTime('2026-08-20T16:00:00Z')).toBe('3d 4h')
    vi.useRealTimers()
  })

  it('falls back to a dash for an empty string or an invalid date', () => {
    expect(formatResetTime('')).toBe('—')
    expect(formatResetTime('not a date')).toBe('—')
  })
})

describe('formatResetMs', () => {
  it('accepts an epoch in milliseconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T12:00:00Z'))
    expect(formatResetMs(new Date('2026-08-17T13:30:00Z').getTime())).toBe('1h 30m')
    vi.useRealTimers()
  })

  it('falls back to a dash when there is no value', () => {
    expect(formatResetMs(0)).toBe('—')
  })
})
