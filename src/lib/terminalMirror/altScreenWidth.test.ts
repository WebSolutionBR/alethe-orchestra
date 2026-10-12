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

const ROWS = 10
const FOOTER = ['────────────', '❯ type here', '────────────']

const mirrors: Mirror[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const created of mirrors.splice(0)) created.dispose()
})

function mirror(cols: number, rows = ROWS): Mirror {
  const created = new Mirror('alt-width', { cols, rows, scrollback: 500 })
  mirrors.push(created)
  created.feed('\x1b[?1049h\x1b[2J\x1b[H')
  return created
}

function paint(rows: string[]): string {
  let out = '\x1b[?25l\x1b[H'
  rows.forEach((text, row) => {
    out += `\x1b[${row + 1};1H${text}\x1b[K`
  })
  return `${out}\x1b[${rows.length - 1};3H\x1b[?25h`
}

function chat(lines: string[], last: number, rows = ROWS): string[] {
  const height = rows - FOOTER.length
  const visible = lines.slice(Math.max(0, last - height), last)
  return [...Array(height - visible.length).fill(''), ...visible, ...FOOTER]
}

function cellsOf(line: { runs: { cells: number }[] }): number {
  return line.runs.reduce((total, run) => total + run.cells, 0)
}

describe('captured history at another width (T2)', () => {
  // 32 cells each: drawn at 40 columns, too wide for a 20-column pane.
  const WIDE = Array.from(
    { length: 30 },
    (_, i) => `row ${String(i).padStart(2, '0')} abcdefghij KLMNOPQRST xyz`,
  )

  it('wraps rows captured wider than the screen instead of cutting them', () => {
    const m = mirror(40)
    for (let last = 1; last <= 20; last++) m.feed(paint(chat(WIDE, last)))
    const before = m.getText(0, m.baseY).split('\n')
    expect(before.slice(0, 3)).toEqual(WIDE.slice(0, 3))

    m.resize(20, ROWS)
    m.feed(
      paint(
        chat(
          WIDE.map((line) => line.slice(0, 20)),
          20,
        ),
      ),
    )
    const lines = m.getLines(0, m.baseY, PALETTE)
    for (const line of lines) expect(cellsOf(line)).toBeLessThanOrEqual(20)
    // The second half of a captured row continues it as a soft wrap.
    expect(lines[0].wrapped).toBe(false)
    expect(lines[1].wrapped).toBe(true)
    // Copying joins the halves back: nothing was lost.
    expect(m.getText(0, m.baseY).split('\n').slice(0, 3)).toEqual(WIDE.slice(0, 3))
  })

  it('finds matches on the row and column where the wrapped history shows them', () => {
    const m = mirror(40)
    for (let last = 1; last <= 20; last++) m.feed(paint(chat(WIDE, last)))
    m.resize(20, ROWS)
    m.feed(
      paint(
        chat(
          WIDE.map((line) => line.slice(0, 20)),
          20,
        ),
      ),
    )
    const found = m.search('KLMNOPQRST')
    const first = found[0]
    // "row 00 abcdefghij " is 18 cells, so the match starts on the first row at column 18 and
    // runs into the next one; the next match belongs to the following captured row.
    expect(first).toEqual({ line: 0, start: 18, end: 28 })
    expect(m.getText(first.line, first.line + 2)).toContain('KLMNOPQRST')
    expect(found[1].line).toBe(2)
    const xyz = m.search('xyz')[0]
    expect(xyz).toEqual({ line: 1, start: 9, end: 12 })
    expect(m.getText(1, 2)).toBe('MNOPQRST xyz')
  })

  it('moves a wide character that would straddle the edge to the next row', () => {
    const m = mirror(40)
    const line = `${'a'.repeat(19)}界${'b'.repeat(10)}`
    const lines = [line, ...Array.from({ length: 12 }, (_, i) => `filler ${i}`)]
    for (let last = 1; last <= lines.length; last++) m.feed(paint(chat(lines, last)))
    m.resize(20, ROWS)
    m.feed(paint(chat(lines, lines.length)))
    const rows = m.getLines(0, 2, PALETTE)
    expect(cellsOf(rows[0])).toBe(19)
    expect(rows[1].wrapped).toBe(true)
    expect(rows[1].runs[0].text).toBe('界')
    expect(m.getText(0, 2)).toBe(line)
  })

  it('keeps the trimmed count monotonic in display rows', () => {
    const m = new Mirror('alt-width-cap', { cols: 40, rows: ROWS, scrollback: 6 })
    mirrors.push(m)
    m.feed('\x1b[?1049h\x1b[2J\x1b[H')
    for (let last = 1; last <= 12; last++) m.feed(paint(chat(WIDE, last)))
    m.resize(20, ROWS)
    m.feed(
      paint(
        chat(
          WIDE.map((line) => line.slice(0, 20)),
          12,
        ),
      ),
    )
    let previous = m.trimmed
    for (let last = 13; last <= 25; last++) {
      m.feed(
        paint(
          chat(
            WIDE.map((line) => line.slice(0, 20)),
            last,
          ),
        ),
      )
      expect(m.trimmed).toBeGreaterThanOrEqual(previous)
      previous = m.trimmed
    }
    expect(m.length - m.baseY).toBe(ROWS)
  })
})

describe('capture between a resize and the redraw (T5)', () => {
  const CONVERSATION = Array.from({ length: 60 }, (_, i) => `message ${String(i).padStart(2, '0')}`)

  function history(stalePending: boolean): string[] {
    const m = mirror(40)
    for (let last = 1; last <= 20; last++) m.feed(paint(chat(CONVERSATION, last)))
    vi.advanceTimersByTime(500)
    // Output right before the resize leaves a capture scheduled.
    if (stalePending) m.feed('\x1b[1;1H')
    m.resize(30, 14)
    // The capture fires while the screen still holds the old frame at the new size.
    vi.advanceTimersByTime(500)
    // At the new size the program lays everything out again: rows indented, a wider status line,
    // and older messages shown again on top of the taller screen.
    const footer = ['─'.repeat(30), '❯ type here', '─'.repeat(30)]
    for (let last = 20; last <= 40; last++) {
      const body = CONVERSATION.slice(last - 11, last).map((line) => `  ${line}`)
      m.feed(paint([...body, ...footer]))
      vi.advanceTimersByTime(20)
    }
    vi.advanceTimersByTime(500)
    return m.getText(0, m.baseY).split('\n')
  }

  it('does not keep the stale screen a pending capture sees before the program redraws', () => {
    vi.useFakeTimers()
    const kept = history(true)
    expect(kept).toEqual(history(false))
    const names = kept.map((line) => line.trim()).filter(Boolean)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(CONVERSATION.slice(0, names.length))
    expect(names.length).toBeGreaterThanOrEqual(28)
  })
})
