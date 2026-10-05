import type { MirrorLine, MirrorPalette, TerminalMirror } from '../../lib/terminalMirror'
import { type RowRun, rowRuns, rowSignature } from './cells'

/**
 * Lines above the screen never change in place — a program can only draw on the screen — so the
 * view fetches each scrollback line once and keeps reusing it while streaming output only touches
 * the screen. A new width, buffer or palette starts over; lines trimmed off the top shift the cache.
 */
export class LineCache {
  private mirror: TerminalMirror | null = null
  private palette: MirrorPalette | null = null
  private key = ''
  private trimmed = 0
  private frozen = new Map<number, MirrorLine>()

  read(mirror: TerminalMirror, palette: MirrorPalette, start: number, end: number): MirrorLine[] {
    const key = `${mirror.cols}:${mirror.bufferType}`
    if (mirror !== this.mirror || palette !== this.palette || key !== this.key) {
      this.mirror = mirror
      this.palette = palette
      this.key = key
      this.trimmed = mirror.trimmed
      this.frozen = new Map()
    } else if (mirror.trimmed !== this.trimmed) {
      const shift = mirror.trimmed - this.trimmed
      this.trimmed = mirror.trimmed
      const next = new Map<number, MirrorLine>()
      if (shift > 0) {
        for (const [index, line] of this.frozen) {
          const moved = index - shift
          if (moved >= 0) next.set(moved, { ...line, index: moved })
        }
      }
      this.frozen = next
    }

    const lines: MirrorLine[] = []
    const frozenEnd = mirror.bufferType === 'normal' ? Math.min(end, mirror.baseY) : start
    let index = start
    while (index < frozenEnd) {
      const cached = this.frozen.get(index)
      if (cached) {
        lines.push(cached)
        index += 1
        continue
      }
      let missingEnd = index + 1
      while (missingEnd < frozenEnd && !this.frozen.has(missingEnd)) missingEnd += 1
      for (const line of mirror.getLines(index, missingEnd, palette)) {
        this.frozen.set(line.index, line)
        lines.push(line)
      }
      index = missingEnd
    }
    if (index < end) lines.push(...mirror.getLines(index, end, palette))

    // Keep only what is near the window; the rest is cheap to fetch again.
    const span = end - start
    if (this.frozen.size > span * 4 + 256) {
      for (const cachedIndex of [...this.frozen.keys()]) {
        if (cachedIndex < start - span * 2 || cachedIndex >= end + span * 2) {
          this.frozen.delete(cachedIndex)
        }
      }
    }
    return lines
  }
}

const fullRows = new WeakMap<MirrorLine, { runs: RowRun[]; signature: string }>()

/** Runs and signature of a whole line, computed once per line object. */
export function fullRow(line: MirrorLine): { runs: RowRun[]; signature: string } {
  let entry = fullRows.get(line)
  if (!entry) {
    const runs = rowRuns(line)
    entry = { runs, signature: rowSignature(runs) }
    fullRows.set(line, entry)
  }
  return entry
}
