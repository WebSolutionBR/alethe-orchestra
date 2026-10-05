import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mirror } from './mirror'
import type { MirrorPalette } from './types'

vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

const PALETTE: MirrorPalette = {
  foreground: '#f0f0f0',
  background: '#101010',
  ansi: Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`),
}

const mirrors: Mirror[] = []

function mirror(cols = 40, rows = 10, scrollback = 100): Mirror {
  const created = new Mirror('test', { cols, rows, scrollback })
  mirrors.push(created)
  return created
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

afterEach(() => {
  for (const created of mirrors.splice(0)) created.dispose()
})

describe('Mirror parsing', () => {
  it('parses each chunk before feed returns', () => {
    const m = mirror()
    m.feed('hello')
    expect(m.getText(0, 1)).toBe('hello')
    expect(m.cursor).toEqual({ x: 5, y: 0, visible: true })
  })

  it('keeps the blanks the ConPTY skips with CHA as spaces', () => {
    const m = mirror()
    m.feed('\x1b[2GAccessing\x1b[12Gworkspace:')
    expect(m.getText(0, 1)).toBe(' Accessing workspace:')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line.runs.map((run) => run.text).join('')).toBe(' Accessing workspace:')
    expect(line.runs.reduce((sum, run) => sum + run.cells, 0)).toBe(21)
  })
})

describe('Mirror.getLines', () => {
  it('groups cells into runs and resolves 16, 256 and truecolor', () => {
    const m = mirror()
    m.feed('\x1b[31mred\x1b[0m \x1b[38;5;196mx\x1b[38;2;1;2;3my\x1b[48;5;232mz\x1b[0m')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line).toMatchObject({ index: 0, wrapped: false })
    expect(line.runs.map((run) => [run.text, run.fg, run.bg])).toEqual([
      ['red', PALETTE.ansi[1], null],
      [' ', null, null],
      ['x', '#ff0000', null],
      ['y', '#010203', null],
      ['z', '#010203', '#080808'],
    ])
  })

  it('applies inverse, including the default colors', () => {
    const m = mirror()
    m.feed('\x1b[7mz\x1b[0m\x1b[7;31;42mw')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line.runs[0]).toMatchObject({
      text: 'z',
      fg: PALETTE.background,
      bg: PALETTE.foreground,
    })
    expect(line.runs[1]).toMatchObject({ text: 'w', fg: PALETTE.ansi[2], bg: PALETTE.ansi[1] })
  })

  it('draws bold ANSI 0-7 in the bright slot, like xterm', () => {
    const m = mirror()
    m.feed('\x1b[1;32mB\x1b[0m\x1b[1;38;5;100mC')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line.runs[0]).toMatchObject({ text: 'B', fg: PALETTE.ansi[10], bold: true })
    expect(line.runs[1]).toMatchObject({ text: 'C', fg: '#878700', bold: true })
  })

  it('reports the text style flags', () => {
    const m = mirror()
    m.feed('\x1b[2;3;4;9mq\x1b[0m\x1b[8ms')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line.runs[0]).toMatchObject({
      text: 'q',
      bold: false,
      dim: true,
      italic: true,
      underline: true,
      strike: true,
      invisible: false,
    })
    expect(line.runs[1]).toMatchObject({ text: 's', invisible: true, dim: false })
  })

  it('gives each wide character a run of its own', () => {
    const m = mirror()
    m.feed('ab中文c')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line.runs.map((run) => [run.text, run.cells])).toEqual([
      ['ab', 2],
      ['中', 2],
      ['文', 2],
      ['c', 1],
    ])
  })

  it('uses Unicode 11 widths like XTermView', () => {
    const m = mirror()
    m.feed('😀x')
    const [line] = m.getLines(0, 1, PALETTE)
    expect(line.runs.map((run) => [run.text, run.cells])).toEqual([
      ['😀', 2],
      ['x', 1],
    ])
  })

  it('drops never-written trailing cells but keeps cells erased with a background', () => {
    const m = mirror(12, 4)
    m.feed('ab\r\n\x1b[44m\x1b[K\x1b[0m')
    const [plain, painted] = m.getLines(0, 2, PALETTE)
    expect(plain.runs).toHaveLength(1)
    expect(plain.runs[0].cells).toBe(2)
    expect(painted.runs).toEqual([
      expect.objectContaining({ text: ' '.repeat(12), cells: 12, bg: PALETTE.ansi[4] }),
    ])
  })

  it('marks soft-wrapped rows and clamps the range', () => {
    const m = mirror(5, 4)
    m.feed('abcdefg')
    const lines = m.getLines(-3, 99, PALETTE)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({ index: 0, wrapped: false })
    expect(lines[1]).toMatchObject({ index: 1, wrapped: true })
    expect(lines[1].runs[0].text).toBe('fg')
    expect(m.getLines(3, 1, PALETTE)).toEqual([])
  })

  it('reads 200 rows of 200 colored cells in a few milliseconds', () => {
    const m = mirror(200, 200, 0)
    let screen = ''
    for (let row = 0; row < 200; row++) {
      let text = ''
      for (let col = 0; col < 200; col += 10)
        text += `\x1b[3${(row + col) % 8}m${'x'.repeat(9)}\x1b[0m `
      screen += text + (row < 199 ? '\r\n' : '')
    }
    m.feed(screen)
    m.getLines(0, 200, PALETTE)
    const started = performance.now()
    const lines = m.getLines(0, 200, PALETTE)
    const elapsed = performance.now() - started
    expect(lines).toHaveLength(200)
    expect(lines[0].runs.length).toBeGreaterThan(30)
    // Generous bound for slow CI machines; a desktop takes a few ms.
    expect(elapsed).toBeLessThan(100)
  })
})

describe('Mirror.getText', () => {
  it('joins soft-wrapped rows, keeping the spaces at the wrap point', () => {
    const m = mirror(5, 6)
    m.feed('abcd efgh\r\nxyz  \r\n')
    expect(m.getText(0, 3)).toBe('abcd efgh\nxyz')
  })

  it('only joins the rows inside the range', () => {
    const m = mirror(5, 6)
    m.feed('abcdefghij\r\nxyz')
    expect(m.getText(1, 3)).toBe('fghij\nxyz')
    expect(m.getText(0, 1)).toBe('abcde')
  })

  it('does not insert a space where a wide character did not fit', () => {
    const m = mirror(5, 4)
    m.feed('abcd中')
    expect(m.getLines(1, 2, PALETTE)[0].wrapped).toBe(true)
    expect(m.getText(0, 2)).toBe('abcd中')
  })
})

describe('Mirror.search', () => {
  it('finds text case-insensitively by default, in cells', () => {
    const m = mirror()
    m.feed('Hello hello\r\nHELLO')
    expect(m.search('hello')).toEqual([
      { line: 0, start: 0, end: 5 },
      { line: 0, start: 6, end: 11 },
      { line: 1, start: 0, end: 5 },
    ])
    expect(m.search('hello', { caseSensitive: true })).toEqual([{ line: 0, start: 6, end: 11 }])
  })

  it('supports regex and ignores invalid patterns', () => {
    const m = mirror()
    m.feed('error 42 and error 7')
    expect(m.search('error \\d+', { regex: true })).toEqual([
      { line: 0, start: 0, end: 8 },
      { line: 0, start: 13, end: 20 },
    ])
    expect(m.search('(', { regex: true })).toEqual([])
    expect(m.search('(')).toEqual([])
    expect(m.search('')).toEqual([])
  })

  it('reports a match that crosses a soft wrap from its first row', () => {
    const m = mirror(10, 4)
    m.feed('hello world')
    expect(m.search('world')).toEqual([{ line: 0, start: 6, end: 11 }])
    m.feed('\r\nxxxxxxxxxxxxxxworld')
    expect(m.search('world')[1]).toEqual({ line: 3, start: 4, end: 9 })
  })

  it('counts wide characters as two cells', () => {
    const m = mirror()
    m.feed('a中b 😀c')
    expect(m.search('b')).toEqual([{ line: 0, start: 3, end: 4 }])
    expect(m.search('中b')).toEqual([{ line: 0, start: 1, end: 4 }])
    expect(m.search('c')).toEqual([{ line: 0, start: 7, end: 8 }])
  })
})

describe('Mirror state', () => {
  it('exposes the modes the program set', () => {
    const m = mirror()
    expect(m.modes).toEqual({
      applicationCursorKeys: false,
      bracketedPaste: false,
      mouseTracking: 'none',
      mouseEncoding: 'default',
    })
    m.feed('\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h')
    expect(m.modes).toEqual({
      applicationCursorKeys: true,
      bracketedPaste: true,
      mouseTracking: 'vt200',
      mouseEncoding: 'sgr',
    })
    m.feed('\x1b[?1003h\x1b[?1006l')
    expect(m.modes).toMatchObject({ mouseTracking: 'any', mouseEncoding: 'default' })
  })

  it('tracks the cursor, its visibility and the alternate buffer', () => {
    const m = mirror(20, 5)
    m.feed('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix')
    expect(m.length).toBe(6)
    expect(m.baseY).toBe(1)
    expect(m.cursor).toEqual({ x: 3, y: 5, visible: true })
    m.feed('\x1b[?25l')
    expect(m.cursor.visible).toBe(false)
    m.feed('\x1b[?1049h\x1b[3;4H')
    expect(m.bufferType).toBe('alternate')
    expect(m.length).toBe(5)
    expect(m.baseY).toBe(0)
    expect(m.cursor).toMatchObject({ x: 3, y: 2 })
    m.feed('\x1b[?1049l')
    expect(m.bufferType).toBe('normal')
    expect(m.getText(0, 6)).toBe('one\ntwo\nthree\nfour\nfive\nsix')
  })

  it('draws a pending-wrap cursor on the last column', () => {
    const m = mirror(4, 3)
    m.feed('abcd')
    expect(m.cursor.x).toBe(3)
  })

  it('counts the lines dropped from the top of a full scrollback', () => {
    const m = mirror(10, 3, 5)
    m.feed(Array.from({ length: 20 }, (_, i) => `L${i}`).join('\r\n'))
    expect(m.length).toBe(8)
    expect(m.trimmed).toBe(12)
    expect(m.getText(0, 1)).toBe('L12')
    m.feed('\x1b[3J')
    expect(m.trimmed).toBe(17)
    // A full reset replaces the buffer: every old line counts as dropped, and counting goes on.
    m.feed('\x1bc')
    expect(m.trimmed).toBe(20)
    expect(m.getText(0, m.length)).toBe('\n\n')
    m.feed(Array.from({ length: 10 }, (_, i) => `N${i}`).join('\r\n'))
    expect(m.trimmed).toBe(22)
    expect(m.getText(0, 1)).toBe('N2')
  })

  it('flags an exit, and clears it when a restarted PTY streams again', () => {
    const m = mirror()
    m.markExited('restarted')
    expect(m.exited).toBe(false)
    m.markExited('exited')
    expect(m.exited).toBe(true)
    m.feed('again')
    expect(m.exited).toBe(false)
  })

  it('resizes with reflow and ignores no-op sizes', () => {
    const m = mirror(5, 4)
    // Like XTermView (reflowCursorLine off), the row holding the cursor is left to the program.
    m.feed('abcdefgh\r\n')
    m.resize(10, 4)
    expect(m.cols).toBe(10)
    expect(m.getLines(0, 1, PALETTE)[0].runs[0].text).toBe('abcdefgh')
    expect(m.getText(0, m.length)).toBe('abcdefgh\n\n\n')
    m.resize(0, 0)
    expect([m.cols, m.rows]).toEqual([2, 1])
  })
})

describe('Mirror.onChange', () => {
  it('coalesces writes, resizes and buffer switches into one call per frame', async () => {
    const m = mirror()
    const listener = vi.fn()
    const stop = m.onChange(listener)
    m.feed('a')
    m.feed('b')
    m.resize(30, 8)
    m.feed('\x1b[?1049h')
    expect(listener).not.toHaveBeenCalled()
    await nextFrame()
    expect(listener).toHaveBeenCalledTimes(1)
    m.markExited('exited')
    await nextFrame()
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    m.feed('c')
    await nextFrame()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying and ignores input after dispose', async () => {
    const m = new Mirror('disposed', { cols: 10, rows: 3 })
    const listener = vi.fn()
    m.onChange(listener)
    m.feed('x')
    m.dispose()
    m.feed('y')
    m.resize(20, 5)
    await nextFrame()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('Mirror.seed', () => {
  it('replays the recording once, before the chunks that streamed meanwhile', async () => {
    const m = mirror()
    let release: (value: string) => void = () => {}
    const recorded = new Promise<string>((resolve) => {
      release = resolve
    })
    const seeding = m.seed(() => recorded)
    m.feed(' live')
    expect(m.getText(0, 1)).toBe('')
    release('recorded')
    await seeding
    expect(m.getText(0, 1)).toBe('recorded live')
    const again = vi.fn(async () => 'twice')
    await m.seed(again)
    expect(again).not.toHaveBeenCalled()
  })

  it('leaves a mirror that already has output alone and survives a failed fetch', async () => {
    const busy = mirror()
    busy.feed('own')
    const fetch = vi.fn(async () => 'recorded')
    await busy.seed(fetch)
    expect(fetch).not.toHaveBeenCalled()

    const failing = mirror()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seeding = failing.seed(async () => {
      throw new Error('gone')
    })
    failing.feed('after')
    await seeding
    expect(failing.getText(0, 1)).toBe('after')
  })
})
