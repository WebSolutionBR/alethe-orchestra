import { describe, expect, it } from 'vitest'

import type { MirrorLine, MirrorPalette, TerminalMirror } from '../../lib/terminalMirror'
import { fixedLayout, WrapIndex, wrappedHeight } from './layout'

const PALETTE: MirrorPalette = { foreground: '#fff', background: '#000', ansi: [] }

/** Just enough of a mirror for the wrap index: plain text lines. */
function fakeMirror(texts: string[], extra: Partial<TerminalMirror> = {}) {
  let lines = [...texts]
  let trimmed = 0
  let reads = 0
  const mirror = {
    ptyId: 'p',
    cols: 20,
    rows: 2,
    bufferType: 'normal' as const,
    get length() {
      return lines.length
    },
    get baseY() {
      return Math.max(0, lines.length - 2)
    },
    cursor: { x: 0, y: 0, visible: false },
    modes: { applicationCursorKeys: false, bracketedPaste: false, mouseTracking: 'none' as const },
    exited: false,
    get trimmed() {
      return trimmed
    },
    getLines(start: number, end: number): MirrorLine[] {
      reads += end - start
      return lines.slice(start, end).map((text, offset) => ({
        index: start + offset,
        wrapped: false,
        runs: text
          ? [
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
            ]
          : [],
      }))
    },
    getText: () => '',
    search: () => [],
    onChange: () => () => {},
    resize: () => {},
    ...extra,
  }
  return {
    mirror: mirror as TerminalMirror,
    push(text: string) {
      lines.push(text)
    },
    trim(count: number) {
      lines = lines.slice(count)
      trimmed += count
    },
    set(index: number, text: string) {
      lines[index] = text
    },
    get reads() {
      return reads
    },
  }
}

describe('fixedLayout', () => {
  it('maps every line to one row', () => {
    const layout = fixedLayout(5, 80)
    expect(layout.total).toBe(5)
    expect(layout.rowOf(3)).toBe(3)
    expect(layout.heightOf(3)).toBe(1)
    expect(layout.lineAt(9)).toBe(4)
    expect(layout.sliceCols).toBe(80)
  })
})

describe('WrapIndex', () => {
  it('gives wide lines as many rows as their content needs', () => {
    expect(wrappedHeight(0, 8)).toBe(1)
    expect(wrappedHeight(8, 8)).toBe(1)
    expect(wrappedHeight(9, 8)).toBe(2)
    const fake = fakeMirror(['short', 'x'.repeat(17), '', 'tail'])
    const layout = new WrapIndex().update(fake.mirror, PALETTE, 8)
    expect(layout.total).toBe(1 + 3 + 1 + 1)
    expect(layout.rowOf(1)).toBe(1)
    expect(layout.rowOf(2)).toBe(4)
    expect(layout.lineAt(0)).toBe(0)
    expect(layout.lineAt(3)).toBe(1)
    expect(layout.lineAt(4)).toBe(2)
    expect(layout.lineAt(5)).toBe(3)
  })

  it('only rereads the screen and new lines on later updates', () => {
    const fake = fakeMirror(['a'.repeat(10), 'b', 'c', 'd'])
    const index = new WrapIndex()
    index.update(fake.mirror, PALETTE, 8)
    const before = fake.reads
    fake.push('e'.repeat(9))
    const layout = index.update(fake.mirror, PALETTE, 8)
    // Old screen (lines 2-3) plus the new line, not the whole buffer.
    expect(fake.reads - before).toBe(3)
    expect(layout.total).toBe(2 + 1 + 1 + 1 + 2)
  })

  it('drops the heights of lines trimmed off the top', () => {
    const fake = fakeMirror(['a'.repeat(10), 'b', 'c', 'd'])
    const index = new WrapIndex()
    index.update(fake.mirror, PALETTE, 8)
    fake.trim(1)
    fake.push('e')
    const layout = index.update(fake.mirror, PALETTE, 8)
    expect(layout.total).toBe(4)
    expect(layout.heightOf(0)).toBe(1)
  })

  it('rebuilds when the width changes', () => {
    const fake = fakeMirror(['x'.repeat(12)])
    const index = new WrapIndex()
    expect(index.update(fake.mirror, PALETTE, 8).total).toBe(2)
    expect(index.update(fake.mirror, PALETTE, 4).total).toBe(3)
  })

  it('keeps the cursor on a row even past the written cells', () => {
    const fake = fakeMirror(['ab'], { cursor: { x: 9, y: 0, visible: true } })
    expect(new WrapIndex().update(fake.mirror, PALETTE, 8).heightOf(0)).toBe(2)
  })
})
