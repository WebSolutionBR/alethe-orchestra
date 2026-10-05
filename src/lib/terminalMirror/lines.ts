import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'

import { COLOR_MODE_P16, COLOR_MODE_P256, paletteTable, resolveColor } from './colors'
import type {
  MirrorLine,
  MirrorPalette,
  MirrorRun,
  MirrorSearchMatch,
  MirrorSearchOptions,
} from './types'

const FLAG_BOLD = 1
const FLAG_DIM = 2
const FLAG_ITALIC = 4
const FLAG_UNDERLINE = 8
const FLAG_STRIKE = 16
const FLAG_INVISIBLE = 32
const FLAG_INVERSE = 64

/** What the readers need from a buffer: the live xterm buffer, or captured history plus screen. */
export type LineSource = Pick<IBuffer, 'length' | 'getLine'>

/** Upper bound for `search`, so a one-letter query over a full scrollback stays cheap. */
export const MAX_SEARCH_MATCHES = 10_000

function cellFlags(cell: IBufferCell): number {
  return (
    (cell.isBold() ? FLAG_BOLD : 0) |
    (cell.isDim() ? FLAG_DIM : 0) |
    (cell.isItalic() ? FLAG_ITALIC : 0) |
    (cell.isUnderline() ? FLAG_UNDERLINE : 0) |
    (cell.isStrikethrough() ? FLAG_STRIKE : 0) |
    (cell.isInvisible() ? FLAG_INVISIBLE : 0) |
    (cell.isInverse() ? FLAG_INVERSE : 0)
  )
}

/**
 * End (exclusive) of the cells worth showing: trailing cells that were never written and carry no
 * attribute are dropped. Cells erased with a background color are kept.
 */
export function contentEnd(line: IBufferLine, cell: IBufferCell): number {
  let end = line.length
  while (end > 0) {
    line.getCell(end - 1, cell)
    if (cell.getCode() !== 0 || !cell.isAttributeDefault()) break
    end--
  }
  return end
}

function makeRun(
  text: string,
  cells: number,
  fgMode: number,
  fg: number,
  bgMode: number,
  bg: number,
  flags: number,
  palette: MirrorPalette,
  table: string[],
): MirrorRun {
  const inverse = (flags & FLAG_INVERSE) !== 0
  let fMode = fgMode
  let fValue = fg
  let bMode = bgMode
  let bValue = bg
  if (inverse) {
    fMode = bgMode
    fValue = bg
    bMode = fgMode
    bValue = fg
  }
  // xterm's drawBoldTextInBrightColors (on by default): bold text in ANSI 0-7 uses the bright slot.
  if (
    (flags & FLAG_BOLD) !== 0 &&
    (fMode === COLOR_MODE_P16 || fMode === COLOR_MODE_P256) &&
    fValue < 8
  ) {
    fValue += 8
  }
  let fgColor = resolveColor(fMode, fValue, table)
  let bgColor = resolveColor(bMode, bValue, table)
  if (inverse) {
    // An inverted default color is the other default, which a view cannot express as null.
    if (fgColor === null) fgColor = palette.background
    if (bgColor === null) bgColor = palette.foreground
  }
  return {
    text,
    cells,
    fg: fgColor,
    bg: bgColor,
    bold: (flags & FLAG_BOLD) !== 0,
    dim: (flags & FLAG_DIM) !== 0,
    italic: (flags & FLAG_ITALIC) !== 0,
    underline: (flags & FLAG_UNDERLINE) !== 0,
    strike: (flags & FLAG_STRIKE) !== 0,
    invisible: (flags & FLAG_INVISIBLE) !== 0,
  }
}

/** Groups a row's cells into runs of equal attributes. */
export function lineRuns(
  line: IBufferLine,
  cell: IBufferCell,
  palette: MirrorPalette,
): MirrorRun[] {
  const table = paletteTable(palette)
  const end = contentEnd(line, cell)
  const runs: MirrorRun[] = []
  let run: MirrorRun | null = null
  let runFgMode = 0
  let runFg = 0
  let runBgMode = 0
  let runBg = 0
  let runFlags = 0
  let runIsWide = false
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell)
    const width = cell.getWidth()
    // The right half of a wide character: already counted with the character itself.
    if (width === 0) continue
    // A never-written cell still occupies its column; a space keeps it in selections and copies.
    const chars = cell.getChars() || ' '
    const fgMode = cell.getFgColorMode()
    const fg = cell.getFgColor()
    const bgMode = cell.getBgColorMode()
    const bg = cell.getBgColor()
    const flags = cellFlags(cell)
    if (
      run !== null &&
      width === 1 &&
      !runIsWide &&
      fgMode === runFgMode &&
      fg === runFg &&
      bgMode === runBgMode &&
      bg === runBg &&
      flags === runFlags
    ) {
      run.text += chars
      run.cells += 1
      continue
    }
    run = makeRun(chars, width, fgMode, fg, bgMode, bg, flags, palette, table)
    runs.push(run)
    runFgMode = fgMode
    runFg = fg
    runBgMode = bgMode
    runBg = bg
    runFlags = flags
    // Wide characters get a run of their own so a view never has to guess glyph widths.
    runIsWide = width > 1
  }
  return runs
}

