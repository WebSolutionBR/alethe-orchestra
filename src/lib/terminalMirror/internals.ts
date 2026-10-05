import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'

/**
 * The attribute accessors shared by `IBufferCell` and xterm's internal `AttributeData` (the pen the
 * parser draws with), so one SGR encoder serves both.
 */
export type CellAttributes = {
  getFgColorMode(): number
  getFgColor(): number
  getBgColorMode(): number
  getBgColor(): number
  isBold(): number
  isDim(): number
  isItalic(): number
  isUnderline(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
  isOverline(): number
}

/**
 * The few pieces of xterm 5.5 state the public API does not expose. Every accessor degrades to a
 * neutral value when the shape changes, and the mirror tests pin the behavior, so an xterm upgrade
 * that moves these fails loudly in CI instead of silently in the app.
 */
type InternalLine = {
  readonly length: number
  clone(): InternalLine
  loadCell(index: number, cell: IBufferCell): IBufferCell
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

type LineList = {
  readonly length: number
  get?: (index: number) => InternalLine | undefined
  onTrim?: (listener: (amount: number) => void) => { dispose(): void }
}

type XtermCore = {
  writeSync?: (data: string) => void
  buffers?: {
    normal?: { lines?: LineList }
    active?: { ybase?: number; scrollTop?: number; scrollBottom?: number; lines?: LineList }
  }
  coreService?: { isCursorHidden?: boolean }
  coreMouseService?: { activeEncoding?: string }
  _inputHandler?: { getAttrData?: () => CellAttributes }
}

function core(term: Terminal): XtermCore | null {
  const value = (term as unknown as { _core?: XtermCore })._core
  return value && typeof value === 'object' ? value : null
}

/**
 * A copy of a screen row of the active buffer that later writes cannot change, read through the
 * public line interface (as rows of history it never wraps). Null when the internals are missing.
 */
export function detachScreenRow(term: Terminal, row: number): IBufferLine | null {
  const active = core(term)?.buffers?.active
  const lines = active?.lines
  if (!lines || typeof lines.get !== 'function') return null
  const live = lines.get((active?.ybase ?? 0) + row)
  if (!live || typeof live.clone !== 'function') return null
  const copy = live.clone()
  return {
    isWrapped: false,
    length: copy.length,
    getCell: (x, cell) => {
      if (!cell || x < 0 || x >= copy.length) return undefined
      copy.loadCell(x, cell)
      return cell
    },
    translateToString: (trimRight, startColumn, endColumn) =>
      copy.translateToString(trimRight, startColumn, endColumn),
  }
}

/**
 * Parses `data` before returning. The mirror never uses the async `write`: mixing it with
 * `writeSync` re-parses chunks, and a synchronous parse is what lets `serializeMirror` reflect
 * every chunk already handed to the PTY listeners.
 */
export function writeNow(term: Terminal, data: string): void {
  const sync = core(term)?.writeSync
  if (typeof sync === 'function') {
    sync.call(core(term), data)
    return
  }
  term.write(data)
}

/**
 * Counts the lines dropped from the top of the normal buffer: trimmed scrollback, cleared history,
 * and everything a full reset (RIS) throws away, since it replaces the buffer with a new one. Call
 * `refresh` when the active buffer changes; null when the internals are unavailable.
 */
export function watchNormalTrim(
  term: Terminal,
  listener: (amount: number) => void,
): { refresh: () => void; dispose: () => void } | null {
  const current = () => core(term)?.buffers?.normal?.lines
  let lines = current()
  if (!lines || typeof lines.onTrim !== 'function') return null
  let subscription = lines.onTrim(listener)
  return {
    refresh: () => {
      const next = current()
      if (!next || next === lines || typeof next.onTrim !== 'function') return
      listener(lines!.length)
      subscription.dispose()
      lines = next
      subscription = next.onTrim(listener)
    },
    dispose: () => subscription.dispose(),
  }
}

export function isCursorHidden(term: Terminal): boolean {
  return core(term)?.coreService?.isCursorHidden === true
}

export type MouseEncoding = 'default' | 'sgr' | 'sgr-pixels'

export function mouseEncoding(term: Terminal): MouseEncoding {
  switch (core(term)?.coreMouseService?.activeEncoding) {
    case 'SGR':
      return 'sgr'
    case 'SGR_PIXELS':
      return 'sgr-pixels'
    default:
      return 'default'
  }
}

/** DECSTBM margins of the active buffer (0-based, inclusive), or null when unknown. */
export function scrollRegion(term: Terminal): { top: number; bottom: number } | null {
  const active = core(term)?.buffers?.active
  if (typeof active?.scrollTop !== 'number' || typeof active.scrollBottom !== 'number') return null
  return { top: active.scrollTop, bottom: active.scrollBottom }
}

/** The SGR pen the program is currently drawing with, or null when unavailable. */
export function currentAttributes(term: Terminal): CellAttributes | null {
  const handler = core(term)?._inputHandler
  if (!handler || typeof handler.getAttrData !== 'function') return null
  return handler.getAttrData()
}
