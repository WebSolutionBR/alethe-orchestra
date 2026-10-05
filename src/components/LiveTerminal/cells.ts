import type { MirrorLine, MirrorRun, MirrorSearchMatch } from '../../lib/terminalMirror'

/** A piece of a run laid out on the cell grid. */
export type Segment = {
  text: string
  /** First cell of the segment inside its mirror line. */
  cell: number
  /** Cells it covers (a wide char counts 2). */
  cells: number
  /**
   * Boxed segments get an explicit width of `cells` cells. Plain ones hold only glyphs every
   * terminal font draws at exactly one cell, so the font advance keeps them on the grid; anything
   * else (symbols, emoji, CJK, combining marks) falls back to another font with its own advance and
   * would push the rest of the row sideways.
   */
  boxed: boolean
}

export type RowRun = { run: MirrorRun; segments: Segment[] }

export type CellPoint = { line: number; cell: number }

export type CellRange = { line: number; start: number; end: number }

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x200b && cp <= 0x200d) ||
    cp === 0x2060 ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
}

/** ASCII, Latin-1 (minus the soft hyphen, which renders as nothing), Latin Extended-A, box drawing and block elements. */
function isGridSafe(cp: number): boolean {
  return (
    (cp >= 0x20 && cp <= 0x7e) ||
    (cp >= 0xa0 && cp <= 0x17f && cp !== 0xad) ||
    (cp >= 0x2500 && cp <= 0x259f)
  )
}

/** Splits text into cell units: one base code point plus the zero-width marks that ride on it. */
function cellUnits(text: string): string[] {
  const units: string[] = []
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (units.length > 0 && isZeroWidth(cp)) units[units.length - 1] += char
    else units.push(char)
  }
  return units
}

/** Lays one run out on the grid, starting at `startCell`. */
export function runSegments(run: MirrorRun, startCell: number): Segment[] {
  const units = cellUnits(run.text)
  if (units.length === 0 || run.cells <= 0) return []
  // A wide char arrives in a run of its own (2 cells); any other mismatch is boxed whole so the
  // cells after it still land where the program put them.
  if (units.length !== run.cells) {
    return [{ text: run.text, cell: startCell, cells: run.cells, boxed: true }]
  }
  const segments: Segment[] = []
  let plain = ''
  let plainStart = startCell
  let cell = startCell
  for (const unit of units) {
    if (unit.length === 1 && isGridSafe(unit.charCodeAt(0))) {
      if (!plain) plainStart = cell
      plain += unit
    } else {
      if (plain) {
        segments.push({ text: plain, cell: plainStart, cells: plain.length, boxed: false })
        plain = ''
      }
      segments.push({ text: unit, cell, cells: 1, boxed: true })
    }
    cell += 1
  }
  if (plain) segments.push({ text: plain, cell: plainStart, cells: plain.length, boxed: false })
  return segments
}

function clipSegment(segment: Segment, from: number, to: number): Segment | null {
  if (segment.boxed) return segment.cell >= from && segment.cell < to ? segment : null
  const start = Math.max(segment.cell, from)
  const end = Math.min(segment.cell + segment.cells, to)
  if (start >= end) return null
  if (start === segment.cell && end === segment.cell + segment.cells) return segment
  return {
    text: segment.text.slice(start - segment.cell, end - segment.cell),
    cell: start,
    cells: end - start,
    boxed: false,
  }
}

/** The runs of a line that fall in the cells [from, to); a box belongs to the slice its first cell is in. */
export function rowRuns(line: MirrorLine, from = 0, to = Number.POSITIVE_INFINITY): RowRun[] {
  const out: RowRun[] = []
  let cell = 0
  for (const run of line.runs) {
    const runStart = cell
    cell += run.cells
    if (cell <= from) continue
    if (runStart >= to) break
    const segments: Segment[] = []
    for (const segment of runSegments(run, runStart)) {
      const clipped = clipSegment(segment, from, to)
      if (clipped) segments.push(clipped)
    }
    if (segments.length > 0) out.push({ run, segments })
  }
  return out
}

/** Cells a line's runs cover (trailing never-written cells are not part of the runs). */
export function lineCells(line: MirrorLine): number {
  let cells = 0
  for (const run of line.runs) cells += run.cells
  return cells
}

/**
 * Cells up to the last one that shows something: trailing spaces count only when they carry a
 * background, an underline or a strike line.
 */
export function usedCells(line: MirrorLine): number {
  let cells = lineCells(line)
  for (let index = line.runs.length - 1; index >= 0; index -= 1) {
    const run = line.runs[index]
    if (run.bg !== null || run.underline || run.strike) return cells
    const trailing = run.text.length - run.text.replace(/ +$/, '').length
    if (trailing < run.text.length) return cells - trailing
    cells -= run.cells
  }
  return 0
}

/** Text of the cells [from, to) of a line. */
export function lineText(line: MirrorLine, from = 0, to = Number.POSITIVE_INFINITY): string {
  let text = ''
  for (const { segments } of rowRuns(line, from, to)) {
    for (const segment of segments) text += segment.text
  }
  return text
}

