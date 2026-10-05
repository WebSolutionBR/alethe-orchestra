import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// A full-screen program whose scrolled-off lines the mirror kept: history above baseY, screen below.
vi.mock('../../lib/terminalMirror', () => ({
  getMirror: (id: string) => mirrors.get(id) ?? null,
  onMirrorRegistry: () => () => {},
  ensureMirror: () => {
    throw new Error('not used')
  },
  seedMirror: async () => {},
  encodeKey: (event: { key: string }) => (event.key === 'Enter' ? '\r' : null),
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

function altMirror(id: string): TerminalMirror {
  const text = (index: number) =>
    index < HISTORY ? `history ${index}` : `screen ${index - HISTORY}`
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
      Array.from({ length: Math.max(0, Math.min(end, HISTORY + ROWS) - start) }, (_, offset) => {
        const value = text(start + offset)
        return {
          index: start + offset,
          wrapped: false,
          runs: [
            {
              text: value,
              cells: value.length,
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
        }
      }),
    getText: () => '',
    search: () => [],
    onChange: () => () => {},
    resize: () => {},
  }
  mirrors.set(id, mirror)
  return mirror
}

function viewportOf(container: HTMLElement): HTMLDivElement {
  return container.querySelector('[role="log"]') as HTMLDivElement
}

afterEach(() => {
  cleanup()
  mirrors.clear()
  tauri.writePty.mockClear()
})

describe('LiveTerminal over a full-screen program with captured history', () => {
  it('marks where the current screen starts under the captured history', () => {
    altMirror('alt')
    const { container } = render(<LiveTerminal ptyId="alt" />)
    const divider = container.querySelector('[data-alt-divider]') as HTMLElement
    expect(divider).not.toBeNull()
    expect(divider.style.top).toBe(`calc(${HISTORY} * var(--lt-row-h))`)
    expect(divider.textContent).toContain('Captured full-screen history')
    expect(divider.textContent).toContain('Current screen')
    // Glued to the end: the program's screen is what shows.
    expect(container.textContent).toContain('screen 0')
  })

  it('sends the wheel to the program and teaches Shift+wheel', async () => {
    altMirror('alt')
    const { container } = render(<LiveTerminal ptyId="alt" />)
    const notPrevented = fireEvent.wheel(viewportOf(container), { deltaY: 2, deltaMode: 1 })
    expect(notPrevented).toBe(false)
    await waitFor(() => expect(tauri.writePty).toHaveBeenCalledWith('alt', '\x1b[B\x1b[B'))
    expect(
      screen.getByText(
        'Full screen: the wheel goes to the program · Shift+wheel scrolls the history',
      ),
    ).toBeInTheDocument()
    // Shift+wheel is left to the browser: it scrolls the captured history.
    expect(
      fireEvent.wheel(viewportOf(container), { deltaY: 2, deltaMode: 1, shiftKey: true }),
    ).toBe(true)
  })

  it('lets the wheel scroll the history natively once the input is off', async () => {
    altMirror('alt')
    const { container } = render(<LiveTerminal ptyId="alt" readOnly />)
    expect(fireEvent.wheel(viewportOf(container), { deltaY: 2, deltaMode: 1 })).toBe(true)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(tauri.writePty).not.toHaveBeenCalled()
    expect(screen.queryByText(/Shift\+wheel scrolls the history/)).toBeNull()
  })

  it('offers the new-lines pill after scrolling up into the history', () => {
    altMirror('alt')
    const { container } = render(<LiveTerminal ptyId="alt" />)
    const viewport = viewportOf(container)
    let top = 0
    const height = 4 + ROWS * 17 + 2
    const scrollHeight = () => parseFloat((viewport.firstElementChild as HTMLElement).style.height)
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => height })
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: scrollHeight })
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
      },
    })
    fireEvent.scroll(viewport)
    expect(screen.getByRole('button', { name: '↓ Jump to the end' })).toBeInTheDocument()
  })
})
