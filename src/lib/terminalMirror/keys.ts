import type { KeyLike, MirrorModes } from './types'

const ESC = '\x1b'

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4) + meta(8). */
function modifierParam(event: KeyLike): number {
  return (
    1 +
    (event.shiftKey ? 1 : 0) +
    (event.altKey ? 2 : 0) +
    (event.ctrlKey ? 4 : 0) +
    (event.metaKey ? 8 : 0)
  )
}

const ARROWS: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
}
const SS3_FUNCTION_KEYS: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }
const TILDE_FUNCTION_KEYS: Record<string, number> = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
}

/** Ctrl+symbol control bytes (VT220 / xterm conventions). */
const CTRL_SYMBOLS: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '2': '\x00',
  '3': '\x1b',
  '[': '\x1b',
  '4': '\x1c',
  '\\': '\x1c',
  '5': '\x1d',
  ']': '\x1d',
  '6': '\x1e',
  '^': '\x1e',
  '7': '\x1f',
  '/': '\x1f',
  '8': '\x7f',
}

/** Physical-key fallback for Ctrl+symbol on layouts where `key` is not the US character. */
const CTRL_SYMBOL_CODES: Record<string, string> = {
  Space: '\x00',
  BracketLeft: '\x1b',
  Backslash: '\x1c',
  BracketRight: '\x1d',
  Slash: '\x1f',
}

/**
 * Chords the app keeps for itself, exactly like XTermView's custom key handler: zoom
 * (Ctrl +/=/-/_/0 and the numpad keys) and Ctrl+B (sidebar).
 */
function isAppShortcut(event: KeyLike): boolean {
  if (!event.ctrlKey || event.altKey) return false
  const key = event.key.toLowerCase()
  if (key === '+' || key === '=' || key === '-' || key === '_' || key === '0') return true
  if (event.code === 'NumpadAdd' || event.code === 'NumpadSubtract' || event.code === 'Numpad0') {
    return true
  }
  return key === 'b' && !event.shiftKey
}

function isSingleChar(key: string): boolean {
  if (key.length === 1) return true
  // An astral character (emoji, CJK extension) is one key but two UTF-16 units.
  return key.length === 2 && key.codePointAt(0)! > 0xffff
}

/** The letter of a Ctrl/Alt chord: the layout's letter when it is ASCII, else the physical key. */
function chordLetter(event: KeyLike): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key
  const physical = /^Key([A-Z])$/.exec(event.code ?? '')
  return physical ? physical[1] : null
}

function ctrlByte(letter: string): string {
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64)
}

function namedKey(
  event: KeyLike,
  modes: Pick<MirrorModes, 'applicationCursorKeys'>,
): string | null | undefined {
  const mod = modifierParam(event)
  const modified = mod > 1
  const arrow = ARROWS[event.key]
  if (arrow) {
    if (!modified) return modes.applicationCursorKeys ? `${ESC}O${arrow}` : `${ESC}[${arrow}`
    // xterm.js on Windows/Linux turns Alt+arrow into Ctrl+arrow (word movement in shells).
    return `${ESC}[1;${mod === 3 ? 5 : mod}${arrow}`
  }
  const ss3 = SS3_FUNCTION_KEYS[event.key]
  if (ss3) return modified ? `${ESC}[1;${mod}${ss3}` : `${ESC}O${ss3}`
  const tilde = TILDE_FUNCTION_KEYS[event.key]
  if (tilde) return modified ? `${ESC}[${tilde};${mod}~` : `${ESC}[${tilde}~`
  switch (event.key) {
    case 'Enter':
      return event.altKey ? `${ESC}\r` : '\r'
    case 'Backspace': {
      const erase = event.ctrlKey ? '\b' : '\x7f'
      return event.altKey ? ESC + erase : erase
    }
    case 'Tab':
      // Ctrl+Tab belongs to the host (tab cycling); Shift+Tab is back-tab.
      if (event.ctrlKey) return null
      return event.shiftKey ? `${ESC}[Z` : '\t'
    case 'Escape':
      return event.altKey ? ESC + ESC : ESC
    case 'Home':
    case 'End': {
      const final = event.key === 'Home' ? 'H' : 'F'
      if (modified) return `${ESC}[1;${mod}${final}`
      return modes.applicationCursorKeys ? `${ESC}O${final}` : `${ESC}[${final}`
    }
    case 'Insert':
      // Shift+Insert / Ctrl+Insert are paste / copy.
      return event.shiftKey || event.ctrlKey ? null : `${ESC}[2~`
    case 'Delete':
      return modified ? `${ESC}[3;${mod}~` : `${ESC}[3~`
    case 'PageUp':
    case 'PageDown': {
      // Shift+PageUp/PageDown scroll the host's history.
      if (event.shiftKey) return null
      const code = event.key === 'PageUp' ? 5 : 6
      return event.ctrlKey ? `${ESC}[${code};${mod}~` : `${ESC}[${code}~`
    }
    default:
      return undefined
  }
}

