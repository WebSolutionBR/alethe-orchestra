import { describe, expect, it } from 'vitest'

import type { MirrorLine, MirrorPalette, TerminalMirror } from '../../lib/terminalMirror'
import { fullRow, LineCache } from './lineCache'

const PALETTE: MirrorPalette = { foreground: '#fff', background: '#000', ansi: [] }

/** A buffer of `count` lines whose last `rows` are the screen; reads are recorded. */
function fakeMirror(count: number, rows: number) {
  const state = { trimmed: 0, count, bufferType: 'normal' as 'normal' | 'alternate', cols: 80 }
  const reads: Array<[number, number]> = []
  const label = new Map<number, string>()
  const mirror = {
    ptyId: 'p',
    get cols() {
      return state.cols
    },
    rows,
    get bufferType() {
      return state.bufferType
    },
    get length() {
      return state.count
    },
    get baseY() {
      return Math.max(0, state.count - rows)
    },
    cursor: { x: 0, y: 0, visible: true },
    modes: { applicationCursorKeys: false, bracketedPaste: false, mouseTracking: 'none' as const },
    exited: false,
    get trimmed() {
      return state.trimmed
    },
    getLines(start: number, end: number): MirrorLine[] {
      reads.push([start, end])
      const lines: MirrorLine[] = []
      for (let index = start; index < end; index += 1) {
        const text = label.get(index + state.trimmed) ?? `line ${index + state.trimmed}`
        lines.push({
          index,
          wrapped: false,
          runs: [
            {
              text,
              cells: text.length,
              fg: null,
              bg: null,
              bold: false,
              dim: false,
              italic: false,
              underline: false,
              strike: false,
              invisible: false,
            },
          ],
        })
      }
      return lines
    },
    getText: () => '',
    search: () => [],
    onChange: () => () => {},
    resize: () => {},
  }
  return { mirror: mirror as TerminalMirror, state, reads, label }
}

const texts = (lines: MirrorLine[]) => lines.map((line) => line.runs[0]?.text)

describe('LineCache', () => {
  it('fetches scrollback lines once and the screen every time', () => {
    const fake = fakeMirror(100, 10)
    const cache = new LineCache()
    cache.read(fake.mirror, PALETTE, 70, 100)
    expect(fake.reads).toEqual([
      [70, 90],
      [90, 100],
    ])
    fake.reads.length = 0
    const again = cache.read(fake.mirror, PALETTE, 70, 100)
    expect(fake.reads).toEqual([[90, 100]])
    expect(texts(again)).toEqual(Array.from({ length: 30 }, (_, index) => `line ${70 + index}`))
  })

  it('shifts the cached lines when the top of the scrollback is trimmed', () => {
    const fake = fakeMirror(100, 10)
    const cache = new LineCache()
    cache.read(fake.mirror, PALETTE, 70, 100)
    fake.state.trimmed = 3
    fake.reads.length = 0
    const lines = cache.read(fake.mirror, PALETTE, 70, 100)
    // Lines 70-86 were cached as 73-89; only the new tail of the scrollback and the screen are read.
    expect(fake.reads).toEqual([
      [87, 90],
      [90, 100],
    ])
    expect(lines.map((line) => line.index)).toEqual(Array.from({ length: 30 }, (_, i) => 70 + i))
    expect(texts(lines)[0]).toBe('line 73')
  })

  it('starts over for another width, buffer or palette', () => {
    const fake = fakeMirror(100, 10)
    const cache = new LineCache()
    cache.read(fake.mirror, PALETTE, 70, 100)
    fake.state.cols = 120
    fake.reads.length = 0
    cache.read(fake.mirror, PALETTE, 70, 100)
    expect(fake.reads).toEqual([
      [70, 90],
      [90, 100],
    ])
    fake.reads.length = 0
    cache.read(fake.mirror, { ...PALETTE }, 70, 100)
    expect(fake.reads[0]).toEqual([70, 90])
    fake.state.bufferType = 'alternate'
    fake.reads.length = 0
    cache.read(fake.mirror, { ...PALETTE }, 0, 10)
    expect(fake.reads).toEqual([[0, 10]])
  })

  it('segments a line once per line object', () => {
    const fake = fakeMirror(10, 10)
    const [line] = fake.mirror.getLines(0, 1, PALETTE)
    const first = fullRow(line)
    expect(fullRow(line)).toBe(first)
    expect(first.runs[0].segments[0].text).toBe('line 0')
  })
})
