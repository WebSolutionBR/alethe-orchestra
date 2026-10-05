const ESC = '\x1b'

/**
 * Sequences that leave the screen in a state the stream itself defines: after
 * one of these, everything that follows can be replayed exactly as recorded.
 */
const ANCHORS = [`${ESC}[2J`, `${ESC}[3J`, `${ESC}[?1049h`, `${ESC}c`]

/** DEC private mode set/reset: CSI ? Pm h | CSI ? Pm l. */
const DEC_MODE = /\x1b\[\?([0-9;]*)([hl])/g
/** DECSTBM: CSI Pt ; Pb r, with no private marker or intermediate byte. */
const SCROLL_REGION = /\x1b\[(\d*(?:;\d*)?)r/g
/** Full reset (RIS): every mode before it is gone. */
const FULL_RESET = `${ESC}c`

const ALT_SCREEN_MODES = new Set([47, 1047, 1049])
/** Mouse tracking protocols: the last one set wins, and resetting any of them turns tracking off. */
const MOUSE_PROTOCOLS = new Set([9, 1000, 1002, 1003])
/** Mouse report encodings: the last one set wins, resetting it goes back to the default bytes. */
const MOUSE_ENCODINGS = new Set([1005, 1006, 1015, 1016])
/**
 * Plain switches that outlive a screen clear and change what the program's later
 * output or the user's input does: cursor keys (1), autowrap (7), cursor
 * visibility (25), focus reports (1004) and bracketed paste (2004).
 */
const SWITCHES = new Set([1, 7, 25, 1004, 2004])
const SWITCHES_ON_BY_DEFAULT = new Set([7, 25])
/** How far into a cut tail the first safe parse point is looked for. */
const SAFE_START_WINDOW = 4096

export type ReplayModes = {
  altScreen: boolean
  mouseProtocol: number | null
  mouseEncoding: number | null
  switches: Map<number, boolean>
  /** DECSTBM parameters of the buffer that is active at the end, null when unset. */
  scrollRegion: string | null
}

/**
 * Prepares a recorded PTY stream to be written back into a terminal that was
 * just reset and sized to the PTY's current geometry.
 *
 * The backend hands back the tail of the raw stream, cut on a byte count. That
 * stream is the recording of programs drawing themselves: absolute cursor moves,
 * line erases, redraws in place, and — on Windows — runs of spaces that ConPTY
 * encodes as cursor moves (`CSI n G`) instead of space characters. Only a
 * terminal parser at the PTY's width reproduces it, so the stream is replayed
 * as recorded, never stripped down to text: stripping the moves glued every
 * word together and stair-stepped every line.
 *
 * The replay starts at the last point where the program defined the screen
 * itself (a clear, a reset, entering the alternate screen), or — when the tail
 * was cut (`cut`, assumed unless the caller knows better) — at its first clean
 * parse point. The modes the program set before that point — the alternate
 * screen, mouse tracking, bracketed paste, cursor keys — are re-established
 * first: a full-screen agent restored outside the alternate screen never
 * receives the mouse wheel again.
 */
export function prepareReplayForRestore(raw: string, options: { cut?: boolean } = {}): string {
  if (!raw) return raw
  const anchor = findReplayAnchor(raw)
  const start = anchor >= 0 ? anchor : options.cut === false ? 0 : findSafeStart(raw)
  return replayModesPreamble(scanReplayModes(raw, start)) + raw.slice(start)
}

/**
 * Whether a tail fetched with `attachPty(id, maxBytes)` may have been cut: the
 * backend returns the last `maxBytes` bytes, moved forward to a character
 * boundary, so anything shorter than that is the whole recording.
 */
export function isReplayTailCut(raw: string, maxBytes: number): boolean {
  return new TextEncoder().encode(raw).length >= maxBytes - 3
}

/** Index of the last anchor in the stream, or -1. */
export function findReplayAnchor(raw: string): number {
  let anchor = -1
  for (const marker of ANCHORS) {
    const found = raw.lastIndexOf(marker)
    if (found > anchor) anchor = found
  }
  return anchor
}

/**
 * First index where xterm's parser is certainly in its ground state: the tail
 * may begin inside an escape sequence, whose parameters would print as text.
 */
export function findSafeStart(raw: string): number {
  const window = raw.slice(0, SAFE_START_WINDOW)
  const escape = window.indexOf(ESC)
  const lineFeed = window.indexOf('\n')
  const afterLineFeed = lineFeed === -1 ? -1 : lineFeed + 1
  const candidates = [escape, afterLineFeed].filter((index) => index >= 0)
  return candidates.length > 0 ? Math.min(...candidates) : 0
}

/** State of the modes that outlive a screen clear, as the stream left them right before `end`. */
export function scanReplayModes(raw: string, end: number): ReplayModes {
  const reset = raw.lastIndexOf(FULL_RESET, end - 1)
  const from = reset >= 0 && reset < end ? reset + FULL_RESET.length : 0
  const scope = raw.slice(from, end)

  type Event = { index: number; apply: () => void }
  const events: Event[] = []
  const state: ReplayModes = {
    altScreen: false,
    mouseProtocol: null,
    mouseEncoding: null,
    switches: new Map(),
    scrollRegion: null,
  }
  // Each buffer keeps its own scroll margins.
  const regions: [string | null, string | null] = [null, null]

  for (const match of scope.matchAll(DEC_MODE)) {
    const on = match[2] === 'h'
    const modes = match[1]
      .split(';')
      .filter(Boolean)
      .map((value) => Number(value))
    events.push({
      index: match.index ?? 0,
      apply: () => {
        for (const mode of modes) {
          if (ALT_SCREEN_MODES.has(mode)) state.altScreen = on
          else if (MOUSE_PROTOCOLS.has(mode)) state.mouseProtocol = on ? mode : null
          else if (MOUSE_ENCODINGS.has(mode)) state.mouseEncoding = on ? mode : null
          else if (SWITCHES.has(mode)) state.switches.set(mode, on)
        }
      },
    })
  }
  for (const match of scope.matchAll(SCROLL_REGION)) {
    const params = match[1]
    events.push({
      index: match.index ?? 0,
      apply: () => {
        regions[state.altScreen ? 1 : 0] = params && params !== ';' ? params : null
      },
    })
  }
  events.sort((a, b) => a.index - b.index)
  for (const event of events) event.apply()
  state.scrollRegion = regions[state.altScreen ? 1 : 0]
  return state
}

/** Sequences that put a freshly reset terminal into `modes`; empty when everything is default. */
export function replayModesPreamble(modes: ReplayModes): string {
  let out = modes.altScreen ? `${ESC}[?1049h` : ''
  for (const [mode, on] of modes.switches) {
    if (on !== SWITCHES_ON_BY_DEFAULT.has(mode)) out += `${ESC}[?${mode}${on ? 'h' : 'l'}`
  }
  if (modes.mouseProtocol !== null) out += `${ESC}[?${modes.mouseProtocol}h`
  if (modes.mouseEncoding !== null) out += `${ESC}[?${modes.mouseEncoding}h`
  if (modes.scrollRegion) out += `${ESC}[${modes.scrollRegion}r`
  return out
}