/**
 * Bytes a VT terminal sends for this keydown; null = not a terminal key (let the browser have it).
 *
 * Mirrors xterm.js's keyboard table (Windows flavor). Ctrl+C / Ctrl+V keep their VT meaning (^C, ^V):
 * copying a selection or pasting is the view's call, made before asking here. Shift+PageUp/PageDown,
 * Shift/Ctrl+Insert, Ctrl+Tab, Ctrl+Shift+letter, Meta chords and the app's own shortcuts return null.
 */
export function encodeKey(
  event: KeyLike,
  modes: Pick<MirrorModes, 'applicationCursorKeys'>,
): string | null {
  if (event.metaKey) return null
  if (isAppShortcut(event)) return null

  const named = namedKey(event, modes)
  if (named !== undefined) return named

  if (event.ctrlKey && event.altKey) {
    // Windows reports AltGr as Ctrl+Alt: a character it produced is plain text.
    if (isSingleChar(event.key) && !/^[a-z]$/i.test(event.key)) return event.key
    const letter = chordLetter(event)
    return letter ? ESC + ctrlByte(letter) : null
  }

  if (event.ctrlKey) {
    const letter = chordLetter(event)
    // Ctrl+Shift+letter is the host's (copy, paste, the Orchestra composer...).
    if (letter) return event.shiftKey ? null : ctrlByte(letter)
    return (
      CTRL_SYMBOLS[event.key] ?? (event.code ? CTRL_SYMBOL_CODES[event.code] : undefined) ?? null
    )
  }

  if (event.altKey) {
    if (isSingleChar(event.key)) return ESC + event.key
    // Alt+letter that starts a dead-key composition on some layouts (xterm.js #3725).
    if (event.key === 'Dead' && event.code?.startsWith('Key')) {
      const letter = event.code.slice(3, 4)
      return ESC + (event.shiftKey ? letter : letter.toLowerCase())
    }
    return null
  }

  return isSingleChar(event.key) ? event.key : null
}

const WHEEL_UP = 64
const WHEEL_DOWN = 65

/**
 * Wheel in the alternate buffer: SGR/X10 mouse wheel when tracking is on, else arrow keys.
 *
 * `lines` is signed (negative = up). With mouse tracking (VT200/drag/any) one wheel report is sent
 * per call, as xterm.js does per wheel event; X10 tracking reports no wheel, so it falls back to
 * arrows like no tracking at all, |lines| of them. `cell` is the 0-based position of the pointer.
 */
export function encodeWheel(
  lines: number,
  modes: MirrorModes,
  cell: { col: number; row: number },
): string {
  const steps = Math.trunc(lines)
  if (steps === 0) return ''
  const up = steps < 0
  if (
    modes.mouseTracking === 'vt200' ||
    modes.mouseTracking === 'drag' ||
    modes.mouseTracking === 'any'
  ) {
    const button = up ? WHEEL_UP : WHEEL_DOWN
    const col = Math.max(0, Math.floor(cell.col)) + 1
    const row = Math.max(0, Math.floor(cell.row)) + 1
    if (modes.mouseEncoding === 'sgr') return `${ESC}[<${button};${col};${row}M`
    // X10 byte encoding: each value + 32 in a single byte, so it cannot address past 223.
    const codes = [button + 32, col + 32, row + 32]
    if (codes.some((code) => code > 255)) return ''
    return `${ESC}[M${String.fromCharCode(...codes)}`
  }
  const arrow = up ? 'A' : 'B'
  const sequence = modes.applicationCursorKeys ? `${ESC}O${arrow}` : `${ESC}[${arrow}`
  return sequence.repeat(Math.abs(steps))
}
