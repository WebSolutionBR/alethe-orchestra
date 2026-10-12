import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mirror } from './mirror'
import { pendingEscape } from './pendingEscape'

vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

const mirrors: Mirror[] = []

afterEach(() => {
  for (const created of mirrors.splice(0)) created.dispose()
})

function mirror(): Mirror {
  const created = new Mirror('pending', { cols: 40, rows: 6, scrollback: 50 })
  mirrors.push(created)
  return created
}

describe('pendingEscape', () => {
  it('keeps the start of a sequence the stream ends in', () => {
    expect(pendingEscape('', 'text\x1b')).toBe('\x1b')
    expect(pendingEscape('', 'text\x1b[38;5')).toBe('\x1b[38;5')
    expect(pendingEscape('', 'a\x1b]0;tit')).toBe('\x1b]0;tit')
    expect(pendingEscape('', 'a\x1b(')).toBe('\x1b(')
    expect(pendingEscape('\x1b[3', '8;5')).toBe('\x1b[38;5')
    expect(pendingEscape('\x1b]0;ti', 'tle')).toBe('\x1b]0;title')
  })

  it('is empty between sequences', () => {
    expect(pendingEscape('', 'plain')).toBe('')
    expect(pendingEscape('', '\x1b[31mred\x1b[0m')).toBe('')
    expect(pendingEscape('', '\x1b]0;title\x07after')).toBe('')
    expect(pendingEscape('', '\x1b(B')).toBe('')
    expect(pendingEscape('\x1b[3', '1mred')).toBe('')
    expect(pendingEscape('\x1bP1$r', '\x1b\\')).toBe('')
  })
})

describe('restoring from a mirror cut inside an escape sequence (T7)', () => {
  it('parses the rest of the sequence instead of printing it', () => {
    const source = mirror()
    source.feed('before \x1b[3')
    const snapshot = source.serialize()
    expect(snapshot?.endsWith('\x1b[3')).toBe(true)
    // A classic terminal restored from the snapshot, then the next live chunk.
    const view = mirror()
    view.feed(snapshot!)
    view.feed('1mred\x1b[0m after')
    source.feed('1mred\x1b[0m after')
    expect(view.getText(0, 1)).toBe('before red after')
    expect(source.getText(0, 1)).toBe('before red after')
  })

  it('adds nothing when the stream ends between sequences', () => {
    const source = mirror()
    source.feed('done\x1b[0m')
    const view = mirror()
    view.feed(source.serialize()!)
    view.feed(' next')
    expect(view.getText(0, 1)).toBe('done next')
  })
})
