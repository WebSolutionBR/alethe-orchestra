import { create } from 'zustand'

/**
 * How the Orchestra shows an agent's terminal: `live` is the transcript rendered from the PTY's
 * mirror (LiveTerminal), `classic` the xterm.js view. One preference for every Orchestra
 * terminal (agent drawer and Terminals view cells), remembered across sessions.
 */
export type TerminalMode = 'live' | 'classic'

export const TERMINAL_MODE_KEY = 'orchestra.terminalMode'
export const DEFAULT_TERMINAL_MODE: TerminalMode = 'live'

/** Display text of the toggle shortcut; `isTerminalModeShortcut` is the matching check. */
export const TERMINAL_MODE_SHORTCUT = 'Ctrl+Shift+L'

/** Anything but a stored `classic` (missing, corrupt, older values) means the default. */
export function parseTerminalMode(value: unknown): TerminalMode {
  return value === 'classic' ? 'classic' : DEFAULT_TERMINAL_MODE
}

function load(): TerminalMode {
  try {
    return parseTerminalMode(localStorage.getItem(TERMINAL_MODE_KEY))
  } catch {
    // Unreadable storage just means the default mode.
    return DEFAULT_TERMINAL_MODE
  }
}

type TerminalModeState = {
  mode: TerminalMode
  setMode: (mode: TerminalMode) => void
  toggle: () => void
}

export const useTerminalModeStore = create<TerminalModeState>((set, get) => ({
  mode: load(),
  setMode: (mode) => {
    set({ mode })
    try {
      localStorage.setItem(TERMINAL_MODE_KEY, mode)
    } catch {
      // Non-persistent storage only loses the remembered mode.
    }
  },
  toggle: () => get().setMode(get().mode === 'live' ? 'classic' : 'live'),
}))

export function useTerminalMode(): TerminalMode {
  return useTerminalModeStore((s) => s.mode)
}

type KeyChord = Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/**
 * Ctrl+Shift+L ("live"). Free in the app shell (useKeybindings), in the Orchestra (Alt+1-6,
 * Alt+PageUp/PageDown, Ctrl+Shift+M, Ctrl+Shift+Enter) and in Claude Code. Matched by the
 * physical key so it works on any layout, and caught in the capture phase before a terminal.
 */
export function isTerminalModeShortcut(e: KeyChord): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyL'
}
