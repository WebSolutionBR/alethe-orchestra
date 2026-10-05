import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TERMINAL_MODE,
  isTerminalModeShortcut,
  parseTerminalMode,
  TERMINAL_MODE_KEY,
  useTerminalModeStore,
} from './terminalMode'

const chord = (patch: Partial<KeyboardEvent> = {}) => ({
  code: 'KeyL',
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...patch,
})

describe('terminal mode preference', () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_MODE_KEY)
    useTerminalModeStore.setState({ mode: DEFAULT_TERMINAL_MODE })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(TERMINAL_MODE_KEY)
  })

  it('defaults to the live transcript for missing or unknown values', () => {
    expect(DEFAULT_TERMINAL_MODE).toBe('live')
    expect(parseTerminalMode(null)).toBe('live')
    expect(parseTerminalMode('xterm')).toBe('live')
    expect(parseTerminalMode('live')).toBe('live')
    expect(parseTerminalMode('classic')).toBe('classic')
  })

  it('toggles between live and classic and remembers the choice', () => {
    useTerminalModeStore.getState().toggle()
    expect(useTerminalModeStore.getState().mode).toBe('classic')
    expect(localStorage.getItem(TERMINAL_MODE_KEY)).toBe('classic')

    useTerminalModeStore.getState().toggle()
    expect(useTerminalModeStore.getState().mode).toBe('live')
    expect(localStorage.getItem(TERMINAL_MODE_KEY)).toBe('live')
  })

  it('reads the remembered mode when the module loads', async () => {
    localStorage.setItem(TERMINAL_MODE_KEY, 'classic')
    vi.resetModules()
    const fresh = await import('./terminalMode')
    expect(fresh.useTerminalModeStore.getState().mode).toBe('classic')
  })

  it('still switches when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    useTerminalModeStore.getState().setMode('classic')
    expect(useTerminalModeStore.getState().mode).toBe('classic')
  })
})

describe('isTerminalModeShortcut', () => {
  it('matches Ctrl+Shift+L by the physical key', () => {
    expect(isTerminalModeShortcut(chord())).toBe(true)
    expect(isTerminalModeShortcut(chord({ ctrlKey: false, metaKey: true }))).toBe(true)
  })

  it('leaves the neighbouring shortcuts alone', () => {
    // Ctrl+L clears the screen in the terminal, Ctrl+Alt is AltGr on ABNT2.
    expect(isTerminalModeShortcut(chord({ shiftKey: false }))).toBe(false)
    expect(isTerminalModeShortcut(chord({ altKey: true }))).toBe(false)
    expect(isTerminalModeShortcut(chord({ ctrlKey: false }))).toBe(false)
    expect(isTerminalModeShortcut(chord({ code: 'KeyM' }))).toBe(false)
    expect(isTerminalModeShortcut(chord({ code: 'Enter' }))).toBe(false)
  })
})
