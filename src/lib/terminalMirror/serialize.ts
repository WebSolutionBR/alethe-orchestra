import type { IBuffer, IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'

import { COLOR_MODE_P16, COLOR_MODE_P256, COLOR_MODE_RGB } from './colors'
import {
  type CellAttributes,
  currentAttributes,
  isCursorHidden,
  mouseEncoding,
  scrollRegion,
} from './internals'
import { contentEnd } from './lines'

const ESC = '\x1b'
const CSI = '\x1b['

function pushColor(params: string[], mode: number, value: number, background: boolean): void {
  switch (mode) {
    case COLOR_MODE_P16:
      params.push(
        String(value < 8 ? (background ? 40 : 30) + value : (background ? 100 : 90) + value - 8),
      )
      return
    case COLOR_MODE_P256:
      params.push(`${background ? 48 : 38};5;${value}`)
      return
    case COLOR_MODE_RGB:
      params.push(
        `${background ? 48 : 38};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`,
      )
      return
  }
}

/** SGR parameters for a set of attributes ('' = all default). Raw palette indices, so the theme of
 * whichever terminal replays the text still applies. */
export function sgrParams(attrs: CellAttributes): string {
  const params: string[] = []
  if (attrs.isBold()) params.push('1')
  if (attrs.isDim()) params.push('2')
  if (attrs.isItalic()) params.push('3')
  if (attrs.isUnderline()) params.push('4')
  if (attrs.isBlink()) params.push('5')
  if (attrs.isInverse()) params.push('7')
  if (attrs.isInvisible()) params.push('8')
  if (attrs.isStrikethrough()) params.push('9')
  if (attrs.isOverline()) params.push('53')
  pushColor(params, attrs.getFgColorMode(), attrs.getFgColor(), false)
  pushColor(params, attrs.getBgColorMode(), attrs.getBgColor(), true)
  return params.join(';')
}

function attrFlags(cell: IBufferCell): number {
  return (
    (cell.isBold() ? 1 : 0) |
    (cell.isDim() ? 2 : 0) |
    (cell.isItalic() ? 4 : 0) |
    (cell.isUnderline() ? 8 : 0) |
    (cell.isBlink() ? 16 : 0) |
    (cell.isInverse() ? 32 : 0) |
    (cell.isInvisible() ? 64 : 0) |
    (cell.isStrikethrough() ? 128 : 0) |
    (cell.isOverline() ? 256 : 0)
  )
}

/** Accumulates the output and only emits SGR when the attributes actually change. */
class VtWriter {
  readonly parts: string[] = []
  private sgr = ''
  private fgMode = 0
  private fg = -1
  private bgMode = 0
  private bg = -1
  private flags = 0

  text(value: string): void {
    this.parts.push(value)
  }

  /** Back to default attributes (before line feeds, so new rows are not painted with a color). */
  reset(): void {
    if (this.sgr === '') return
    this.parts.push(`${CSI}0m`)
    this.setState('', 0, -1, 0, -1, 0)
  }

  /** The SGR that switches to this cell's attributes, or null when they are already current. */
  switchTo(cell: IBufferCell): string | null {
    const fgMode = cell.getFgColorMode()
    const fg = cell.getFgColor()
    const bgMode = cell.getBgColorMode()
    const bg = cell.getBgColor()
    const flags = attrFlags(cell)
    if (
      fgMode === this.fgMode &&
      fg === this.fg &&
      bgMode === this.bgMode &&
      bg === this.bg &&
      flags === this.flags
    ) {
      return null
    }
    const params = sgrParams(cell)
    const changed = params !== this.sgr
    this.setState(params, fgMode, fg, bgMode, bg, flags)
    if (!changed) return null
    return params ? `${CSI}0;${params}m` : `${CSI}0m`
  }

  private setState(
    sgr: string,
    fgMode: number,
    fg: number,
    bgMode: number,
    bg: number,
    flags: number,
  ): void {
    this.sgr = sgr
    this.fgMode = fgMode
    this.fg = fg
    this.bgMode = bgMode
    this.bg = bg
    this.flags = flags
  }
}

function writeCells(line: IBufferLine, end: number, cell: IBufferCell, out: VtWriter): void {
  let text = ''
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell)
    if (cell.getWidth() === 0) continue
    const sgr = out.switchTo(cell)
    if (sgr !== null) {
      if (text) out.text(text)
      text = ''
      out.text(sgr)
    }
    // Explicit spaces for never-written cells: ConPTY skips runs of blanks with CHA (ESC [ n G), and
    // a replay that lost those moves would glue the words together.
    text += cell.getChars() || ' '
  }
  if (text) out.text(text)
}

