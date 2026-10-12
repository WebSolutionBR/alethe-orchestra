import { afterEach, describe, expect, it } from 'vitest'

import {
  forgetRetired,
  MAX_RETIRED,
  retiredPtys,
  retirePty,
  viewedRetired,
  viewRetired,
} from './retiredTerminals'

describe('retired terminals', () => {
  afterEach(() => forgetRetired('s1'))

  it('keeps the last 2 per agent and hands back the older ones to dispose', () => {
    expect(MAX_RETIRED).toBe(2)
    expect(retirePty('s1', 'claude-1', 'p1')).toEqual([])
    expect(retirePty('s1', 'claude-1', 'p2')).toEqual([])
    viewRetired('s1', 'claude-1', 'p1')
    expect(retirePty('s1', 'claude-1', 'p3')).toEqual(['p1'])
    expect(retirePty('s1', 'claude-1', 'p4')).toEqual(['p2'])
    expect(retiredPtys('s1', 'claude-1')).toEqual(['p3', 'p4'])
    // A dropped terminal is never left on screen.
    expect(viewedRetired('s1', 'claude-1')).toBeNull()
    // The same PTY twice is not a new entry, and other agents keep their own.
    expect(retirePty('s1', 'claude-1', 'p4')).toEqual([])
    expect(retirePty('s1', 'claude-2', 'q1')).toEqual([])
    expect(retiredPtys('s1', 'claude-2')).toEqual(['q1'])
  })
})
