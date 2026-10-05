/** CSS color; null = theme default. */
export type MirrorColor = string | null

export type MirrorRun = {
  /** Never-written (null) cells are rendered as ' ' so selections keep the spaces. */
  text: string
  /** Terminal cells covered (wide chars count 2). */
  cells: number
  /** Resolved with the palette; inverse already applied. */
  fg: MirrorColor
  bg: MirrorColor
  bold: boolean
  /** Faint text: the view lowers its opacity, the colors are not pre-dimmed. */
  dim: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** Concealed text: the view keeps the cells but hides the glyphs. */
  invisible: boolean
}

export type MirrorLine = {
  /** Absolute line in the active buffer (0 = oldest scrollback line). */
  index: number
  /** Continuation of the previous line (soft wrap). */
  wrapped: boolean
  /**
   * Left to right. A wide character always gets a run of its own (cells = 2). Trailing cells that
   * were never written and carry no attribute are left out, so the runs may cover fewer than `cols`.
   */
  runs: MirrorRun[]
}

export type MirrorPalette = {
  foreground: string
  background: string
  /** 16 entries; 256-color and truecolor are resolved by the mirror. */
  ansi: string[]
}

export type MirrorMouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

export type MirrorModes = {
  applicationCursorKeys: boolean
  bracketedPaste: boolean
  mouseTracking: MirrorMouseTracking
  /**
   * Mouse report encoding the program asked for (DECSET 1006/1016 = 'sgr'). Optional so hand-made
   * modes keep compiling; absent means the default X10 byte encoding.
   */
  mouseEncoding?: 'default' | 'sgr'
}

/**
 * A match in cells, [start, end) from the start of `line`. A match that runs on through soft-wrapped
 * rows keeps `line` = its first row and has `end` > cols: cell k sits on row line + floor(k / cols),
 * column k % cols.
 */
export type MirrorSearchMatch = { line: number; start: number; end: number }

export type MirrorSearchOptions = { caseSensitive?: boolean; regex?: boolean }

export interface TerminalMirror {
  readonly ptyId: string
  readonly cols: number
  readonly rows: number
  readonly bufferType: 'normal' | 'alternate'
  /** Lines in the active buffer (scrollback + screen). */
  readonly length: number
  /** First screen row inside the active buffer. */
  readonly baseY: number
  /** y is absolute (baseY + row). */
  readonly cursor: { x: number; y: number; visible: boolean }
  readonly modes: MirrorModes
  readonly exited: boolean
  /**
   * Lines dropped from the top of the normal buffer since the mirror was created (full scrollback,
   * cleared history). Monotonic; a view pinned to an absolute line subtracts the delta to keep its
   * place, as xterm does with its viewport.
   */
  readonly trimmed: number
  /** [start, end) */
  getLines(start: number, end: number, palette: MirrorPalette): MirrorLine[]
  /** Plain text, soft-wrapped rows joined, trailing spaces trimmed. */
  getText(start: number, end: number): string
  /** start/end in cells. */
  search(query: string, opts?: MirrorSearchOptions): MirrorSearchMatch[]
  /** Coalesced to one call per animation frame. */
  onChange(listener: () => void): () => void
  /** Only called by the pty.ts wrapper / ensureMirror. */
  resize(cols: number, rows: number): void
}

export type MirrorOptions = { cols: number; rows: number; scrollback?: number }

export type KeyLike = {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}
