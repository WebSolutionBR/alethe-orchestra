import { describe, expect, it, vi } from 'vitest'

import { claimSize, isSizeOwner, joinSizeOwners, onSizeOwnerChange } from './sizeOwners'

describe('size ownership', () => {
  it('gives the PTY to the first view, then to whoever claims it', () => {
    const first = Symbol('first')
    const second = Symbol('second')
    const leaveFirst = joinSizeOwners('pty-a', first, false)
    const leaveSecond = joinSizeOwners('pty-a', second, false)
    expect(isSizeOwner('pty-a', first)).toBe(true)
    expect(isSizeOwner('pty-a', second)).toBe(false)

    claimSize('pty-a', second)
    expect(isSizeOwner('pty-a', second)).toBe(true)
    expect(isSizeOwner('pty-a', first)).toBe(false)

    leaveSecond()
    expect(isSizeOwner('pty-a', first)).toBe(true)
    leaveFirst()
    expect(isSizeOwner('pty-a', first)).toBe(false)
  })

  it('notifies listeners when the owner changes', () => {
    const listener = vi.fn()
    const off = onSizeOwnerChange('pty-b', listener)
    const a = Symbol('a')
    const b = Symbol('b')
    const leaveA = joinSizeOwners('pty-b', a, false)
    const leaveB = joinSizeOwners('pty-b', b, false)
    listener.mockClear()
    claimSize('pty-b', b)
    expect(listener).toHaveBeenCalledTimes(1)
    claimSize('pty-b', b)
    expect(listener).toHaveBeenCalledTimes(1)
    leaveA()
    expect(listener).toHaveBeenCalledTimes(1)
    leaveB()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })

  it('keeps PTYs independent', () => {
    const a = Symbol('a')
    const b = Symbol('b')
    const leaveA = joinSizeOwners('pty-c', a, false)
    const leaveB = joinSizeOwners('pty-d', b, false)
    expect(isSizeOwner('pty-c', a)).toBe(true)
    expect(isSizeOwner('pty-d', b)).toBe(true)
    leaveA()
    leaveB()
  })
})
