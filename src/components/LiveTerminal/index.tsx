import { getCurrentWebview } from '@tauri-apps/api/webview'
import { ClipboardPaste, Copy, ExternalLink, FolderOpen, Search, TextSelect } from 'lucide-react'
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { getLocale, translate, useT } from '../../lib/i18n'
import {
  openInBrowser,
  openInFileExplorer,
  readClipboardPayload,
  writeClipboardText,
} from '../../lib/tauri'
import {
  encodeKey,
  encodeWheel,
  type MirrorLine,
  type MirrorPalette,
  mirrorPaletteFromTheme,
  type MirrorSearchMatch,
  type TerminalMirror,
} from '../../lib/terminalMirror'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import {
  formatDroppedPaths,
  getWheelScrollLines,
  normalizePastedText,
} from '../XTermView/terminalInput'
import {
  type DetectedTerminalLink,
  detectTerminalLinks,
  stripLineColumn,
} from '../XTermView/terminalLinks'
import { writePtyChunked, writePtyWithTimeout } from '../XTermView/terminalWrite'
import { getXtermTheme } from '../XTermView/xtermThemes'
import {
  type CellPoint,
  type CellRange,
  clipboardText,
  firstMatchFrom,
  lineCells,
  type LogicalText,
  logicalText,
  matchRanges,
  type RowRun,
  rowRuns,
  rowSignature,
  selectionText,
  textRanges,
  unitAt,
} from './cells'
import { domPointToCell, orderPoints } from './domSelection'
import {
  PROBE_TEXT,
  useCellMetrics,
  useClientSize,
  useMirror,
  useMirrorFallback,
  useMirrorVersion,
  usePtyFit,
  useSizeOwnership,
} from './hooks'
import { fixedLayout, type RowLayout, WrapIndex } from './layout'
import { fullRow, LineCache } from './lineCache'
import styles from './LiveTerminal.module.css'
import { rightClickAction } from './pointerMenu'
import { Row, type RowModel } from './Row'
import { SearchBar } from './SearchBar'
import { classifyKey } from './shortcuts'
import { type MenuEntry, TerminalMenu } from './TerminalMenu'

export type LiveTerminalProps = {
  ptyId: string
  /** Default true: fits cols/rows to its own box and resizes the PTY (+ mirror). False = read the mirror as is, soft-wrapping wide lines. */
  ownsSize?: boolean
  readOnly?: boolean
  autoFocus?: boolean
  className?: string
  /** Fired when the user focuses the view (Orchestra uses it to select the agent). */
  onFocus?: () => void
}

/** Same insets as the classic terminal host, so both views line up when toggled. */
const PAD = { top: 4, right: 6, bottom: 2, left: 8 } as const
/** Boxes smaller than this belong to hidden panes; they never size the PTY. */
const MIN_FIT_BOX = { width: 50, height: 30 }
/** How far a link scan follows soft-wrapped rows up and down. */
const LINK_SCAN_ROWS = 64
const SEARCH_TYPE_DELAY_MS = 100
const SEARCH_REFRESH_MS = 300
/** How long the "Shift+wheel scrolls the history" hint stays after the wheel went to a program. */
const WHEEL_HINT_MS = 4000
const IS_WINDOWS = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)
const NO_PINS: number[] = []

type MenuState =
  | { kind: 'full'; x: number; y: number; copyText: string | null }
  | { kind: 'link'; x: number; y: number; link: DetectedTerminalLink }

type FoundState = { matches: MirrorSearchMatch[]; active: number; invalid: boolean }
const NO_MATCHES: FoundState = { matches: [], active: -1, invalid: false }

type HoverLink = { link: DetectedTerminalLink; ranges: CellRange[] }

type LinkScan = {
  mirror: TerminalMirror
  version: number
  start: number
  end: number
  logical: LogicalText
  links: DetectedTerminalLink[]
}

type ScrollState = {
  /** Last applied/observed scrollTop. */
  top: number
  /** Glued to the end: new output keeps the view at the bottom. */
  stick: boolean
  distanceFromBottom: number
  anchor: number
  trimmed: number
  geometry: string
  /** length + trimmed when the user left the end (counts the new lines for the pill). */
  leaveMark: number
  versionAtLeave: number
}

