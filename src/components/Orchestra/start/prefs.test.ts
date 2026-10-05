import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AUTONOMOUS_ON_START,
  clearGoalDraft,
  goalDraftKey,
  readGoalDraft,
  writeGoalDraft,
} from './prefs'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('start screen preferences', () => {
  it('opens autonomous, as the owner decided', () => {
    expect(AUTONOMOUS_ON_START).toBe(true)
  })

  it('keeps one goal draft per project', () => {
    writeGoalDraft('a', 'ship the scribe')
    writeGoalDraft('b', 'fix the terminal')
    expect(readGoalDraft('a')).toBe('ship the scribe')
    expect(readGoalDraft('b')).toBe('fix the terminal')
    expect(readGoalDraft(null)).toBe('')
  })

  it('removes the key for an empty or cleared draft', () => {
    writeGoalDraft('a', 'draft')
    writeGoalDraft('a', '   ')
    expect(localStorage.getItem(goalDraftKey('a'))).toBeNull()
    writeGoalDraft('a', 'draft')
    clearGoalDraft('a')
    expect(readGoalDraft('a')).toBe('')
  })

  it('tolerates storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(readGoalDraft('a')).toBe('')
    expect(() => writeGoalDraft('a', 'x')).not.toThrow()
  })
})
