import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearTerminalSizes,
  forgetTerminalSize,
  getTerminalSize,
  rememberTerminalSize,
} from './terminalSizes'

describe('terminalSizes', () => {
  beforeEach(() => {
    clearTerminalSizes()
  })

  it('reports nothing for a pty that never resized', () => {
    expect(getTerminalSize('pty-1')).toBeNull()
  })

  it('keeps the last geometry a pty reported', () => {
    rememberTerminalSize('pty-1', 80, 24)
    rememberTerminalSize('pty-1', 231, 57)
    expect(getTerminalSize('pty-1')).toEqual({ cols: 231, rows: 57 })
  })

  it('keeps panes apart', () => {
    rememberTerminalSize('pty-1', 231, 57)
    rememberTerminalSize('pty-2', 96, 30)
    expect(getTerminalSize('pty-1')).toEqual({ cols: 231, rows: 57 })
    expect(getTerminalSize('pty-2')).toEqual({ cols: 96, rows: 30 })
  })

  it('ignores sizes that cannot be laid out', () => {
    rememberTerminalSize('pty-1', 231, 57)
    rememberTerminalSize('pty-1', 0, 57)
    rememberTerminalSize('pty-1', 231, -4)
    rememberTerminalSize('pty-1', Number.NaN, 57)
    expect(getTerminalSize('pty-1')).toEqual({ cols: 231, rows: 57 })
  })

  it('ignores an empty pty id', () => {
    rememberTerminalSize('', 231, 57)
    expect(getTerminalSize('')).toBeNull()
  })

  it('floors fractional dimensions', () => {
    rememberTerminalSize('pty-1', 230.8, 56.2)
    expect(getTerminalSize('pty-1')).toEqual({ cols: 230, rows: 56 })
  })

  it('drops a pty once it is forgotten', () => {
    rememberTerminalSize('pty-1', 231, 57)
    forgetTerminalSize('pty-1')
    expect(getTerminalSize('pty-1')).toBeNull()
  })
})
