import { isMenuKey } from './pointerMenu'

export type KeyEventLike = {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  /** AltGr held; Windows also reports it as Ctrl+Alt. */
  altGraph?: boolean
}

export type KeyIntent =
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'find' }
  | { kind: 'menu' }
  | { kind: 'scroll'; to: 'pageUp' | 'pageDown' | 'top' | 'bottom' }
  /** One of the app's own shortcuts (zoom, sidebar): the event is left alone. */
  | { kind: 'app' }
  /** Printable text: the hidden textarea's input event delivers it, so IME and dead keys work. */
  | { kind: 'text' }
  /** Everything else: `encodeKey` decides what, if anything, the PTY gets. */
  | { kind: 'terminal' }

const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0'])
const ZOOM_CODES = new Set(['NumpadAdd', 'NumpadSubtract', 'Numpad0'])

/** A single printable character (not a key name such as "Enter" or "Dead"). */
export function isPrintableKey(key: string): boolean {
  if (!key) return false
  const chars = Array.from(key)
  return chars.length === 1 && key >= ' ' && key !== '\u007f'
}

/** What a keydown means inside the live terminal, before any byte is sent to the PTY. */
export function classifyKey(event: KeyEventLike, hasSelection: boolean): KeyIntent {
  if (isMenuKey(event)) return { kind: 'menu' }

  const ctrl = event.ctrlKey || event.metaKey
  const key = event.key
  const lower = key.length === 1 ? key.toLowerCase() : key

  // AltGr text (Windows also reports Ctrl+Alt): "/" or "?" on ABNT2, "@" or "€" on many layouts.
  // getModifierState('AltGraph') is authoritative when the caller has it; otherwise Ctrl+Alt with
  // a non-letter character is taken as AltGr.
  const altGraph = event.altGraph ?? (event.ctrlKey && event.altKey && !/^[a-z]$/i.test(key))
  if (altGraph && isPrintableKey(key)) return { kind: 'text' }

  if (ctrl && !event.altKey) {
    if (lower === 'c' && (event.shiftKey || hasSelection)) return { kind: 'copy' }
    if (key === 'Insert' && !event.shiftKey) return { kind: 'copy' }
    if (lower === 'v') return { kind: 'paste' }
    if (lower === 'f' && !event.shiftKey) return { kind: 'find' }
    if (!event.shiftKey && key === 'Home') return { kind: 'scroll', to: 'top' }
    if (!event.shiftKey && key === 'End') return { kind: 'scroll', to: 'bottom' }
    if (ZOOM_KEYS.has(key) || (event.code !== undefined && ZOOM_CODES.has(event.code))) {
      return { kind: 'app' }
    }
    if (lower === 'b' && !event.shiftKey) return { kind: 'app' }
  }

  if (event.shiftKey && !ctrl && !event.altKey) {
    if (key === 'Insert') return { kind: 'paste' }
    if (key === 'PageUp') return { kind: 'scroll', to: 'pageUp' }
    if (key === 'PageDown') return { kind: 'scroll', to: 'pageDown' }
  }

  if (!ctrl && !event.altKey && isPrintableKey(key)) return { kind: 'text' }
  return { kind: 'terminal' }
}
