import type { IBufferCell, IBufferLine } from '@xterm/xterm'

import { contentEnd } from './lines'

/** One screen row as captured: its trimmed text (to compare frames) and a detached copy. */
export type FrameRow = { text: string; line: IBufferLine }

/**
 * Filled rows the previous screen needs before a frame with nothing in common counts as replaced.
 * Below that it is a sparse screen edited in place (a spinner under an empty conversation).
 */
const MIN_REPLACED_ROWS = 3
/** Shortest row content (whitespace removed) trusted as an anchor when matching across a resize. */
const ANCHOR_CHARS = 12
/** History rows a resized screen is matched against. */
const COVER_WINDOW = 400
/** Filled rows of a new frame looked up in the history to recognize a jump back. */
const LOCATE_BLOCK = 3
/** How far back the history is searched for that block. */
const LOCATE_WINDOW = 5_000

function filled(text: string): boolean {
  return text.trim().length > 0
}

/** Row content without whitespace: the same text wrapped at another width compares equal. */
function compact(text: string): string {
  return text.replace(/\s+/g, '')
}

export type FrameMove = {
  /** Positive = content moved up (rows left through the top), negative = down, 0 = none found. */
  shift: number
  /** How many filled rows line up at that shift. */
  score: number
  /** Rows above the footer both frames share (prompt box, status line). */
  region: number
  /** Filled rows of the region that did not move. */
  still: number
}

/**
 * How the content moved between two frames. The footer both frames share is set aside first, so a
 * fixed prompt box or status line never outweighs the scrolling area above it. Only filled rows
 * count; `shift` is the best vertical offset, `score` the filled rows it lines up.
 */
export function compareFrames(previous: string[], next: string[]): FrameMove {
  const rows = Math.min(previous.length, next.length)
  let footer = 0
  while (footer < rows && previous[rows - 1 - footer] === next[rows - 1 - footer]) footer++
  const region = rows - footer
  // Compare small integers instead of strings in the quadratic part.
  const ids = new Map<string, number>()
  const id = (text: string) => {
    if (!filled(text)) return -1
    let value = ids.get(text)
    if (value === undefined) {
      value = ids.size
      ids.set(text, value)
    }
    return value
  }
  const before = previous.slice(0, region).map(id)
  const after = next.slice(0, region).map(id)
  let still = 0
  for (let i = 0; i < region; i++) if (before[i] >= 0 && before[i] === after[i]) still++
  let shift = 0
  let score = 0
  for (let k = 1; k < region; k++) {
    let up = 0
    let down = 0
    for (let i = 0; i + k < region; i++) {
      if (before[i + k] >= 0 && before[i + k] === after[i]) up++
      if (before[i] >= 0 && before[i] === after[i + k]) down++
    }
    if (up > score) {
      score = up
      shift = k
    }
    if (down > score) {
      score = down
      shift = -k
    }
  }
  return { shift, score, region, still }
}

/** Whether a move is clear enough to call scrolling (more rows line up than stayed in place). */
function isScroll(move: FrameMove, previous: string[]): boolean {
  const filledRows = previous.slice(0, move.region).filter(filled).length
  const needed = filledRows >= 6 ? 3 : 2
  return move.shift !== 0 && move.score >= needed && move.score > move.still
}

/** The shift two frames agree on, or 0 when the evidence is too thin to call it scrolling. */
export function detectShift(previous: string[], next: string[]): number {
  const move = compareFrames(previous, next)
  return isScroll(move, previous) ? move.shift : 0
}

/**
 * The scrollback a full-screen program never gives the terminal. Programs on the alternate screen
 * (Claude Code included, through ConPTY) repaint rows in place instead of scrolling, so the rows
 * that leave through the top are recovered by comparing consecutive frames.
 *
 * `debt` counts the rows at the top of the screen that are already in the history: content that
 * moved down (the program scrolled its own view up, or a block above it collapsed) and that must not
 * be appended again when it moves back up.
 */
export class AltScreenHistory {
  private readonly rows: IBufferLine[] = []
  private readonly texts: string[] = []
  private frame: FrameRow[] | null = null
  /** The screen as it was before a resize, matched against the first frame drawn after it. */
  private beforeResizeFrame: FrameRow[] | null = null
  private debt = 0
  private droppedRows = 0
  /**
   * The rows as they are shown at today's width: a row captured wider than the screen is cut into
   * soft-wrapped pieces, as a terminal would wrap it. `starts[i]` is the first display row of row i
   * (`starts[length]` = display rows in total) and `pieces[i]` its cut points (null = one piece).
   */
  private width = 0
  private cell: IBufferCell | null = null
  private starts: number[] = [0]
  private pieces: (number[] | null)[] = []
  private viewCache = new Map<number, IBufferLine>()
  private droppedDisplay = 0

  constructor(private readonly cap: number) {}

  /**
   * The width the rows are shown at (the screen's columns), with a scratch cell to read them. Cuts
   * every row again; called on creation and on each resize.
   */
  setWidth(cols: number, cell: IBufferCell): void {
    this.cell = cell
    if (cols === this.width) return
    this.width = cols
    this.starts = [0]
    this.pieces = []
    this.viewCache.clear()
    for (const row of this.rows) this.layOut(row)
  }