/**
 * Copy text between two cell points (`to` exclusive), the way terminals copy: soft-wrapped rows are
 * joined without a break and trailing spaces are dropped at the end of every logical line.
 * `lines` must cover `from.line` to `to.line`; lines outside that span are ignored.
 */
export function selectionText(lines: MirrorLine[], from: CellPoint, to: CellPoint): string {
  const span = lines.filter((line) => line.index >= from.line && line.index <= to.line)
  let out = ''
  span.forEach((line, index) => {
    const last = index === span.length - 1
    const piece = lineText(
      line,
      line.index === from.line ? from.cell : 0,
      line.index === to.line ? to.cell : undefined,
    )
    const joinsNext = !last && span[index + 1].wrapped
    out += joinsNext ? piece : piece.replace(/ +$/, '')
    if (!last && !joinsNext) out += '\n'
  })
  return out
}

/** Clipboard flavor of copied text: no non-breaking spaces, and CRLF on Windows like xterm.js. */
export function clipboardText(text: string, windows: boolean): string {
  const plain = text.replace(/\xa0/g, ' ')
  return windows ? plain.replace(/\r?\n/g, '\r\n') : plain
}

/** Joined text of consecutive rows (a logical line) with the cell each UTF-16 unit sits on. */
export type LogicalText = {
  text: string
  /** Per UTF-16 unit of `text`: mirror line, first cell and the cell after it. */
  at: Array<{ line: number; cell: number; end: number }>
}

export function logicalText(lines: MirrorLine[]): LogicalText {
  let text = ''
  const at: LogicalText['at'] = []
  for (const line of lines) {
    for (const { segments } of rowRuns(line)) {
      for (const segment of segments) {
        text += segment.text
        if (segment.boxed) {
          for (let index = 0; index < segment.text.length; index += 1) {
            at.push({ line: line.index, cell: segment.cell, end: segment.cell + segment.cells })
          }
        } else {
          for (let index = 0; index < segment.text.length; index += 1) {
            const cell = segment.cell + index
            at.push({ line: line.index, cell, end: cell + 1 })
          }
        }
      }
    }
  }
  return { text, at }
}

/** Per-line cell ranges covered by the UTF-16 units [start, end) of a logical text. */
export function textRanges(logical: LogicalText, start: number, end: number): CellRange[] {
  const ranges: CellRange[] = []
  for (let index = start; index < end && index < logical.at.length; index += 1) {
    const unit = logical.at[index]
    const last = ranges[ranges.length - 1]
    if (last && last.line === unit.line) {
      last.start = Math.min(last.start, unit.cell)
      last.end = Math.max(last.end, unit.end)
    } else {
      ranges.push({ line: unit.line, start: unit.cell, end: unit.end })
    }
  }
  return ranges
}

/** Index of the UTF-16 unit drawn on (line, cell), or -1. */
export function unitAt(logical: LogicalText, point: CellPoint): number {
  return logical.at.findIndex(
    (unit) => unit.line === point.line && point.cell >= unit.cell && point.cell < unit.end,
  )
}

/** A search match split into one range per row; cell k of a match lies on line + floor(k / cols). */
export function matchRanges(match: MirrorSearchMatch, cols: number): CellRange[] {
  const width = Math.max(1, cols)
  const ranges: CellRange[] = []
  let cell = match.start
  while (cell < match.end) {
    const line = match.line + Math.floor(cell / width)
    const start = cell % width
    const end = Math.min(width, start + (match.end - cell))
    ranges.push({ line, start, end })
    cell += end - start
  }
  return ranges
}

/** First index whose match ends on or after `line` (matches sorted by line, then start). */
export function firstMatchFrom(matches: MirrorSearchMatch[], line: number, cols: number): number {
  const width = Math.max(1, cols)
  let low = 0
  let high = matches.length
  while (low < high) {
    const mid = (low + high) >> 1
    const match = matches[mid]
    const lastLine = match.line + Math.floor(Math.max(0, match.end - 1) / width)
    if (lastLine < line) low = mid + 1
    else high = mid
  }
  return low
}

/** Stable string of what a row shows, so unchanged rows skip React's reconciliation. */
export function rowSignature(runs: RowRun[]): string {
  let signature = ''
  for (const { run, segments } of runs) {
    signature += `${run.fg ?? ''}\u0001${run.bg ?? ''}\u0001${styleFlags(run)}\u0001`
    for (const segment of segments) {
      signature += `${segment.cell}\u0003${segment.boxed ? segment.cells : 0}\u0003${segment.text}\u0004`
    }
    signature += '\u0002'
  }
  return signature
}

export function styleFlags(run: MirrorRun): string {
  return `${run.bold ? 'b' : ''}${run.dim ? 'd' : ''}${run.italic ? 'i' : ''}${run.underline ? 'u' : ''}${run.strike ? 's' : ''}${run.invisible ? 'h' : ''}`
}
