import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AUTO_WAIT_STORAGE_KEY,
  readAutoWaitOnLimit,
  resetAutoWaitMemory,
  writeAutoWaitOnLimit,
} from './limitPrefs'

afterEach(() => {
  localStorage.removeItem(AUTO_WAIT_STORAGE_KEY)
  resetAutoWaitMemory()
})

describe('auto wait on the usage limit', () => {
  it('is on for "One account" and off for spreading until the user chooses', () => {
    expect(readAutoWaitOnLimit('single')).toBe(true)
    expect(readAutoWaitOnLimit('spread')).toBe(false)
  })
  it('keeps the choice for every policy', () => {
    writeAutoWaitOnLimit(false)
    expect(readAutoWaitOnLimit('single')).toBe(false)
    writeAutoWaitOnLimit(true)
    expect(readAutoWaitOnLimit('spread')).toBe(true)
  })
  it('reads the choice from memory first, even when storage fails', () => {
    writeAutoWaitOnLimit(false)
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readAutoWaitOnLimit('single')).toBe(false)
    expect(get).not.toHaveBeenCalled()
    get.mockRestore()
  })
})