  /** Rows as shown at today's width (see setWidth). */
  get displayLength(): number {
    return this.starts[this.starts.length - 1]
  }

  /** Display rows dropped from the front. Monotonic, counted at the width they were dropped at. */
  get droppedDisplayRows(): number {
    return this.droppedDisplay
  }

  /** First display row of history row `index` (`index` = length gives the total). */
  displayIndex(index: number): number {
    return this.starts[Math.max(0, Math.min(this.rows.length, index))]
  }

  /** One display row: a whole history row, or one piece of a row wider than the screen. */
  displayLine(index: number): IBufferLine | undefined {
    if (index < 0 || index >= this.displayLength) return undefined
    const cached = this.viewCache.get(index)
    if (cached) return cached
    let low = 0
    let high = this.rows.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.starts[mid] <= index) low = mid
      else high = mid - 1
    }
    const row = this.rows[low]
    const cuts = this.pieces[low]
    if (!cuts) return row
    const piece = index - this.starts[low]
    const view = pieceOf(row, cuts[piece], cuts[piece + 1], piece > 0)
    this.viewCache.set(index, view)
    return view
  }

  get length(): number {
    return this.rows.length
  }

  /** Rows dropped from the front once the history reached its cap. Monotonic. */
  get dropped(): number {
    return this.droppedRows
  }

  line(index: number): IBufferLine | undefined {
    return this.rows[index]
  }

  textAt(index: number): string | undefined {
    return this.texts[index]
  }

  /** The last frame compared, so unchanged rows can reuse their copy. */
  get lastFrame(): readonly FrameRow[] | null {
    return this.frame
  }

  capture(next: FrameRow[]): void {
    const previous = this.frame
    this.frame = next
    if (!previous) {
      const resized = this.beforeResizeFrame
      this.beforeResizeFrame = null
      if (resized) this.realign(resized, next)
      return
    }
    if (previous.length !== next.length) return
    const before = previous.map((row) => row.text)
    const after = next.map((row) => row.text)
    const move = compareFrames(before, after)
    if (isScroll(move, before)) {
      if (move.shift > 0) this.scrolledUp(previous, move.shift)
      // Can exceed a screen: scrolling up page after page owes everything passed on the way.
      else this.debt = Math.min(this.rows.length, this.debt - move.shift)
      return
    }
    // Nothing of the scrolling area stayed in place: the screen was replaced, not edited.
    if (move.still > 0) return
    if (before.slice(0, move.region).filter(filled).length < MIN_REPLACED_ROWS) return
    if (move.shift > 0 && move.score > 0) {
      // A burst that pushed almost everything out: the few rows left still line up.
      this.scrolledUp(previous, move.shift)
      return
    }
    this.replaced(previous, next, move.region)
  }

  /** The screen is about to be wiped (clear, leaving the alternate screen, reset): keep it. */
  flush(): void {
    const frame = this.frame
    this.frame = null
    if (frame) {
      const end = lastFilled(frame, frame.length) + 1
      this.append(frame.slice(Math.min(this.debt, end), end))
    }
    this.debt = 0
  }

  /** A new alternate screen session: the next frame starts from nothing. */
  restart(): void {
    this.frame = null
    this.beforeResizeFrame = null
    this.debt = 0
  }

  /**
   * The terminal is about to change size. The program will redraw at the new width, so rows can
   * neither be compared row by row nor matched as text; `realign` matches their content instead.
   */
  resizing(): void {
    if (this.frame) this.beforeResizeFrame = this.frame
    this.frame = null
  }

  /**
   * First frame after a resize. Content is compared without whitespace, which survives re-wrapping:
   * rows of the old screen whose content is no longer visible were pushed out and are kept, and rows
   * at the top of the new screen that the history already ends with become the debt.
   */
  private realign(old: FrameRow[], next: FrameRow[]): void {
    const visible = next.map((row) => compact(row.text)).join('')
    const from = Math.min(this.debt, old.length)
    let firstVisible = -1
    for (let i = from; i < old.length; i++) {
      if (!filled(old[i].text)) continue
      const anchor = anchorFrom(old, i)
      if (anchor && visible.includes(anchor)) {
        firstVisible = i
        break
      }
    }
    // Nothing recognizable survived: treat the old screen as replaced.
    const end = firstVisible >= 0 ? firstVisible : lastFilled(old, old.length) + 1
    this.append(old.slice(from, end))
    this.debt = this.coveredRows(next)
  }

  /**
   * How many rows at the top of a frame repeat the end of the history (a taller screen shows again
   * what had already scrolled out). The covered rows must continue each other and reach the very
   * end of the history; a row that runs past it is left to be kept when it scrolls out.
   */
  private coveredRows(next: FrameRow[]): number {
    const tail = this.texts.slice(-COVER_WINDOW).map(compact).join('')
    if (!tail) return 0
    const first = next.findIndex((row) => filled(row.text))
    if (first < 0) return 0
    const anchor = anchorFrom(next, first)
    const at = anchor ? tail.lastIndexOf(anchor) : -1
    if (!anchor || at < 0) return 0
    let cursor = at
    let covered = first
    for (let i = first; i < next.length; i++) {
      const piece = compact(next[i].text)
      if (piece && !tail.startsWith(piece, cursor)) {
        // Re-wrapped, a row can hold the end of the history and what followed it on screen.
        if (piece.startsWith(tail.slice(cursor))) cursor = tail.length
        break
      }
      cursor += piece.length
      covered = i + 1
    }
    return cursor === tail.length ? covered : 0
  }

  private scrolledUp(previous: FrameRow[], shift: number): void {
    const known = Math.min(this.debt, shift)
    this.debt -= known
    this.append(previous.slice(known, shift))
  }

  /**
   * A frame with nothing in common with the previous one above their shared footer. Either the
   * program jumped back to content the history already has, or new content replaced the screen at
   * once; then the rows of the previous screen that never scrolled out are kept.
   */
  private replaced(previous: FrameRow[], next: FrameRow[], region: number): void {
    const at = this.locate(next)
    if (at !== null) {
      // Every history row from the screen's top onward will scroll past again.
      this.debt = Math.max(0, this.rows.length - at)
      return
    }
    const end = lastFilled(previous, region) + 1
    this.append(previous.slice(Math.min(this.debt, end), end))
    this.debt = 0
  }

  /** History index where the new frame's first row would sit, when the frame shows old content. */
  private locate(next: FrameRow[]): number | null {
    const start = next.findIndex((row) => filled(row.text))
    if (start < 0 || start + LOCATE_BLOCK > next.length) return null
    const block = next.slice(start, start + LOCATE_BLOCK).map((row) => row.text)
    if (!block.every(filled)) return null
    const floor = Math.max(0, this.texts.length - LOCATE_WINDOW)
    for (let j = this.texts.length - LOCATE_BLOCK; j >= floor; j--) {
      if (block.every((text, q) => this.texts[j + q] === text)) return j - start
    }
    return null
  }

  private append(rows: FrameRow[]): void {
    if (rows.length === 0) return
    for (const row of rows) {
      // Blank rows only separate content: none at the start and never two in a row, which also
      // keeps the empty part of a screen still filling up (or a sparse one) out of the history.
      if (!filled(row.text) && !filled(this.texts[this.texts.length - 1] ?? '')) continue
      this.rows.push(row.line)
      this.texts.push(row.text)
      this.layOut(row.line)
    }
    const excess = this.rows.length - this.cap
    if (excess > 0) {
      this.rows.splice(0, excess)
      this.texts.splice(0, excess)
      this.droppedRows += excess
      const shift = this.starts[excess]
      this.starts = this.starts.slice(excess).map((start) => start - shift)
      this.pieces.splice(0, excess)
      this.viewCache.clear()
      this.droppedDisplay += shift
    }
  }

  /** Adds a row to the display table (see setWidth). */
  private layOut(line: IBufferLine): void {
    const cuts = this.width > 0 && this.cell ? cutPoints(line, this.width, this.cell) : null
    this.pieces.push(cuts)
    this.starts.push(this.displayLength + (cuts ? cuts.length - 1 : 1))
  }
}