/**
 * Cells to write for a row that a soft wrap continues: all of them, except the empty last cell a
 * wide character left behind when it did not fit; skipping it makes the replay wrap the same way.
 */
function wrapEnd(line: IBufferLine, next: IBufferLine, cell: IBufferCell): number {
  const end = line.length
  if (
    end > 0 &&
    line.getCell(end - 1, cell)?.getCode() === 0 &&
    next.getCell(0, cell)?.getWidth() === 2
  ) {
    return end - 1
  }
  return end
}

/** Every row of the normal buffer, scrollback included, so the screen lands on the same rows. */
function writeNormalBuffer(buffer: IBuffer, cell: IBufferCell, out: VtWriter): void {
  const length = buffer.length
  for (let y = 0; y < length; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    if (y > 0 && !line.isWrapped) {
      out.reset()
      out.text('\r\n')
    }
    const next = y + 1 < length ? buffer.getLine(y + 1) : undefined
    // A row that a soft wrap continues is written in full, so the terminal wraps exactly there.
    const end = next?.isWrapped ? wrapEnd(line, next, cell) : contentEnd(line, cell)
    if (end === 0 && line.isWrapped && y > 0) {
      // An empty continuation row still has to exist, or every row after it shifts up by one.
      out.reset()
      out.text(' ')
      continue
    }
    writeCells(line, end, cell, out)
  }
}

function writeAlternateScreen(
  buffer: IBuffer,
  rows: number,
  cell: IBufferCell,
  out: VtWriter,
): void {
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.baseY + row)
    if (!line) continue
    const end = contentEnd(line, cell)
    if (end === 0) continue
    out.text(`${CSI}${row + 1};1H`)
    writeCells(line, end, cell, out)
  }
}

const MOUSE_TRACKING: Record<string, string> = {
  x10: '9',
  vt200: '1000',
  drag: '1002',
  any: '1003',
}

/** Modes, margins, pen and cursor: what the program set and the next bytes it sends rely on. */
function writeTerminalState(term: Terminal, out: VtWriter): void {
  const modes = term.modes
  const active = term.buffer.active
  if (modes.applicationCursorKeysMode) out.text(`${CSI}?1h`)
  if (modes.applicationKeypadMode) out.text(`${ESC}=`)
  if (modes.bracketedPasteMode) out.text(`${CSI}?2004h`)
  if (modes.sendFocusMode) out.text(`${CSI}?1004h`)
  if (modes.reverseWraparoundMode) out.text(`${CSI}?45h`)
  if (!modes.wraparoundMode) out.text(`${CSI}?7l`)
  const tracking = MOUSE_TRACKING[modes.mouseTrackingMode]
  if (tracking) out.text(`${CSI}?${tracking}h`)
  const encoding = mouseEncoding(term)
  if (encoding === 'sgr') out.text(`${CSI}?1006h`)
  else if (encoding === 'sgr-pixels') out.text(`${CSI}?1016h`)
  if (isCursorHidden(term)) out.text(`${CSI}?25l`)
  // DECSTBM and DECOM both home the cursor, so they go before the final CUP.
  const region = scrollRegion(term)
  if (region && (region.top !== 0 || region.bottom !== term.rows - 1)) {
    out.text(`${CSI}${region.top + 1};${region.bottom + 1}r`)
  }
  if (modes.originMode) out.text(`${CSI}?6h`)
  if (modes.insertMode) out.text(`${CSI}4h`)
  const pen = currentAttributes(term)
  const params = pen ? sgrParams(pen) : ''
  out.text(params ? `${CSI}0;${params}m` : `${CSI}0m`)
  const row = modes.originMode && region ? active.cursorY - region.top : active.cursorY
  const col = Math.min(active.cursorX, term.cols - 1)
  out.text(`${CSI}${row + 1};${col + 1}H`)
}

/**
 * VT text that redraws the terminal into a freshly reset terminal of the same size: the whole normal
 * buffer (explicit spaces, CRLF only between logical lines, minimal SGR), the alternate screen when
 * it is active, then modes, margins, the current pen and the cursor.
 */
export function serializeTerminal(term: Terminal): string {
  const normal = term.buffer.normal
  const cell = normal.getNullCell()
  const out = new VtWriter()
  writeNormalBuffer(normal, cell, out)
  out.reset()
  const active = term.buffer.active
  if (active.type === 'alternate') {
    // DECSC inside ?1049h saves this cursor; leaving the alternate screen later restores it.
    out.text(`${CSI}${normal.cursorY + 1};${Math.min(normal.cursorX, term.cols - 1) + 1}H`)
    out.text(`${CSI}?1049h`)
    writeAlternateScreen(active, term.rows, cell, out)
    out.reset()
  }
  writeTerminalState(term, out)
  return out.parts.join('')
}
