import { describe, expect, it } from 'vitest'

import {
  chunkByCodePoint,
  clipLine,
  deliveredUpTo,
  deliveryProbe,
  notificationKind,
  sanitizeRelay,
} from './relay'

describe('sanitizeRelay', () => {
  it('keeps text, tabs and line breaks', () => {
    expect(sanitizeRelay('a\tb\r\nc\rd\ne')).toBe('a\tb\nc\nd\ne')
  })

  it('drops ESC and other controls, so a relay can neither end the paste nor press keys', () => {
    expect(sanitizeRelay('x\x1b[201~y\x07\x00z\x7f\x9bw')).toBe('x[201~yzw')
  })
})

describe('chunkByCodePoint', () => {
  it('splits long text without cutting a surrogate pair', () => {
    const text = `${'a'.repeat(5)}😀${'b'.repeat(3)}`
    const chunks = chunkByCodePoint(text, 6)
    expect(chunks.join('')).toBe(text)
    expect(chunks).toEqual(['aaaaa', '😀bbb'])
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(6)
  })

  it('returns nothing for empty text', () => {
    expect(chunkByCodePoint('')).toEqual([])
  })
})

describe('delivery probes', () => {
  const probes = [
    deliveryProbe('[orchestra · from claude-1] first message'),
    deliveryProbe('second\n  message'),
  ]

  it('finds the newest message the prompt shows', () => {
    expect(deliveredUpTo(probes, 'second message')).toBe(1)
    expect(deliveredUpTo(probes, '[orchestra · from claude-1] first message')).toBe(0)
  })

  it('ignores prompts the user typed', () => {
    expect(deliveredUpTo(probes, 'something else')).toBe(-1)
    expect(deliveredUpTo(probes, undefined)).toBe(-1)
  })
})

describe('notificationKind', () => {
  it('reads the notification type of current Claude Code builds', () => {
    expect(notificationKind({ notification_type: 'permission_prompt' })).toBe('permission')
    expect(notificationKind({ notification_type: 'idle_prompt' })).toBe('idle')
    expect(notificationKind({ notification_type: 'elicitation_dialog' })).toBe('question')
    expect(notificationKind({ notification_type: 'auth_success' })).toBe('info')
  })

  it('falls back to the message, and treats the unknown as a question', () => {
    expect(notificationKind({ message: 'Claude is waiting for your input' })).toBe('idle')
    expect(notificationKind({ message: 'Claude needs your permission to use Bash' })).toBe(
      'permission',
    )
    expect(notificationKind({ message: 'Pick a file' })).toBe('question')
  })
})

describe('clipLine', () => {
  it('collapses whitespace and clips with an ellipsis', () => {
    expect(clipLine('a\n  b')).toBe('a b')
    expect(clipLine('abcdef', 4)).toBe('abc…')
  })
})