type OverlayBox = { key: string; row: number; col: number; cells: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function requestFrame(callback: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : window.setTimeout(callback, 16)
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else window.clearTimeout(handle)
}

/** Visual-row boxes of a cell range, split where soft wrap breaks the line. */
function rangeBoxes(range: CellRange, layout: RowLayout): Array<Omit<OverlayBox, 'key'>> {
  const boxes: Array<Omit<OverlayBox, 'key'>> = []
  const width = layout.sliceCols
  const first = layout.rowOf(range.line)
  const height = layout.heightOf(range.line)
  let cell = range.start
  while (cell < range.end) {
    const slice = Math.min(height - 1, Math.floor(cell / width))
    const sliceEnd = slice === height - 1 ? Number.POSITIVE_INFINITY : (slice + 1) * width
    const end = Math.min(range.end, sliceEnd)
    boxes.push({ row: first + slice, col: cell - slice * width, cells: end - cell })
    cell = end
  }
  return boxes
}

/** The logical line (soft-wrapped rows joined) around `line`, with the links found in it. */
function scanLinks(
  mirror: TerminalMirror,
  line: number,
  palette: MirrorPalette,
): Omit<LinkScan, 'mirror' | 'version'> {
  const before = mirror.getLines(Math.max(0, line - LINK_SCAN_ROWS), line + 1, palette)
  let first = before.length - 1
  while (first > 0 && before[first].wrapped) first -= 1
  const after = mirror.getLines(
    line + 1,
    Math.min(mirror.length, line + 1 + LINK_SCAN_ROWS),
    palette,
  )
  let count = 0
  while (count < after.length && after[count].wrapped) count += 1
  const rows = [...before.slice(Math.max(0, first)), ...after.slice(0, count)]
  const logical = logicalText(rows)
  return {
    start: rows[0]?.index ?? line,
    end: rows[rows.length - 1]?.index ?? line,
    logical,
    links: detectTerminalLinks(logical.text),
  }
}

async function readClipboardForPaste(): Promise<string> {
  const payload = await readClipboardPayload()
  switch (payload.kind) {
    case 'text':
      return payload.text
    case 'paths':
      return formatDroppedPaths(payload.paths)
    case 'image':
      return formatDroppedPaths([payload.path])
    default:
      return ''
  }
}

function toastFailure(
  titleKey: 'liveTerminal.openFail' | 'liveTerminal.copyFail',
  target: string,
  error: unknown,
) {
  useUiStore.getState().pushToast({
    title: translate(getLocale(), titleKey, { target }),
    body: String(error),
  })
}

/**
 * The live transcript of a PTY: a DOM renderer over the PTY's mirror. The mirror is always at the
 * PTY's real size and this view only reads its buffer, so nothing is ever replayed at a width the
 * program did not draw for — the root cause of the scrambled classic terminal.
 */
export function LiveTerminal(props: LiveTerminalProps): JSX.Element {
  // Everything (scroll position, selection, search) belongs to one PTY.
  return <LiveTerminalView key={props.ptyId} {...props} />
}

function LiveTerminalView({
  ptyId,
  ownsSize = true,
  readOnly = false,
  autoFocus = false,
  className,
  onFocus,
}: LiveTerminalProps): JSX.Element {
  const t = useT()
  const tRef = useRef(t)
  tRef.current = t
  const themeName = useProjectsStore((s) => s.preferences.terminalTheme ?? s.preferences.uiTheme)
  const theme = getXtermTheme(themeName)
  const palette = useMemo(() => mirrorPaletteFromTheme(theme), [theme])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const mirror = useMirror(ptyId)
  const version = useMirrorVersion(mirror)
  const metrics = useCellMetrics(rootRef, probeRef)
  const box = useClientSize(viewportRef)
  const { owner, claim } = useSizeOwnership(ptyId, ownsSize)

  const exited = mirror?.exited ?? false
  const inputDisabled = readOnly || exited
  const cellWidth = metrics.cellWidth
  const rowHeight = metrics.rowHeight

  const boxUsable = box.width >= MIN_FIT_BOX.width && box.height >= MIN_FIT_BOX.height
  const boxCols = boxUsable
    ? Math.max(2, Math.floor((box.width - PAD.left - PAD.right) / cellWidth))
    : 0
  const boxRows = boxUsable
    ? Math.max(1, Math.floor((box.height - PAD.top - PAD.bottom) / rowHeight))
    : 0

  const forceFitRef = useRef(false)
  useMirrorFallback({
    ptyId,
    mirror,
    ownSize: ownsSize && boxCols > 0 ? { cols: boxCols, rows: boxRows } : null,
    onCreatedAtOwnSize: () => {
      forceFitRef.current = true
    },
  })
  usePtyFit({
    ptyId,
    mirror,
    enabled: owner && !exited && boxUsable,
    cols: boxCols,
    rows: boxRows,
    forceRef: forceFitRef,
  })

  // Live values for event handlers that outlive a render.
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
  const versionRef = useRef(version)
  versionRef.current = version
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  const inputDisabledRef = useRef(inputDisabled)
  inputDisabledRef.current = inputDisabled
  const ptyIdRef = useRef(ptyId)
  ptyIdRef.current = ptyId

  // ---- layout ---------------------------------------------------------------------------------
  const bufferType = mirror?.bufferType ?? 'normal'
  const wrap = !!mirror && !owner && bufferType === 'normal' && boxCols > 0 && boxCols < mirror.cols
  const horizontal = !!mirror && !wrap && !owner && boxCols > 0 && boxCols < mirror.cols
  const wrapIndexRef = useRef<{ mirror: TerminalMirror | null; index: WrapIndex } | null>(null)
  if (wrapIndexRef.current === null) wrapIndexRef.current = { mirror: null, index: new WrapIndex() }

  const layout: RowLayout = useMemo(() => {
    void version
    const cache = wrapIndexRef.current
    if (!mirror || !cache) return fixedLayout(0, 1)
    if (cache.mirror !== mirror) {
      cache.mirror = mirror
      cache.index.reset()
    }
    if (!wrap) return fixedLayout(mirror.length, mirror.cols)
    return cache.index.update(mirror, palette, boxCols)
  }, [mirror, version, wrap, boxCols, palette])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // ---- scroll ---------------------------------------------------------------------------------
  const scrollRef = useRef<ScrollState>({
    top: 0,
    stick: true,
    distanceFromBottom: 0,
    anchor: -1,
    trimmed: 0,
    geometry: '',
    leaveMark: 0,
    versionAtLeave: 0,
  })
  const [, setScrollTick] = useState(0)
  const [stuck, setStuck] = useState(true)

  const viewportHeight =
    box.height > 0 ? box.height : mirror ? PAD.top + mirror.rows * rowHeight + PAD.bottom : 0
  const contentHeight = PAD.top + layout.total * rowHeight + PAD.bottom
  const maxScroll = Math.max(0, contentHeight - viewportHeight)
  const geometryKey = `${layout.sliceCols}:${mirror?.cols ?? 0}:${mirror?.rows ?? 0}:${rowHeight}:${bufferType}`
  const trimmed = mirror?.trimmed ?? 0
  const scroll = scrollRef.current
  let targetTop: number
  if (scroll.stick) {
    targetTop = maxScroll
  } else if (scroll.geometry && scroll.geometry !== geometryKey) {
    // Reflow after a resize: keep the same distance from the end, as the classic terminal does.
    targetTop = clamp(maxScroll - scroll.distanceFromBottom, 0, maxScroll)
  } else {
    // Lines dropped off the top of a full scrollback: keep reading the same text.
    targetTop = clamp(scroll.top - Math.max(0, trimmed - scroll.trimmed) * rowHeight, 0, maxScroll)
  }

  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  /** Last visual row in view, for handlers (the DOM may not know its height yet). */
  const bottomRowRef = useRef(0)
  bottomRowRef.current = Math.max(
    0,
    Math.floor((targetTop + viewportHeight - PAD.top - PAD.bottom) / rowHeight) - 1,
  )
  const chunk = Math.max(8, visibleRows >> 1)
  const anchorFor = useCallback(
    (top: number) =>
      Math.floor(Math.max(0, Math.floor((top - PAD.top) / rowHeight)) / chunk) * chunk,
    [chunk, rowHeight],
  )
  const anchor = anchorFor(targetTop)
  const rowStart = Math.max(0, anchor - visibleRows)
  const rowEnd = Math.min(layout.total, anchor + chunk + visibleRows * 2)
  const lineStart = layout.total > 0 ? layout.lineAt(rowStart) : 0
  const lineEnd = layout.total > 0 && rowEnd > rowStart ? layout.lineAt(rowEnd - 1) + 1 : lineStart

  const lineCacheRef = useRef<LineCache | null>(null)
  if (lineCacheRef.current === null) lineCacheRef.current = new LineCache()
  const lines = useMemo(() => {
    void version
    if (!mirror || lineEnd <= lineStart || !lineCacheRef.current) return [] as MirrorLine[]
    return lineCacheRef.current.read(mirror, palette, lineStart, lineEnd)
  }, [mirror, version, lineStart, lineEnd, palette])

  // ---- selection pins: the rows a selection starts and ends on stay mounted ----------------------
  const [pins, setPins] = useState<number[]>(NO_PINS)
  const pinnedLines = useMemo(() => {
    void version
    if (!mirror || pins.length === 0) return [] as MirrorLine[]
    const extra: MirrorLine[] = []
    for (const line of new Set(pins)) {
      if (line >= lineStart && line < lineEnd) continue
      if (line < 0 || line >= mirror.length) continue
      extra.push(...mirror.getLines(line, line + 1, palette))
    }
    return extra
  }, [mirror, version, pins, lineStart, lineEnd, palette])

  const rowModels = useMemo(() => {
    const models: RowModel[] = []
    const pinned = new Set(pinnedLines.map((line) => line.index))
    const all =
      pinnedLines.length > 0 ? [...lines, ...pinnedLines].sort((a, b) => a.index - b.index) : lines
    for (const line of all) {
      const first = layout.rowOf(line.index)
      const height = layout.heightOf(line.index)
      const cells = lineCells(line)
      for (let slice = 0; slice < height; slice += 1) {
        const row = first + slice
        if (!pinned.has(line.index) && (row < rowStart || row >= rowEnd)) continue
        const c0 = slice * layout.sliceCols
        const lastSlice = slice === height - 1
        // Whole lines are segmented once per line object; wrapped slices are cheap and rare.
        const full = height === 1 ? fullRow(line) : null
        const runs: RowRun[] = full
          ? full.runs
          : rowRuns(line, c0, lastSlice ? Number.POSITIVE_INFINITY : c0 + layout.sliceCols)
        const signature = full ? full.signature : rowSignature(runs)
        models.push({
          row,
          line: line.index,
          c0,
          c1: lastSlice ? Math.max(c0, cells) : c0 + layout.sliceCols,
          runs,
          signature,
        })
      }
    }
    return models
  }, [lines, pinnedLines, layout, rowStart, rowEnd])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const state = scrollRef.current
    if (viewport && Math.abs(viewport.scrollTop - targetTop) >= 1) viewport.scrollTop = targetTop
    // The browser may clamp; remember where the view really is.
    state.top = viewport && viewport.clientHeight > 0 ? viewport.scrollTop : targetTop
    state.trimmed = trimmed
    state.geometry = geometryKey
    state.anchor = anchor
  })

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const state = scrollRef.current
    state.top = viewport.scrollTop
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    state.distanceFromBottom = Math.max(0, distance)
    const atBottom = distance <= Math.max(2, rowHeight / 2)
    if (atBottom !== state.stick) {
      state.stick = atBottom
      if (!atBottom) {
        const current = mirrorRef.current
        state.leaveMark = current ? current.length + current.trimmed : 0
        state.versionAtLeave = versionRef.current
      }
      setStuck(atBottom)
    }
    const next = anchorFor(state.top)
    if (next !== state.anchor) {
      state.anchor = next
      setScrollTick((value) => value + 1)
    }
  }, [anchorFor, rowHeight])

  const jumpToBottom = useCallback(() => {
    scrollRef.current.stick = true
    setStuck(true)
    setScrollTick((value) => value + 1)
  }, [])

  const leaveBottom = useCallback(() => {
    const state = scrollRef.current
    if (!state.stick) return
    state.stick = false
    const current = mirrorRef.current
    state.leaveMark = current ? current.length + current.trimmed : 0
    state.versionAtLeave = versionRef.current
    setStuck(false)
  }, [])

  const scrollViewport = useCallback(
    (to: 'pageUp' | 'pageDown' | 'top' | 'bottom') => {
      const viewport = viewportRef.current
      if (!viewport) return
      if (to === 'bottom') {
        jumpToBottom()
        return
      }
      if (to !== 'pageDown') leaveBottom()
      const page = Math.max(rowHeight, viewport.clientHeight - rowHeight)
      if (to === 'top') viewport.scrollTop = 0
      else viewport.scrollTop += to === 'pageUp' ? -page : page
      onScroll()
    },
    [jumpToBottom, leaveBottom, onScroll, rowHeight],
  )

  /** Scrolls a cell into view (centered) unless it is already visible. */
  const revealCell = useCallback(
    (point: CellPoint) => {
      const viewport = viewportRef.current
      if (!viewport) return
      const current = layoutRef.current
      const slice = Math.min(
        current.heightOf(point.line) - 1,
        Math.floor(point.cell / current.sliceCols),
      )
      const top = PAD.top + (current.rowOf(point.line) + slice) * rowHeight
      const viewTop = viewport.scrollTop
      if (top >= viewTop && top + rowHeight <= viewTop + viewport.clientHeight) return
      leaveBottom()
      viewport.scrollTop = Math.max(0, top - (viewport.clientHeight - rowHeight) / 2)
      scrollRef.current.top = viewport.scrollTop
      onScroll()
      setScrollTick((value) => value + 1)
    },
    [leaveBottom, onScroll, rowHeight],
  )

  // ---- announcements --------------------------------------------------------------------------
  const [announcement, setAnnouncement] = useState('')
  const announce = useCallback((text: string) => {
    setAnnouncement((current) => (current === text ? `${text}\xa0` : text))
  }, [])

  useEffect(() => {
    if (exited) announce(tRef.current('liveTerminal.exitedAnnounce'))
  }, [announce, exited])

  // ---- focus ----------------------------------------------------------------------------------
  const [focusWithin, setFocusWithin] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true })
  }, [autoFocus])

  const onRootFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    setFocusWithin(true)
    const from = event.relatedTarget as Node | null
    if (!from || !event.currentTarget.contains(from)) {
      claim()
      onFocusRef.current?.()
    }
  }

  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget as Node | null
    if (to && event.currentTarget.contains(to)) return
    setFocusWithin(false)
    // "Select all" lives only while the terminal has the focus.
    setAllSelectedFlag(false)
  }

  // ---- input ----------------------------------------------------------------------------------
  const queueRef = useRef({ text: '', scheduled: false, chain: Promise.resolve() })

  const reportWriteFailure = useCallback(
    (error: unknown) => {
      console.warn(`[live-terminal] ${ptyIdRef.current}: write failed`, error)
      announce(tRef.current('liveTerminal.writeFail'))
    },
    [announce],
  )

  const send = useCallback(
    (data: string) => {
      if (!data || inputDisabledRef.current) return
      const queue = queueRef.current
      queue.text += data
      // Typing follows the output, like a real terminal.
      if (!scrollRef.current.stick) jumpToBottom()
      if (queue.scheduled) return
      queue.scheduled = true
      queueMicrotask(() => {
        queue.scheduled = false
        const chunkToWrite = queue.text
        queue.text = ''
        if (!chunkToWrite) return
        const id = ptyIdRef.current
        queue.chain = queue.chain
          .then(() => writePtyWithTimeout(id, chunkToWrite))
          .catch(reportWriteFailure)
      })
    },
    [jumpToBottom, reportWriteFailure],
  )

  const pasteText = useCallback(
    (raw: string) => {
      if (!raw || inputDisabledRef.current) return
      const id = ptyIdRef.current
      const text = normalizePastedText(raw)
      const bracketed = mirrorRef.current?.modes.bracketedPaste ?? false
      const queue = queueRef.current
      // Keystrokes typed before the paste reach the PTY first.
      if (queue.text) {
        const pending = queue.text
        queue.text = ''
        queue.chain = queue.chain
          .then(() => writePtyWithTimeout(id, pending))
          .catch(reportWriteFailure)
      }
      queue.chain = queue.chain
        .then(() => writePtyChunked(id, text, bracketed))
        .catch(reportWriteFailure)
      if (!scrollRef.current.stick) jumpToBottom()
    },
    [jumpToBottom, reportWriteFailure],
  )

  const pasteFromClipboard = useCallback(async () => {
    if (inputDisabledRef.current) return
    let text: string
    try {
      text = await readClipboardForPaste()
    } catch {
      try {
        text = (await navigator.clipboard?.readText()) ?? ''
      } catch {
        text = ''
      }
    }
    pasteText(text)
  }, [pasteText])

  // ---- selection and copy -----------------------------------------------------------------------
  const allSelectedRef = useRef(false)
  const [allSelected, setAllSelected] = useState(false)

  const setAllSelectedFlag = useCallback((value: boolean) => {
    if (allSelectedRef.current === value) return
    allSelectedRef.current = value
    setAllSelected(value)
  }, [])

  const ownsDomSelection = useCallback((selection: Selection | null): selection is Selection => {
    const rows = rowsRef.current
    if (!rows || !selection || selection.rangeCount === 0 || selection.isCollapsed) return false
    return rows.contains(selection.anchorNode) || rows.contains(selection.focusNode)
  }, [])

  const hasSelection = useCallback(
    () => allSelectedRef.current || ownsDomSelection(document.getSelection()),
    [ownsDomSelection],
  )

  const clearSelection = useCallback(() => {
    setAllSelectedFlag(false)
    const selection = document.getSelection()
    if (ownsDomSelection(selection)) selection.removeAllRanges()
  }, [ownsDomSelection, setAllSelectedFlag])

  /** The selected text, read from the mirror (not from the DOM); null when nothing of ours is selected. */
  const selectedText = useCallback((): string | null => {
    const current = mirrorRef.current
    if (!current) return null
    // The blank screen rows under the last output are not worth copying.
    if (allSelectedRef.current) return current.getText(0, current.length).replace(/\n+$/, '')
    const selection = document.getSelection()
    const rows = rowsRef.current
    if (!rows || !ownsDomSelection(selection)) return null
    const range = selection.getRangeAt(0)
    const start = domPointToCell(range.startContainer, range.startOffset, rows)
    const end = domPointToCell(range.endContainer, range.endOffset, rows)
    if (!start || !end) return null
    const [from, to] = orderPoints(start, end)
    const last = current.getLines(to.line, to.line + 1, paletteRef.current)[0]
    if (from.cell <= 0 && (!last || to.cell >= lineCells(last))) {
      return current.getText(from.line, to.line + 1)
    }
    return selectionText(current.getLines(from.line, to.line + 1, paletteRef.current), from, to)
  }, [ownsDomSelection])

  const writeClipboard = useCallback(
    (text: string) => {
      const payload = clipboardText(text, IS_WINDOWS)
      void writeClipboardText(payload)
        .catch(() => navigator.clipboard?.writeText(payload))
        .then(() => announce(tRef.current('liveTerminal.copied')))
        .catch((error) => toastFailure('liveTerminal.copyFail', '', error))
    },
    [announce],
  )

  const copySelection = useCallback((): boolean => {
    const text = selectedText()
    if (!text) return false
    writeClipboard(text)
    clearSelection()
    return true
  }, [clearSelection, selectedText, writeClipboard])

  const selectAll = useCallback(() => {
    document.getSelection()?.removeAllRanges()
    setAllSelectedFlag(true)
  }, [setAllSelectedFlag])

  // Native copy (menu bar, Ctrl+C while the rows have focus): the mirror's text replaces the DOM's.
  const selectedTextRef = useRef(selectedText)
  selectedTextRef.current = selectedText
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const root = rootRef.current
      if (!root) return
      if (allSelectedRef.current && !root.contains(document.activeElement)) return
      const text = selectedTextRef.current()
      if (text === null || !event.clipboardData) return
      event.clipboardData.setData('text/plain', clipboardText(text, IS_WINDOWS))
      event.preventDefault()
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [])

  useEffect(() => {
    const lineOf = (node: Node | null): number | null => {
      const rows = rowsRef.current
      if (!node || !rows || !rows.contains(node)) return null
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
      const row = element?.closest('[data-line]')
      if (!row) return null
      const value = Number(row.getAttribute('data-line'))
      return Number.isFinite(value) ? value : null
    }
    const onSelectionChange = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) {
        setPins(NO_PINS)
        return
      }
      const next = [lineOf(selection.anchorNode), lineOf(selection.focusNode)].filter(
        (line): line is number => line !== null,
      )
      if (next.length === 0) {
        setPins(NO_PINS)
        return
      }
      setPins((current) =>
        current.length === next.length && current.every((line, index) => line === next[index])
          ? current
          : next,
      )
      setAllSelectedFlag(false)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [setAllSelectedFlag])

  // ---- links ----------------------------------------------------------------------------------
  const linkScanRef = useRef<LinkScan | null>(null)

  const linkAtPoint = useCallback((point: CellPoint): HoverLink | null => {
    const current = mirrorRef.current
    if (!current || point.line < 0 || point.line >= current.length) return null
    let scan = linkScanRef.current
    if (
      !scan ||
      scan.mirror !== current ||
      scan.version !== versionRef.current ||
      point.line < scan.start ||
      point.line > scan.end
    ) {
      scan = {
        ...scanLinks(current, point.line, paletteRef.current),
        mirror: current,
        version: versionRef.current,
      }
      linkScanRef.current = scan
    }
    const unit = unitAt(scan.logical, point)
    if (unit < 0) return null
    const link = scan.links.find(
      (candidate) => unit >= candidate.index && unit < candidate.index + candidate.displayLength,
    )
    if (!link) return null
    return { link, ranges: textRanges(scan.logical, link.index, link.index + link.displayLength) }
  }, [])

  const openLink = useCallback((link: DetectedTerminalLink) => {
    const target = link.kind === 'url' ? link.target : stripLineColumn(link.target)
    void openInBrowser(target).catch((error) =>
      toastFailure('liveTerminal.openFail', target, error),
    )
  }, [])

  const revealLink = useCallback((link: DetectedTerminalLink) => {
    const target = stripLineColumn(link.target)
    void openInFileExplorer(target).catch((error) =>
      toastFailure('liveTerminal.openFail', target, error),
    )
  }, [])

  /** Cell under a viewport pointer position. */
  const pointAt = useCallback(
    (clientX: number, clientY: number): CellPoint | null => {
      const viewport = viewportRef.current
      const current = layoutRef.current
      if (!viewport || current.total === 0) return null
      const rect = viewport.getBoundingClientRect()
      const scale =
        viewport.offsetWidth > 0 && rect.width > 0 ? rect.width / viewport.offsetWidth : 1
      const x = (clientX - rect.left) / scale + viewport.scrollLeft - PAD.left
      const y = (clientY - rect.top) / scale + viewport.scrollTop - PAD.top
      if (x < 0 || y < 0) return null
      const row = Math.floor(y / rowHeight)
      if (row >= current.total) return null
      const line = current.lineAt(row)
      const slice = row - current.rowOf(line)
      return { line, cell: slice * current.sliceCols + Math.floor(x / cellWidth) }
    },
    [cellWidth, rowHeight],
  )

  const [hover, setHover] = useState<HoverLink | null>(null)
  const [ctrlHeld, setCtrlHeld] = useState(false)
  const moveRef = useRef<{ frame: number | null; x: number; y: number; ctrl: boolean }>({
    frame: null,
    x: 0,
    y: 0,
    ctrl: false,
  })

  useEffect(() => {
    const move = moveRef.current
    return () => {
      if (move.frame !== null) cancelFrame(move.frame)
    }
  }, [])

  useEffect(() => {
    if (!hover) return
    const onKey = (event: KeyboardEvent) => setCtrlHeld(event.ctrlKey || event.metaKey)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [hover])

  // ---- search ---------------------------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [found, setFound] = useState<FoundState>(NO_MATCHES)
  const searchRunRef = useRef<{ timer: number | null; key: string; at: number }>({
    timer: null,
    key: '',
    at: 0,
  })
  const revealNextRef = useRef(false)

  useEffect(() => {
    const run = searchRunRef.current
    return () => {
      if (run.timer !== null) window.clearTimeout(run.timer)
    }
  }, [])

  useEffect(() => {
    const run = searchRunRef.current
    if (!searchOpen || !mirror || !query) {
      if (run.timer !== null) window.clearTimeout(run.timer)
      run.timer = null
      run.key = ''
      setFound(NO_MATCHES)
      return
    }
    const key = `${caseSensitive ? 1 : 0}${regex ? 1 : 0}:${query}`
    const fresh = key !== run.key
    // New output only refreshes the matches every SEARCH_REFRESH_MS; typing restarts the search.
    if (!fresh && run.timer !== null) return
    if (run.timer !== null) window.clearTimeout(run.timer)
    const delay = fresh
      ? SEARCH_TYPE_DELAY_MS
      : Math.max(0, SEARCH_REFRESH_MS - (Date.now() - run.at))
    run.timer = window.setTimeout(() => {
      run.timer = null
      run.at = Date.now()
      const sameQuery = run.key === key
      run.key = key
      let matches: MirrorSearchMatch[]
      try {
        matches = mirror.search(query, { caseSensitive, regex })
      } catch {
        setFound({ matches: [], active: -1, invalid: true })
        return
      }
      if (!sameQuery) revealNextRef.current = true
      const current = layoutRef.current
      const bottomLine = current.total > 0 ? current.lineAt(bottomRowRef.current) : 0
      setFound((previous) => {
        if (matches.length === 0) return { matches, active: -1, invalid: false }
        if (sameQuery && previous.active >= 0 && previous.matches[previous.active]) {
          const old = previous.matches[previous.active]
          let best = 0
          let bestDistance = Number.POSITIVE_INFINITY
          matches.forEach((match, index) => {
            const distance =
              Math.abs(match.line - old.line) * 100000 + Math.abs(match.start - old.start)
            if (distance < bestDistance) {
              best = index
              bestDistance = distance
            }
          })
          return { matches, active: best, invalid: false }
        }
        // A new query starts at the last match above the bottom of the view (the newest output).
        let active = 0
        matches.forEach((match, index) => {
          if (match.line <= bottomLine) active = index
        })
        return { matches, active, invalid: false }
      })
    }, delay)
  }, [caseSensitive, mirror, query, regex, searchOpen, version])

  useEffect(() => {
    if (!revealNextRef.current || found.active < 0) return
    revealNextRef.current = false
    const match = found.matches[found.active]
    revealCell({ line: match.line, cell: match.start })
    announce(
      tRef.current('liveTerminal.search.announce', {
        current: found.active + 1,
        total: found.matches.length,
      }),
    )
  }, [announce, found, revealCell])

  const focusSearch = useCallback(() => {
    const input = searchInputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.select()
  }, [])

  useEffect(() => {
    if (searchOpen) focusSearch()
  }, [focusSearch, searchOpen])

  const openSearch = useCallback(() => {
    const selected = selectedText()
    if (selected && !selected.includes('\n') && selected.trim() && selected.length <= 200) {
      setQuery(selected)
    }
    setSearchOpen(true)
    focusSearch()
  }, [focusSearch, selectedText])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setFound(NO_MATCHES)
    focusInput()
  }, [focusInput])

  const stepMatch = useCallback((direction: 1 | -1) => {
    setFound((current) => {
      const total = current.matches.length
      if (total === 0) return current
      revealNextRef.current = true
      const active =
        current.active < 0
          ? direction > 0
            ? 0
            : total - 1
          : (current.active + direction + total) % total
      return { ...current, active }
    })
  }, [])

  // ---- menus ----------------------------------------------------------------------------------
  const [menu, setMenu] = useState<MenuState | null>(null)

  const closeMenu = useCallback(() => {
    setMenu(null)
    focusInput()
  }, [focusInput])

  const cursor = mirror && !exited && mirror.cursor.visible ? mirror.cursor : null

  const openMenuAtCursor = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const current = mirrorRef.current
    const point = current?.cursor
    const currentLayout = layoutRef.current
    let x = rect.left + PAD.left
    let y = rect.top + PAD.top
    if (point && currentLayout.total > 0) {
      const slice = Math.min(
        currentLayout.heightOf(point.y) - 1,
        Math.floor(point.x / currentLayout.sliceCols),
      )
      const row = currentLayout.rowOf(point.y) + slice
      x = rect.left + PAD.left + (point.x - slice * currentLayout.sliceCols) * cellWidth
      y = clamp(
        rect.top + PAD.top + (row + 1) * rowHeight - viewport.scrollTop,
        rect.top,
        rect.bottom,
      )
    }
    setMenu({ kind: 'full', x, y, copyText: selectedText() })
  }, [cellWidth, rowHeight, selectedText])

  // ---- keyboard -------------------------------------------------------------------------------
  const composingRef = useRef(false)
  const [composing, setComposing] = useState(false)

  const handleKey = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, source: 'input' | 'viewport') => {
      if (event.defaultPrevented) return
      const native = event.nativeEvent
      if (
        source === 'input' &&
        (composingRef.current || native.isComposing || native.keyCode === 229)
      ) {
        return
      }
      const selected = hasSelection()
      if (event.key === 'Escape' && selected) {
        event.preventDefault()
        clearSelection()
        return
      }
      const intent = classifyKey(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          altGraph:
            typeof native.getModifierState === 'function'
              ? native.getModifierState('AltGraph')
              : undefined,
        },
        selected,
      )
      switch (intent.kind) {
        case 'menu':
          event.preventDefault()
          openMenuAtCursor()
          return
        case 'copy':
          event.preventDefault()
          copySelection()
          return
        case 'paste':
          event.preventDefault()
          void pasteFromClipboard()
          return
        case 'find':
          event.preventDefault()
          openSearch()
          return
        case 'scroll':
          event.preventDefault()
          scrollViewport(intent.to)
          return
        case 'app':
          return
        case 'text':
          // From the hidden input the browser's input event delivers it (IME, dead keys).
          if (source === 'viewport') {
            event.preventDefault()
            focusInput()
            if (!inputDisabledRef.current) {
              clearSelection()
              send(event.key)
            }
          }
          return
        case 'terminal': {
          const current = mirrorRef.current
          if (!current || inputDisabledRef.current) return
          const data = encodeKey(native, current.modes)
          if (data === null) return
          event.preventDefault()
          if (source === 'viewport') focusInput()
          clearSelection()
          send(data)
        }
      }
    },
    [
      clearSelection,
      copySelection,
      focusInput,
      hasSelection,
      openMenuAtCursor,
      openSearch,
      pasteFromClipboard,
      scrollViewport,
      send,
    ],
  )

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent
    const area = event.currentTarget
    if (composingRef.current || native.isComposing) return
    const data = typeof native.data === 'string' && native.data ? native.data : area.value
    area.value = ''
    const type = native.inputType || 'insertText'
    if (!data || inputDisabledRef.current) return
    if (type.startsWith('delete') || type === 'insertCompositionText') return
    if (type === 'insertFromPaste' || type === 'insertFromDrop') return
    clearSelection()
    send(type === 'insertLineBreak' || type === 'insertParagraph' ? '\r' : data)
  }

  // ---- pointer --------------------------------------------------------------------------------
  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    setAllSelectedFlag(false)
    claim()
  }

  const onMouseUp = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // A plain click hands the keyboard back to the terminal; a drag keeps its selection.
    if (!hasSelection()) focusInput()
  }

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || hasSelection()) return
    const point = pointAt(event.clientX, event.clientY)
    const hit = point ? linkAtPoint(point) : null
    if (!hit) return
    event.preventDefault()
    openLink(hit.link)
  }

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const point = pointAt(event.clientX, event.clientY)
    const hit = point ? linkAtPoint(point) : null
    const action = rightClickAction({
      shiftKey: event.shiftKey,
      hasSelection: hasSelection(),
      overLink: hit !== null,
      readOnly: inputDisabledRef.current,
    })
    if (action === 'copy') {
      copySelection()
      focusInput()
    } else if (action === 'paste') {
      focusInput()
      void pasteFromClipboard()
    } else if (action === 'linkMenu' && hit) {
      setMenu({ kind: 'link', x: event.clientX, y: event.clientY, link: hit.link })
    } else {
      setMenu({ kind: 'full', x: event.clientX, y: event.clientY, copyText: selectedText() })
    }
  }

  const onMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const move = moveRef.current
    move.x = event.clientX
    move.y = event.clientY
    move.ctrl = event.ctrlKey || event.metaKey
    if (event.buttons !== 0 || move.frame !== null) return
    move.frame = requestFrame(() => {
      move.frame = null
      setCtrlHeld(move.ctrl)
      const point = pointAt(move.x, move.y)
      const hit = point ? linkAtPoint(point) : null
      setHover((current) => {
        if (!hit) return current ? null : current
        if (
          current &&
          current.link.index === hit.link.index &&
          current.link.text === hit.link.text &&
          current.ranges[0]?.line === hit.ranges[0]?.line
        ) {
          return current
        }
        return hit
      })
    })
  }

  const onMouseLeave = () => setHover(null)

  // Wheel over a full-screen program goes to the program (mouse report or arrow keys). Shift+wheel,
  // or any wheel once the input is off (ended, read only), scrolls the history the mirror captured
  // from the full-screen program natively.
  const pointAtRef = useRef(pointAt)
  pointAtRef.current = pointAt
  const sendRef = useRef(send)
  sendRef.current = send
  const rowHeightRef = useRef(rowHeight)
  rowHeightRef.current = rowHeight
  const [wheelHint, setWheelHint] = useState(false)
  const wheelHintTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (wheelHintTimerRef.current !== null) window.clearTimeout(wheelHintTimerRef.current)
    },
    [],
  )
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey && !event.ctrlKey) {
        // Windows sends Shift+wheel as a sideways scroll (deltaX, no deltaY), which this
        // viewport cannot do: unless the view really scrolls sideways, it scrolls the history.
        const sidewaysOnly = event.deltaY === 0 && event.deltaX !== 0
        if (sidewaysOnly && viewport.scrollWidth <= viewport.clientWidth) {
          const lines = getWheelScrollLines(event, rowHeightRef.current)
          if (lines !== 0) {
            event.preventDefault()
            viewport.scrollTop += lines * rowHeightRef.current
          }
        }
        return
      }
      const current = mirrorRef.current
      if (!current || current.bufferType !== 'alternate' || event.ctrlKey) return
      if (inputDisabledRef.current) return
      event.preventDefault()
      if (current.baseY > 0) {
        // Teach the way into the captured history once the wheel is taken by the program.
        setWheelHint(true)
        if (wheelHintTimerRef.current !== null) window.clearTimeout(wheelHintTimerRef.current)
        wheelHintTimerRef.current = window.setTimeout(() => setWheelHint(false), WHEEL_HINT_MS)
      }
      const lines = getWheelScrollLines(event, rowHeightRef.current)
      if (lines === 0) return
      const point = pointAtRef.current(event.clientX, event.clientY)
      const col = clamp(point?.cell ?? 0, 0, Math.max(0, current.cols - 1))
      const row = clamp(
        (point?.line ?? current.baseY) - current.baseY,
        0,
        Math.max(0, current.rows - 1),
      )
      const data = encodeWheel(lines, current.modes, { col, row })
      if (data) sendRef.current(data)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [])

  // ---- drag and drop of files (Explorer) ---------------------------------------------------------
  const [dropActive, setDropActive] = useState(false)
  useEffect(() => {
    if (inputDisabled) return
    let disposed = false
    let unlisten: (() => void) | null = null
    const isOverThis = (position: { x: number; y: number }) => {
      const ratio = window.devicePixelRatio || 1
      const element = document.elementFromPoint(position.x / ratio, position.y / ratio)
      return !!element && !!rootRef.current?.contains(element)
    }
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') {
            setDropActive(isOverThis(payload.position))
          } else if (payload.type === 'leave') {
            setDropActive(false)
          } else if (payload.type === 'drop') {
            setDropActive(false)
            if (payload.paths.length > 0 && isOverThis(payload.position)) {
              pasteText(formatDroppedPaths(payload.paths))
              focusInput()
            }
          }
        })
        .then((off) => {
          if (disposed) off()
          else unlisten = off
        })
        .catch(() => {})
    } catch {
      // Not inside the Tauri webview (tests, browser preview): no file drops to listen to.
    }
    return () => {
      disposed = true
      unlisten?.()
      setDropActive(false)
    }
  }, [focusInput, inputDisabled, pasteText])

  // ---- overlays -------------------------------------------------------------------------------
  const highlightBoxes = useMemo(() => {
    if (!searchOpen || !mirror || found.matches.length === 0)
      return [] as Array<OverlayBox & { active: boolean }>
    const boxes: Array<OverlayBox & { active: boolean }> = []
    for (
      let index = firstMatchFrom(found.matches, lineStart, mirror.cols);
      index < found.matches.length;
      index += 1
    ) {
      const match = found.matches[index]
      if (match.line >= lineEnd) break
      for (const range of matchRanges(match, mirror.cols)) {
        if (range.line < lineStart || range.line >= lineEnd) continue
        rangeBoxes(range, layout).forEach((part, partIndex) => {
          boxes.push({
            ...part,
            key: `${index}:${range.line}:${partIndex}`,
            active: index === found.active,
          })
        })
      }
    }
    return boxes
  }, [found, layout, lineEnd, lineStart, mirror, searchOpen])

  const linkBoxes = useMemo(() => {
    if (!hover || !ctrlHeld) return [] as OverlayBox[]
    const boxes: OverlayBox[] = []
    hover.ranges.forEach((range, rangeIndex) => {
      rangeBoxes(range, layout).forEach((part, partIndex) => {
        boxes.push({ ...part, key: `${rangeIndex}:${partIndex}` })
      })
    })
    return boxes
  }, [ctrlHeld, hover, layout])

  const cursorBox = useMemo(() => {
    if (!cursor || !mirror) return null
    if (cursor.y < 0 || cursor.y >= mirror.length) return null
    const slice = wrap
      ? Math.min(layout.heightOf(cursor.y) - 1, Math.floor(cursor.x / layout.sliceCols))
      : 0
    const row = layout.rowOf(cursor.y) + slice
    // x reaches `cols` while a wrap is pending; the block stays on the last cell.
    const col = Math.max(0, Math.min(cursor.x - slice * layout.sliceCols, layout.sliceCols - 1))
    let char = ' '
    let cells = 1
    const line = lines.find((candidate) => candidate.index === cursor.y)
    if (line) {
      for (const { segments } of rowRuns(line, cursor.x, cursor.x + 1)) {
        for (const segment of segments) {
          if (segment.cell === cursor.x) {
            char = segment.text.slice(0, segment.boxed ? undefined : 1)
            cells = segment.boxed ? segment.cells : 1
          }
        }
      }
    }
    return { row, col, char, cells }
  }, [cursor, layout, lines, mirror, wrap])

  // ---- render ---------------------------------------------------------------------------------
  const newLines = mirror ? Math.max(0, mirror.length + mirror.trimmed - scroll.leaveMark) : 0
  const pillLabel =
    newLines === 1
      ? t('liveTerminal.newLinesOne')
      : newLines > 1
        ? t('liveTerminal.newLines', { count: newLines })
        : version > scroll.versionAtLeave
          ? t('liveTerminal.newOutput')
          : t('liveTerminal.jumpToEnd')
  // A full-screen program has history only when the mirror captured what scrolled off its screen.
  const showPill = !!mirror && !stuck && maxScroll > 0
  /** Row where the full-screen program's current screen starts, below its captured history. */
  const altDividerRow =
    mirror && bufferType === 'alternate' && mirror.baseY > 0 ? layout.rowOf(mirror.baseY) : null

  const inputTop = cursorBox
    ? clamp(
        PAD.top + cursorBox.row * rowHeight - targetTop,
        0,
        Math.max(0, viewportHeight - rowHeight),
      )
    : PAD.top
  const inputLeft = cursorBox ? PAD.left + cursorBox.col * cellWidth : PAD.left
  const canvasWidth =
    horizontal && mirror ? PAD.left + mirror.cols * cellWidth + PAD.right : undefined

  const rootStyle = {
    '--lt-fg': palette.foreground,
    '--lt-bg': palette.background,
    '--lt-cursor': theme.cursor ?? palette.foreground,
    '--lt-cursor-text': palette.background,
    '--lt-selection': theme.selectionBackground,
    '--lt-cell-w': `${cellWidth}px`,
    '--lt-row-h': `${rowHeight}px`,
    '--lt-pad-top': `${PAD.top}px`,
    '--lt-pad-left': `${PAD.left}px`,
  } as CSSProperties

  const menuEntries: MenuEntry[] =
    menu?.kind === 'link'
      ? [
          {
            id: 'open',
            label: t(
              menu.link.kind === 'url'
                ? 'liveTerminal.menu.openLink'
                : 'liveTerminal.menu.openPath',
            ),
            icon: <ExternalLink size={14} />,
            run: () => openLink(menu.link),
          },
          ...(menu.link.kind === 'path'
            ? [
                {
                  id: 'reveal',
                  label: t('liveTerminal.menu.revealPath'),
                  icon: <FolderOpen size={14} />,
                  run: () => revealLink(menu.link),
                },
              ]
            : []),
          {
            id: 'copy',
            label: t(
              menu.link.kind === 'url'
                ? 'liveTerminal.menu.copyLink'
                : 'liveTerminal.menu.copyPath',
            ),
            icon: <Copy size={14} />,
            run: () => writeClipboard(menu.link.text),
          },
        ]
      : menu
        ? [
            {
              id: 'copy',
              label: t('liveTerminal.menu.copy'),
              icon: <Copy size={14} />,
              disabled: !menu.copyText,
              run: () => {
                if (menu.copyText) writeClipboard(menu.copyText)
                clearSelection()
              },
            },
            {
              id: 'paste',
              label: t('liveTerminal.menu.paste'),
              icon: <ClipboardPaste size={14} />,
              disabled: inputDisabled,
              run: () => void pasteFromClipboard(),
            },
            {
              id: 'selectAll',
              label: t('liveTerminal.menu.selectAll'),
              icon: <TextSelect size={14} />,
              disabled: !mirror,
              run: selectAll,
            },
            {
              id: 'find',
              label: t('liveTerminal.menu.find'),
              icon: <Search size={14} />,
              disabled: !mirror,
              run: openSearch,
            },
          ]
        : []

  const rootClass = [
    styles.root,
    focusWithin ? styles.focusWithin : '',
    dropActive ? styles.dropActive : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={rootStyle}
      data-live-terminal={ptyId}
      onFocus={onRootFocus}
      onBlur={onRootBlur}
    >
      <div
        ref={viewportRef}
        className={[
          styles.viewport,
          horizontal ? styles.viewportHorizontal : '',
          hover && ctrlHeld ? styles.overLink : '',
          allSelected ? styles.allSelected : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="log"
        aria-label={t('liveTerminal.label')}
        aria-live="off"
        tabIndex={-1}
        title={hover ? t('liveTerminal.linkHint') : undefined}
        onScroll={onScroll}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget) handleKey(event, 'viewport')
        }}
      >
        <div className={styles.canvas} style={{ height: contentHeight, width: canvasWidth }}>
          <div ref={rowsRef} className={styles.rows}>
            {rowModels.map((model) => (
              <Row key={model.row} model={model} />
            ))}
          </div>
          <div className={styles.overlays} aria-hidden="true">
            {highlightBoxes.map((part) => (
              <div
                key={`m${part.key}`}
                className={`${styles.match} ${part.active ? styles.matchActive : ''}`}
                data-match={part.active ? 'active' : 'other'}
                style={{
                  top: `calc(${part.row} * var(--lt-row-h))`,
                  left: `calc(${part.col} * var(--lt-cell-w))`,
                  width: `calc(${part.cells} * var(--lt-cell-w))`,
                }}
              />
            ))}
            {linkBoxes.map((part) => (
              <div
                key={`l${part.key}`}
                className={styles.linkLine}
                data-link-underline=""
                style={{
                  top: `calc(${part.row} * var(--lt-row-h))`,
                  left: `calc(${part.col} * var(--lt-cell-w))`,
                  width: `calc(${part.cells} * var(--lt-cell-w))`,
                }}
              />
            ))}
            {cursorBox ? (
              <div
                // A moved cursor restarts its blink, so it is solid while the user types.
                key={`${cursorBox.row}:${cursorBox.col}`}
                className={`${styles.cursor} ${
                  inputFocused && !inputDisabled ? styles.cursorSolid : styles.cursorHollow
                }`}
                data-cursor={inputFocused && !inputDisabled ? 'solid' : 'hollow'}
                style={{
                  top: `calc(${cursorBox.row} * var(--lt-row-h))`,
                  left: `calc(${cursorBox.col} * var(--lt-cell-w))`,
                  width: `calc(${cursorBox.cells} * var(--lt-cell-w))`,
                }}
              >
                {inputFocused && !inputDisabled ? cursorBox.char : null}
              </div>
            ) : null}
            {altDividerRow !== null ? (
              <div
                className={styles.altDivider}
                data-alt-divider=""
                style={{ top: `calc(${altDividerRow} * var(--lt-row-h))` }}
              >
                <span className={styles.altLabelAbove}>↑ {t('liveTerminal.altHistory')}</span>
                <span className={styles.altLabelBelow}>{t('liveTerminal.altScreen')} ↓</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <textarea
        ref={inputRef}
        className={`${styles.input} ${composing ? styles.inputComposing : ''}`}
        style={{ left: inputLeft, top: inputTop }}
        data-live-terminal-input=""
        aria-label={t('liveTerminal.inputLabel')}
        aria-readonly={inputDisabled || undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        rows={1}
        onKeyDown={(event) => handleKey(event, 'input')}
        onInput={onInput}
        onCompositionStart={() => {
          composingRef.current = true
          setComposing(true)
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false
          setComposing(false)
          const data = event.data
          event.currentTarget.value = ''
          if (data && !inputDisabledRef.current) {
            clearSelection()
            send(data)
          }
        }}
        onPaste={(event) => {
          event.preventDefault()
          if (inputDisabledRef.current) return
          const raw = event.clipboardData?.getData('text/plain') ?? ''
          if (raw) pasteText(raw)
          else void pasteFromClipboard()
        }}
        onFocus={() => setInputFocused(true)}
        onBlur={() => setInputFocused(false)}
      />

      {searchOpen ? (
        <SearchBar
          query={query}
          caseSensitive={caseSensitive}
          regex={regex}
          current={found.active >= 0 ? found.active + 1 : 0}
          total={found.matches.length}
          invalid={found.invalid}
          inputRef={searchInputRef}
          onQuery={setQuery}
          onToggleCase={() => setCaseSensitive((value) => !value)}
          onToggleRegex={() => setRegex((value) => !value)}
          onNext={() => stepMatch(1)}
          onPrevious={() => stepMatch(-1)}
          onClose={closeSearch}
        />
      ) : null}

      {showPill ? (
        <button
          type="button"
          className={styles.pill}
          title={t('liveTerminal.jumpHint')}
          onClick={() => {
            jumpToBottom()
            focusInput()
          }}
        >
          {pillLabel}
        </button>
      ) : null}

      {exited ? <div className={styles.exited}>{t('liveTerminal.exited')}</div> : null}
      {!exited && readOnly && mirror ? (
        <div className={styles.exited}>{t('liveTerminal.readOnly')}</div>
      ) : null}
      {!mirror ? <div className={styles.waiting}>{t('liveTerminal.waiting')}</div> : null}
      {dropActive ? <div className={styles.dropHint}>{t('liveTerminal.dropHint')}</div> : null}
      {wheelHint && bufferType === 'alternate' ? (
        <div className={styles.wheelHint} role="note">
          {t('liveTerminal.altWheelHint')}
        </div>
      ) : null}

      {menu ? (
        <TerminalMenu
          x={menu.x}
          y={menu.y}
          label={t(
            menu.kind === 'link' ? 'liveTerminal.menu.linkLabel' : 'liveTerminal.menu.label',
          )}
          heading={menu.kind === 'link' ? menu.link.text : undefined}
          entries={menuEntries}
          onClose={closeMenu}
        />
      ) : null}

      <div className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </div>
      <span ref={probeRef} className={styles.probe} aria-hidden="true">
        {PROBE_TEXT}
      </span>
    </div>
  )
}
