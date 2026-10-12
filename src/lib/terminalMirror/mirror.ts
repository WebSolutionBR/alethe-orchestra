import { Unicode11Addon } from '@xterm/addon-unicode11'
import {
  type IBuffer,
  type IBufferCell,
  type IDisposable,
  type IMarker,
  Terminal,
} from '@xterm/xterm'

import { getTerminalScrollbackRows } from '../../components/XTermView/terminalInput'
import { AltScreenHistory, type FrameRow } from './altScreen'
import {
  detachScreenRow,
  isCursorHidden,
  mouseEncoding,
  watchNormalTrim,
  writeNow,
} from './internals'
import { bufferLines, bufferSearch, bufferText, type LineSource } from './lines'
import { pendingEscape } from './pendingEscape'
import { seedReplay } from './seed'
import { serializeTerminal } from './serialize'
import type {
  MirrorLine,
  MirrorModes,
  MirrorOptions,
  MirrorPalette,
  MirrorSearchMatch,
  MirrorSearchOptions,
  TerminalMirror,
} from './types'

// xterm's own lower bounds; resize() clamps to them anyway.
const MIN_COLS = 2
const MIN_ROWS = 1

function clampSize(value: number, min: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : min
}

/** Quiet time after output on the alternate screen before its frame is compared anyway. */
const CAPTURE_DELAY_MS = 100
/** A frame still open after this long belongs to a program that hides the cursor for good. */
const OPEN_FRAME_LIMIT_MS = 300
const ALTERNATE_SCREEN_MODES = [47, 1047, 1049]

function hasParam(params: (number | number[])[], wanted: number[]): boolean {
  return params.some((param) => wanted.includes(Array.isArray(param) ? param[0] : param))
}

/**
 * One stay on the alternate screen: its rows in the history (indices counted from the first row
 * ever kept, dropped ones included) and the normal-buffer line the program left from.
 */
type AltSession = {
  marker: IMarker | null
  /** The program started mid-row (after a prompt): the session goes after that row, not before. */
  afterRow: boolean
  start: number
  end: number | null
}

/** History display rows (see AltScreenHistory.setWidth) spliced into the normal buffer before `at`. */
type Insertion = { at: number; from: number; size: number }

type FrameHandle = { cancel: () => void }

/** One callback per animation frame; a timer where frames do not run (tests, hidden documents). */
function requestFrame(callback: () => void): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(callback)
    return { cancel: () => window.cancelAnimationFrame(id) }
  }
  const id = setTimeout(callback, 16)
  return { cancel: () => clearTimeout(id) }
}

/**
 * A headless xterm.js terminal (never `open()`ed: parser and buffer only, no renderer) that receives
 * a PTY's output and is always kept at the PTY's size.
 */
export class Mirror implements TerminalMirror {
  readonly ptyId: string
  private readonly term: Terminal
  private readonly cell: IBufferCell
  private readonly listeners = new Set<() => void>()
  private readonly subscriptions: IDisposable[] = []
  private readonly trimWatch: ReturnType<typeof watchNormalTrim>
  /** What scrolled out of the alternate screen; see AltScreenHistory. */
  private readonly altHistory: AltScreenHistory
  /** Where each finished alternate-screen session goes back into the normal transcript. */
  private readonly altSessions: AltSession[] = []
  private captureTimer: ReturnType<typeof setTimeout> | null = null
  /** When the program last hid the cursor to paint (ConPTY frames run from ?25l to ?25h); 0 = shown. */
  private paintingSince = 0
  private frame: FrameHandle | null = null
  private bytesWritten = 0
  private trimmedLines = 0
  private hasExited = false
  private disposed = false
  /** Live chunks held back while a seed replay is being fetched. */
  private seedQueue: string[] | null = null
  private seedStarted = false
  /** Start of an escape sequence the stream ended in (see pendingEscape). */
  private pendingSequence = ''
  /** Resized on the alternate screen and the program has not written since (see resize). */
  private awaitingRedraw = false

