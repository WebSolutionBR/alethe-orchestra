import { describe, expect, it } from 'vitest'

import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  shouldScrollHostScrollback,
} from './terminalInput'

describe('normalizePastedText', () => {
  it('converts clipboard newlines to PTY carriage returns', () => {
    expect(normalizePastedText('one\r\ntwo\nthree\r')).toBe('one\rtwo\rthree\r')
  })
})

describe('getWheelScrollLines', () => {
  it('always scrolls at least one line for pixel wheel events', () => {
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: 1 }, 18)).toBe(1)
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: -1 }, 18)).toBe(-1)
  })

  it('preserves larger wheel intent across delta modes', () => {
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: 40 }, 20)).toBe(2)
    expect(getWheelScrollLines({ deltaMode: 1, deltaY: 3 }, 20)).toBe(3)
    expect(getWheelScrollLines({ deltaMode: 2, deltaY: -1 }, 20)).toBe(-10)
  })

  it('reads a Windows Shift+wheel, which arrives as a sideways scroll, as lines', () => {
    // Chromium on Windows turns Shift+wheel into deltaX with no deltaY.
    expect(getWheelScrollLines({ deltaMode: 1, deltaY: 0, deltaX: -3, shiftKey: true }, 20)).toBe(
      -3,
    )
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: 0, deltaX: 40, shiftKey: true }, 20)).toBe(2)
    // Without Shift a sideways scroll is not a vertical one.
    expect(getWheelScrollLines({ deltaMode: 1, deltaY: 0, deltaX: -3 }, 20)).toBe(0)
  })
})

describe('getTerminalScrollbackRows', () => {
  it('keeps enough rows for long agent chats', () => {
    expect(getTerminalScrollbackRows()).toBeGreaterThanOrEqual(10_000)
  })

  it('scales live buffers to the configured memory budget', () => {
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 1536 })).toBe(6_000)
    expect(getTerminalScrollbackRows({ agent: false, memoryBudgetMb: 1536 })).toBe(3_000)
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 4096 })).toBe(10_000)
  })
})

describe('shouldScrollHostScrollback', () => {
  it('scrolls the host buffer in a plain shell', () => {
    expect(shouldScrollHostScrollback('normal', false)).toBe(true)
  })

  it('forwards the wheel to TUIs in the alternate buffer', () => {
    // claude/codex run in the alternate screen (no host scrollback) — let the app scroll itself.
    expect(shouldScrollHostScrollback('alternate', false)).toBe(false)
  })

  it('lets Shift+wheel force host scrollback even in the alternate buffer', () => {
    expect(shouldScrollHostScrollback('alternate', true)).toBe(true)
    expect(shouldScrollHostScrollback('normal', true)).toBe(true)
  })

  it('hands the wheel to a program that tracks the mouse, in either buffer', () => {
    // A restored full-screen agent that tracks the mouse must get the wheel as mouse
    // reports; scrolling the view's own history instead left the agent unscrollable.
    expect(shouldScrollHostScrollback('normal', false, 'any')).toBe(false)
    expect(shouldScrollHostScrollback('normal', false, 'vt200')).toBe(false)
    expect(shouldScrollHostScrollback('alternate', false, 'drag')).toBe(false)
  })

  it('treats X10 tracking as no tracking, since it never reports the wheel', () => {
    expect(shouldScrollHostScrollback('normal', false, 'x10')).toBe(true)
    expect(shouldScrollHostScrollback('alternate', false, 'x10')).toBe(false)
  })

  it('keeps Shift+wheel on the history over a program that tracks the mouse', () => {
    expect(shouldScrollHostScrollback('normal', true, 'any')).toBe(true)
    expect(shouldScrollHostScrollback('alternate', true, 'any')).toBe(true)
  })
})

describe('formatDroppedPaths', () => {
  it('leaves space-free paths unquoted with a trailing space', () => {
    expect(formatDroppedPaths(['C:\\a\\b.txt'])).toBe('C:\\a\\b.txt ')
  })

  it('quotes paths containing whitespace', () => {
    expect(formatDroppedPaths(['C:\\meu path\\f.txt'])).toBe('"C:\\meu path\\f.txt" ')
  })

  it('joins multiple paths, quoting only those with spaces', () => {
    expect(formatDroppedPaths(['C:\\a.txt', 'C:\\my dir\\b.txt'])).toBe(
      'C:\\a.txt "C:\\my dir\\b.txt" ',
    )
  })

  it('returns empty string when no valid paths', () => {
    expect(formatDroppedPaths([])).toBe('')
    expect(formatDroppedPaths(['', ''])).toBe('')
  })
})