/**
 * Content (whitespace removed) of the rows from `start` on, just long enough to be trusted as an
 * anchor; null when the frame runs out first.
 */
function anchorFrom(frame: FrameRow[], start: number): string | null {
  let content = ''
  for (let i = start; i < frame.length && content.length < ANCHOR_CHARS; i++) {
    content += compact(frame[i].text)
  }
  return content.length >= ANCHOR_CHARS ? content : null
}

/** Index of the last filled row before `end`, or -1. */
function lastFilled(frame: FrameRow[], end: number): number {
  for (let i = Math.min(end, frame.length) - 1; i >= 0; i--) if (filled(frame[i].text)) return i
  return -1
}

/**
 * Where a row captured wider than `cols` is cut to show it at that width, ending with its content
 * end; null when it fits. A wide character that would straddle the edge moves to the next piece,
 * as a terminal wraps it.
 */
function cutPoints(line: IBufferLine, cols: number, cell: IBufferCell): number[] | null {
  if (line.length <= cols) return null
  const end = contentEnd(line, cell)
  if (end <= cols) return null
  const cuts = [0]
  let from = 0
  while (end - from > cols) {
    let next = from + cols
    if (line.getCell(next - 1, cell)?.getWidth() === 2 && next - 1 > from) next--
    cuts.push(next)
    from = next
  }
  cuts.push(end)
  return cuts
}

/** Cells [from, to) of a row as a line of their own; later pieces continue it as a soft wrap. */
function pieceOf(line: IBufferLine, from: number, to: number, wrapped: boolean): IBufferLine {
  const length = to - from
  return {
    isWrapped: wrapped,
    length,
    getCell: (x, cell) => (x < 0 || x >= length ? undefined : line.getCell(from + x, cell)),
    translateToString: (trimRight, startColumn = 0, endColumn = length) =>
      line.translateToString(
        trimRight,
        from + Math.max(0, Math.min(length, startColumn)),
        from + Math.max(0, Math.min(length, endColumn)),
      ),
  }
}