  constructor(ptyId: string, opts: MirrorOptions) {
    this.ptyId = ptyId
    const scrollback = opts.scrollback ?? getTerminalScrollbackRows({ agent: true })
    this.altHistory = new AltScreenHistory(scrollback)
    this.term = new Terminal({
      cols: clampSize(opts.cols, MIN_COLS),
      rows: clampSize(opts.rows, MIN_ROWS),
      scrollback,
      allowProposedApi: true,
      convertEol: false,
      // The synchronous parse (see writeNow) logs a deprecation warning at 'warn'.
      logLevel: 'error',
      // Same as XTermView: no `windowsPty`, which makes xterm assume ConPTY reflows wrapped lines
      // itself and corrupts the repaint of dense TUIs.
    })
    // Unicode 11 widths, like XTermView, so emoji and symbols take the cells the program counted.
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.cell = this.term.buffer.normal.getNullCell()
    this.altHistory.setWidth(this.term.cols, this.cell)
    this.trimWatch = watchNormalTrim(this.term, (amount) => {
      this.trimmedLines += amount
    })
    const parser = this.term.parser
    this.subscriptions.push(
      this.term.onResize(() => this.schedule()),
      this.term.buffer.onBufferChange(() => {
        // A full reset (RIS) swaps in a new normal buffer.
        this.trimWatch?.refresh()
        if (this.term.buffer.active.type === 'normal') this.closeAlternateSessions()
        this.schedule()
      }),
      // Only reached when the synchronous parse is unavailable and writes go through the queue.
      this.term.onWriteParsed(() => this.schedule()),
      // These run before xterm's own handlers (returning false hands the sequence on), so the
      // screen they look at is still the one the sequence is about to change.
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (hasParam(params, [25])) this.frameEnded()
        if (hasParam(params, ALTERNATE_SCREEN_MODES)) this.enterAlternateScreen()
        return false
      }),
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (hasParam(params, [25])) this.paintingSince = Date.now()
        if (hasParam(params, ALTERNATE_SCREEN_MODES)) this.keepAlternateScreen()
        return false
      }),
      parser.registerCsiHandler({ final: 'J' }, (params) => {
        if (hasParam(params, [2])) this.keepAlternateScreen()
        return false
      }),
      parser.registerEscHandler({ final: 'c' }, () => {
        this.keepAlternateScreen()
        return false
      }),
    )
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  get bufferType(): 'normal' | 'alternate' {
    return this.term.buffer.active.type
  }

  /**
   * One line space for every reader. On the alternate screen the rows that scrolled out of it come
   * first; back on the normal buffer, each finished full-screen session sits where it started, so
   * the transcript keeps it after the program exits. `length`, `baseY` and `cursor.y` follow it.
   */
  get length(): number {
    const active = this.term.buffer.active
    if (active.type === 'alternate') return this.altHistory.displayLength + active.length
    return this.insertions(active).reduce((total, insert) => total + insert.size, active.length)
  }

  get baseY(): number {
    return this.toLineSpace(this.term.buffer.active.baseY)
  }

  get cursor(): { x: number; y: number; visible: boolean } {
    const active = this.term.buffer.active
    return {
      // x equals cols while a wrap is pending; the cursor is still drawn on the last column.
      x: Math.min(active.cursorX, this.term.cols - 1),
      y: this.toLineSpace(active.baseY + active.cursorY),
      visible: !isCursorHidden(this.term),
    }
  }

  get modes(): MirrorModes {
    const modes = this.term.modes
    return {
      applicationCursorKeys: modes.applicationCursorKeysMode,
      bracketedPaste: modes.bracketedPasteMode,
      mouseTracking: modes.mouseTrackingMode,
      mouseEncoding: mouseEncoding(this.term) === 'default' ? 'default' : 'sgr',
    }
  }

  get exited(): boolean {
    return this.hasExited
  }

  get trimmed(): number {
    return this.trimmedLines + this.altHistory.droppedDisplayRows
  }

  /** True once any byte reached the buffer (seeds and serializations need something to work on). */
  get hasContent(): boolean {
    return this.bytesWritten > 0
  }

  getLines(start: number, end: number, palette: MirrorPalette): MirrorLine[] {
    return bufferLines(this.source(), start, end, this.cell, palette)
  }

  getText(start: number, end: number): string {
    return bufferText(this.source(), start, end, this.cell)
  }

  search(query: string, opts?: MirrorSearchOptions): MirrorSearchMatch[] {
    return bufferSearch(this.source(), this.term.cols, query, opts, this.cell)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    const nextCols = clampSize(cols, MIN_COLS)
    const nextRows = clampSize(rows, MIN_ROWS)
    if (nextCols === this.term.cols && nextRows === this.term.rows) return
    if (this.term.buffer.active.type === 'alternate') {
      // The screen as the program last drew it, matched against its redraw at the new size.
      this.captureFrame()
      this.altHistory.resizing()
      // Until the program writes again the screen is the old frame cut to the new size: a capture
      // already scheduled must not take it for a frame (it would be kept twice).
      this.awaitingRedraw = true
    }
    // xterm reflows the normal buffer; onResize schedules the change notification.
    this.term.resize(nextCols, nextRows)
    this.altHistory.setWidth(this.term.cols, this.cell)
  }

  /** Output of the PTY, in stream order. */
  feed(data: string): void {
    if (this.disposed || !data) return
    if (this.seedQueue) {
      this.seedQueue.push(data)
      return
    }
    this.writeChunk(data)
  }

  /** The PTY ended. A restart under the same id streams again and clears the flag. */
  markExited(reason?: string): void {
    if (this.disposed || reason === 'restarted') return
    if (this.hasExited) return
    this.hasExited = true
    this.schedule()
  }

  /**
   * Seeds an empty mirror with the PTY's recorded output, once. Live chunks that arrive while the
   * recording is fetched are held and written after it, so the order stays that of the stream.
   */
  async seed(fetchRecorded: () => Promise<string>): Promise<void> {
    if (this.disposed || this.seedStarted || this.bytesWritten > 0) return
    this.seedStarted = true
    this.seedQueue = []
    let recorded = ''
    try {
      recorded = await fetchRecorded()
    } catch (error) {
      console.warn(`[terminal-mirror] ${this.ptyId}: seed failed`, error)
    }
    const queued = this.seedQueue ?? []
    this.seedQueue = null
    if (this.disposed) return
    if (recorded) this.writeChunk(seedReplay(recorded))
    for (const chunk of queued) this.writeChunk(chunk)
  }

  serialize(): string | null {
    if (this.disposed || this.bytesWritten === 0) return null
    // The parser sits inside a sequence: the restored terminal starts it too, so the rest of it,
    // in the next chunk, is parsed there instead of shown as text.
    return serializeTerminal(this.term) + this.pendingSequence
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.frame?.cancel()
    this.frame = null
    if (this.captureTimer !== null) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.listeners.clear()
    this.seedQueue = null
    this.trimWatch?.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.term.dispose()
  }

  private writeChunk(data: string): void {
    if (!data) return
    this.bytesWritten += data.length
    if (this.hasExited) this.hasExited = false
    this.awaitingRedraw = false
    this.pendingSequence = pendingEscape(this.pendingSequence, data)
    writeNow(this.term, data)
    // Frames normally get compared when ConPTY shows the cursor again (frameEnded); this catches
    // programs and streams that never do.
    if (this.term.buffer.active.type === 'alternate') this.scheduleCapture()
    this.schedule()
  }

  /** A row of the active buffer in the shared line space (see `length`). */
  private toLineSpace(row: number): number {
    const active = this.term.buffer.active
    if (active.type === 'alternate') return this.altHistory.displayLength + row
    let offset = 0
    for (const insert of this.insertions(active)) if (insert.at <= row) offset += insert.size
    return row + offset
  }

  /** The line space the readers walk: see `length`. */
  private source(): LineSource {
    const active = this.term.buffer.active
    const history = this.altHistory
    if (active.type === 'alternate') {
      const rows = history.displayLength
      if (rows === 0) return active
      return {
        length: rows + active.length,
        getLine: (y) => (y < rows ? history.displayLine(y) : active.getLine(y - rows)),
      }
    }
    const inserts = this.insertions(active)
    if (inserts.length === 0) return active
    return {
      length: inserts.reduce((total, insert) => total + insert.size, active.length),
      getLine: (y) => {
        let offset = 0
        for (const insert of inserts) {
          const begin = insert.at + offset
          if (y < begin) break
          if (y < begin + insert.size) return history.displayLine(insert.from + y - begin)
          offset += insert.size
        }
        return active.getLine(y - offset)
      },
    }
  }

  /** The finished alternate-screen sessions still in the history, by the line they go before. */
  private insertions(normal: IBuffer): Insertion[] {
    const dropped = this.altHistory.dropped
    const inserts: Insertion[] = []
    for (const session of this.altSessions) {
      if (session.end === null) continue
      const first = Math.max(session.start, dropped) - dropped
      if (session.end - dropped <= first) continue
      const from = this.altHistory.displayIndex(first)
      const size = this.altHistory.displayIndex(session.end - dropped) - from
      // A marker trimmed away with the top of the scrollback leaves its session at the top.
      const line =
        session.marker && session.marker.line >= 0
          ? session.marker.line + (session.afterRow ? 1 : 0)
          : 0
      inserts.push({ at: Math.min(normal.length, line), from, size })
    }
    return inserts.sort((a, b) => a.at - b.at)
  }

  /** Before switching: remember where the program leaves the normal buffer. */
  private enterAlternateScreen(): void {
    this.altHistory.restart()
    if (this.term.buffer.active.type !== 'normal') return
    const marker = this.markCursorRow()
    const start = this.altHistory.dropped + this.altHistory.length
    const afterRow = this.term.buffer.active.cursorX > 0
    this.altSessions.push({ marker, afterRow, start, end: null })
  }

  /** A marker on the cursor's row of the normal buffer; xterm moves it through reflow and trims. */
  private markCursorRow(): IMarker | null {
    try {
      return this.term.registerMarker(0) ?? null
    } catch {
      return null
    }
  }

  /** Back on the normal buffer (the screen was kept just before, see keepAlternateScreen). */
  private closeAlternateSessions(): void {
    const end = this.altHistory.dropped + this.altHistory.length
    for (let i = this.altSessions.length - 1; i >= 0; i--) {
      const session = this.altSessions[i]
      if (session.end !== null) continue
      session.end = end
      if (end > session.start) continue
      // Nothing was kept from it: no reason to hold its marker.
      session.marker?.dispose()
      this.altSessions.splice(i, 1)
    }
  }

  private frameEnded(): void {
    this.paintingSince = 0
    this.captureFrame()
  }

  private scheduleCapture(): void {
    if (this.captureTimer !== null || this.disposed) return
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null
      if (this.disposed) return
      // Mid-paint the screen is half old, half new; wait for the frame to end.
      if (this.paintingSince > 0 && Date.now() - this.paintingSince < OPEN_FRAME_LIMIT_MS) {
        this.scheduleCapture()
        return
      }
      this.captureFrame()
      this.schedule()
    }, CAPTURE_DELAY_MS)
  }

  /** Compares the alternate screen with the last frame and keeps the rows that scrolled out. */
  private captureFrame(): void {
    const active = this.term.buffer.active
    if (this.disposed || this.awaitingRedraw || active.type !== 'alternate') return
    const previous = this.altHistory.lastFrame
    const frame: FrameRow[] = []
    let changed = previous === null || previous.length !== this.term.rows
    for (let row = 0; row < this.term.rows; row++) {
      const text = active.getLine(active.baseY + row)?.translateToString(true) ?? ''
      const known = previous?.[row]
      if (known && known.text === text) {
        frame.push(known)
        continue
      }
      // Without xterm's internals there is nothing to copy rows from: no history, as before.
      const line = detachScreenRow(this.term, row)
      if (!line) return
      frame.push({ text, line })
      changed = true
    }
    if (changed) this.altHistory.capture(frame)
  }

  /** The alternate screen is about to be cleared, left or reset: what it shows goes to history. */
  private keepAlternateScreen(): void {
    if (this.term.buffer.active.type !== 'alternate') return
    this.captureFrame()
    this.altHistory.flush()
  }

  private schedule(): void {
    if (this.disposed || this.frame !== null || this.listeners.size === 0) return
    this.frame = requestFrame(() => {
      this.frame = null
      if (this.disposed) return
      for (const listener of [...this.listeners]) {
        try {
          listener()
        } catch (error) {
          console.warn(`[terminal-mirror] ${this.ptyId}: change listener failed`, error)
        }
      }
    })
  }
}