export function bufferLines(
  buffer: LineSource,
  start: number,
  end: number,
  cell: IBufferCell,
  palette: MirrorPalette,
): MirrorLine[] {
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(buffer.length, Math.floor(end))
  const lines: MirrorLine[] = []
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    lines.push({ index: y, wrapped: line.isWrapped, runs: lineRuns(line, cell, palette) })
  }
  return lines
}

/**
 * Text of a row that a soft-wrapped row continues: every cell counts (spaces at the wrap point are
 * content), except the empty last cell left behind when a wide character did not fit.
 */
function rowBeforeWrap(line: IBufferLine, next: IBufferLine, cell: IBufferCell): string {
  let end = line.length
  if (
    end > 0 &&
    line.getCell(end - 1, cell)?.getCode() === 0 &&
    next.getCell(0, cell)?.getWidth() === 2
  ) {
    end--
  }
  return line.translateToString(false, 0, end)
}

function trimEndSpaces(text: string): string {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--
  return end === text.length ? text : text.slice(0, end)
}

/** Plain text of [start, end): soft-wrapped rows joined, trailing spaces trimmed, `\n` between lines. */
export function bufferText(
  buffer: LineSource,
  start: number,
  end: number,
  cell: IBufferCell,
): string {
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(buffer.length, Math.floor(end))
  const out: string[] = []
  let current: string | null = null
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    const next = y + 1 < to ? buffer.getLine(y + 1) : undefined
    const text = next?.isWrapped ? rowBeforeWrap(line, next, cell) : line.translateToString(true)
    if (current !== null && line.isWrapped) {
      current += text
    } else {
      if (current !== null) out.push(trimEndSpaces(current))
      current = text
    }
  }
  if (current !== null) out.push(trimEndSpaces(current))
  return out.join('\n')
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/**
 * Appends a row to a logical line's search text. `cellAt[i]` is the cell (counted from the logical
 * line's first row) where UTF-16 unit i sits.
 */
function appendRow(
  line: IBufferLine,
  base: number,
  cell: IBufferCell,
  state: { text: string; cellAt: number[]; end: number },
): void {
  state.end = base + line.length
  const plain = line.translateToString(false)
  if (plain.length === line.length && PRINTABLE_ASCII.test(plain)) {
    state.text += plain
    for (let i = 0; i < plain.length; i++) state.cellAt.push(base + i)
    return
  }
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell)
    const width = cell.getWidth()
    if (width === 0) continue
    const chars = cell.getChars() || ' '
    state.text += chars
    for (let i = 0; i < chars.length; i++) state.cellAt.push(base + x)
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function bufferSearch(
  buffer: LineSource,
  cols: number,
  query: string,
  opts: MirrorSearchOptions | undefined,
  cell: IBufferCell,
): MirrorSearchMatch[] {
  if (!query) return []
  let pattern: RegExp
  try {
    pattern = new RegExp(
      opts?.regex ? query : escapeRegExp(query),
      opts?.caseSensitive ? 'g' : 'gi',
    )
  } catch {
    return []
  }
  const matches: MirrorSearchMatch[] = []
  const length = buffer.length
  let y = 0
  while (y < length && matches.length < MAX_SEARCH_MATCHES) {
    const firstRow = y
    const state = { text: '', cellAt: [] as number[], end: 0 }
    do {
      const line = buffer.getLine(y)
      if (line) appendRow(line, (y - firstRow) * cols, cell, state)
      y++
    } while (y < length && buffer.getLine(y)?.isWrapped)
    // Sentinel: the cell right after the logical line, for matches that end on its last unit. A
    // captured history row keeps the width it had, which may differ from today's.
    state.cellAt.push(state.end)
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(state.text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex++
        continue
      }
      const startCell = state.cellAt[match.index]
      const endCell = state.cellAt[match.index + match[0].length]
      const rowOffset = Math.floor(startCell / cols)
      matches.push({
        line: firstRow + rowOffset,
        start: startCell - rowOffset * cols,
        end: endCell - rowOffset * cols,
      })
      if (matches.length >= MAX_SEARCH_MATCHES) break
    }
  }
  return matches
}
