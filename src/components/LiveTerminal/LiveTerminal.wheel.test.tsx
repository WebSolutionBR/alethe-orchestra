import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MirrorLine, TerminalMirror } from '../../lib/terminalMirror'

const tauri = vi.hoisted(() => ({
  writePty: vi.fn(async (_id: string, _data: string) => {}),
  resizePty: vi.fn(async () => {}),
  readClipboardPayload: vi.fn(async () => ({ kind: 'empty' as const })),
  writeClipboardText: vi.fn(async () => {}),
  openInBrowser: vi.fn(async () => {}),
  openInFileExplorer: vi.fn(async () => {}),
  ptyExists: vi.fn(async () => false),
}))

const mirrors = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../../lib/tauri', () => tauri)

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))

vi.mock('../../lib/terminalMirror', () => ({
  getMirror: (id: string) => mirrors.get(id) ?? null,
  onMirrorRegistry: () => () => {},
  ensureMirror: () => {
    throw new Error('not used')
  },
  seedMirror: async () => {},
  encodeKey: () => null,
  encodeWheel: (lines: number) => (lines > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(lines)),
  mirrorPaletteFromTheme: (theme: { foreground?: string; background?: string }) => ({
    foreground: theme.foreground ?? '#ffffff',
    background: theme.background ?? '#000000',
    ansi: [],
  }),
}))

import { LiveTerminal } from './index'

const HISTORY = 30
const ROWS = 6

/** A full-screen program whose scrolled-off lines the mirror kept above its screen. */
function altMirror(id: string): TerminalMirror {
  const mirror: TerminalMirror = {
    ptyId: id,
    cols: 40,
    rows: ROWS,
    bufferType: 'alternate',
    length: HISTORY + ROWS,
    baseY: HISTORY,
    cursor: { x: 0, y: HISTORY + 1, visible: false },
    modes: { applicationCursorKeys: false, bracketedPaste: false, mouseTracking: 'none' },
    exited: false,
    trimmed: 0,
    getLines: (start: number, end: number): MirrorLine[] =>
      Array.from({ length: Math.max(0, Math.min(end, HISTORY + ROWS) - start) }, (_, offset) => ({
        index: start + offset,
        wrapped: false,
        runs: [
          {
            text: `line ${start + offset}`,
            cells: `line ${start + offset}`.length,
            fg: null,
            bg: null,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            strike: false,
            invisible: false,
          },
        ],
      })),
    getText: () => '',
    search: () => [],
    onChange: () => () => {},
    resize: () => {},
  }
  mirrors.set(id, mirror)
  return mirror
}

/** The viewport with a scroll position the test can read (jsdom has no layout). */
function viewportWithScroll(container: HTMLElement, sideways = false) {
  const viewport = container.querySelector('[role="log"]') as HTMLDivElement
  const state = { top: 200 }
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = value
    },
  })
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => 300 })
  Object.defineProperty(viewport, 'scrollWidth', {
    configurable: true,
    get: () => (sideways ? 600 : 300),
  })
  return { viewport, state }
}

afterEach(() => {
  cleanup()
  mirrors.clear()
  tauri.writePty.mockClear()
})

describe('Shift+wheel on Windows, where it arrives as a sideways scroll', () => {
  it('scrolls the captured history, never the program', () => {
    altMirror('alt')
    const { container } = render(<LiveTerminal ptyId="alt" />)
    const { viewport, state } = viewportWithScroll(container)
    // Chromium on Windows turns Shift+wheel into deltaX with no deltaY.
    const notPrevented = fireEvent.wheel(viewport, {
      deltaX: -3,
      deltaY: 0,
      deltaMode: 1,
      shiftKey: true,
    })
    expect(notPrevented).toBe(false)
    expect(state.top).toBeLessThan(200)
    expect(tauri.writePty).not.toHaveBeenCalled()

    fireEvent.wheel(viewport, { deltaX: 3, deltaY: 0, deltaMode: 1, shiftKey: true })
    expect(state.top).toBe(200)
  })

  it('stays a sideways scroll where the view really scrolls sideways', () => {
    altMirror('alt')
    const { container } = render(<LiveTerminal ptyId="alt" />)
    const { viewport, state } = viewportWithScroll(container, true)
    const notPrevented = fireEvent.wheel(viewport, {
      deltaX: 3,
      deltaY: 0,
      deltaMode: 1,
      shiftKey: true,
    })
    expect(notPrevented).toBe(true)
    expect(state.top).toBe(200)
  })
})
