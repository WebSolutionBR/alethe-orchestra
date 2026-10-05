import type { MirrorPalette, TerminalMirror } from '../../lib/terminalMirror'
import { usedCells } from './cells'

/**
 * Maps mirror lines to the fixed-height visual rows the view stacks. Without soft wrap every line is
 * one row; with it, a line wider than the box takes as many rows as its content needs.
 */
export type RowLayout = {
  /** Visual rows in total. */
  readonly total: number
  /** Cells per visual row. */
  readonly sliceCols: number
  /** First visual row of a line. */
  rowOf(line: number): number
  /** Visual rows a line takes (at least 1). */
  heightOf(line: number): number
  /** Line drawn on a visual row (clamped to the buffer). */
  lineAt(row: number): number
}

export function fixedLayout(length: number, cols: number): RowLayout {
  const total = Math.max(0, length)
  return {
    total,
    sliceCols: Math.max(1, cols),
    rowOf: (line) => line,
    heightOf: () => 1,
    lineAt: (row) => Math.max(0, Math.min(total - 1, row)),
  }
}

/** Visual rows of a line that shows `cells` cells in rows of `sliceCols`. */
export function wrappedHeight(cells: number, sliceCols: number): number {
  return Math.max(1, Math.ceil(cells / Math.max(1, sliceCols)))
}

/**
 * Soft-wrap table over the whole active buffer, kept up to date incrementally: scrollback lines
 * never change in place, so after the first build only the screen, the new lines and the lines
 * trimmed off the top (`mirror.trimmed`) need work. A new width or buffer rebuilds it.
 */
export class WrapIndex {
  private heights: number[] = []
  private prefix = new Int32Array(1)
  private key = ''
  private trimmed = 0
  private baseY = 0

  update(mirror: TerminalMirror, palette: MirrorPalette, sliceCols: number): RowLayout {
    const width = Math.max(1, sliceCols)
    const key = `${width}:${mirror.cols}:${mirror.bufferType}`
    const length = Math.max(0, mirror.length)
    let from: number
    if (key !== this.key) {
      this.key = key
      this.heights = []
      from = 0
    } else {
      const dropped = Math.max(0, mirror.trimmed - this.trimmed)
      if (dropped > 0) this.heights.splice(0, Math.min(dropped, this.heights.length))
      from = Math.max(0, Math.min(this.baseY - dropped, mirror.baseY, this.heights.length))
    }
    this.trimmed = mirror.trimmed
    this.baseY = mirror.baseY
    this.heights.length = Math.min(this.heights.length, from)
    if (from < length) {
      const cursor = mirror.cursor
      const lines = mirror.getLines(from, length, palette)
      for (let index = 0; index < length - from; index += 1) {
        const line = lines[index]
        let cells = line ? usedCells(line) : 0
        // Keep the cursor on the row it is drawn on, even past the last written cell.
        if (cursor.visible && cursor.y === from + index) cells = Math.max(cells, cursor.x + 1)
        this.heights.push(wrappedHeight(cells, width))
      }
    }
    this.heights.length = length
    this.prefix = new Int32Array(length + 1)
    for (let index = 0; index < length; index += 1) {
      this.prefix[index + 1] = this.prefix[index] + (this.heights[index] ?? 1)
    }
    return this.layout(width)
  }

  /** Forgets everything; the next update rebuilds the table. */
  reset(): void {
    this.key = ''
    this.heights = []
    this.prefix = new Int32Array(1)
  }

  private layout(sliceCols: number): RowLayout {
    const prefix = this.prefix
    const heights = this.heights
    const length = prefix.length - 1
    const total = prefix[length]
    return {
      total,
      sliceCols,
      rowOf: (line) => prefix[Math.max(0, Math.min(length, line))],
      heightOf: (line) => heights[line] ?? 1,
      lineAt: (row) => {
        if (length === 0) return 0
        let low = 0
        let high = length - 1
        while (low < high) {
          const mid = (low + high + 1) >> 1
          if (prefix[mid] <= row) low = mid
          else high = mid - 1
        }
        return low
      },
    }
  }
}
