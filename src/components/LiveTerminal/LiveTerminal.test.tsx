import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pty = vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  return {
    data: new Map<string, (chunk: string) => void>(),
    exit: new Map<string, (payload: { code: number | null; reason: string }) => void>(),
  }
})

const tauri = vi.hoisted(() => ({
  writePty: vi.fn(async (_id: string, _data: string) => {}),
  resizePty: vi.fn(async (_id: string, _cols: number, _rows: number) => {}),
  readClipboardPayload: vi.fn(
    async (): Promise<
      | { kind: 'text'; text: string }
      | { kind: 'paths'; paths: string[] }
      | { kind: 'image'; path: string }
      | { kind: 'empty' }
    > => ({ kind: 'text', text: 'pasted' }),
  ),
  writeClipboardText: vi.fn(async (_text: string) => {}),
  openInBrowser: vi.fn(async (_target: string) => {}),
  openInFileExplorer: vi.fn(async (_target: string) => {}),
  ptyExists: vi.fn(async (_id: string) => false),
}))

vi.mock('../../lib/tauri', () => tauri)

// The mirror subscribes to the PTY streams through these; tests write with feedMirror instead.
vi.mock('../../lib/tauri/pty', () => ({
  listenPtyData: async (id: string, handler: (chunk: string) => void) => {
    pty.data.set(id, handler)
    return () => pty.data.delete(id)
  },
  listenPtyActivity: async () => () => {},
  listenPtyExit: async (
    id: string,
    handler: (payload: { code: number | null; reason: string }) => void,
  ) => {
    pty.exit.set(id, handler)
    return () => pty.exit.delete(id)
  },
  attachPty: async () => '',
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))

import { disposeMirror, ensureMirror, feedMirror, getMirror } from '../../lib/terminalMirror'
import { forgetTerminalSize, rememberTerminalSize } from '../../lib/terminalSizes'
import { MIRROR_FALLBACK_MS } from './hooks'
import { LiveTerminal } from './index'

const created = new Set<string>()

function mirrorFor(id = 'p1', cols = 40, rows = 6, scrollback?: number) {
  created.add(id)
  return ensureMirror(id, { cols, rows, scrollback })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Lets the mirror's frame-coalesced change notification reach the view. */
async function settle(ms = 40) {
  await act(async () => {
    await wait(ms)
  })
}

async function feed(id: string, text: string) {
  await act(async () => {
    feedMirror(id, text)
    await wait(40)
  })
}

function viewportOf(container: HTMLElement): HTMLDivElement {
  return container.querySelector('[role="log"]') as HTMLDivElement
}

function inputOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('[data-live-terminal-input]') as HTMLTextAreaElement
}

function rowOf(container: HTMLElement, line: number, c0 = 0): HTMLElement {
  return container.querySelector(`[data-line="${line}"][data-c0="${c0}"]`) as HTMLElement
}

function firstText(row: HTMLElement): Node {
  return row.querySelector('[data-c]')!.firstChild!
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function dispatchCopy() {
  const setData = vi.fn()
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { setData } })
  document.dispatchEvent(event)
  return { event, setData }
}

/** Everything written to the PTY so far, in order. */
function written(): string {
  return tauri.writePty.mock.calls.map((call) => call[1]).join('')
}

/** Fake layout box for the scroll container (jsdom has no layout). */
function fakeScroll(viewport: HTMLDivElement, clientHeight: number) {
  const state = { top: 0 }
  const scrollHeight = () => parseFloat((viewport.firstElementChild as HTMLElement).style.height)
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: scrollHeight })
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = Math.max(0, Math.min(value, scrollHeight() - clientHeight))
    },
  })
  return state
}

/** Gives the scroll containers a real-looking client box. */
function fakeBox(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'log' ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('role') === 'log' ? height : 0
  })
}

afterEach(() => {
  cleanup()
  for (const id of created) disposeMirror(id)
  created.clear()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  tauri.writePty.mockClear()
  tauri.resizePty.mockClear()
  tauri.readClipboardPayload.mockClear()
  tauri.writeClipboardText.mockClear()
  tauri.openInBrowser.mockClear()
  tauri.openInFileExplorer.mockClear()
})

describe('LiveTerminal rendering', () => {
  it('waits for the mirror, then renders its lines', async () => {
    const { container } = render(<LiveTerminal ptyId="p1" />)
    expect(screen.getByText('Waiting for the terminal…')).toBeInTheDocument()
    await act(async () => {
      mirrorFor('p1')
    })
    await feed('p1', 'hello world')
    expect(screen.queryByText('Waiting for the terminal…')).toBeNull()
    expect(rowOf(container, 0).textContent).toBe('hello world')
    expect(container.querySelector('[data-live-terminal="p1"]')).not.toBeNull()
  })

  it('paints runs with the terminal palette and keeps every space', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    // ConPTY moves the cursor over blank cells (CHA) instead of writing spaces.
    await feed('p1', '\x1b[31mred\x1b[0m  two  \x1b[44mblue bg\x1b[0m\r\n\x1b[1Ga\x1b[5Gb')
    const row = rowOf(container, 0)
    expect(row.textContent).toBe('red  two  blue bg')
    const spans = Array.from(row.querySelectorAll('span'))
    expect(spans.find((span) => span.textContent === 'red')).toHaveStyle({ color: '#cc0000' })
    expect(spans.find((span) => span.textContent === 'blue bg')).toHaveStyle({
      backgroundColor: '#3465a4',
    })
    expect(rowOf(container, 1).textContent).toBe('a   b')
  })

  it('keeps symbols on the cell grid', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', '✻ Thinking… 漢字')
    const boxes = Array.from(rowOf(container, 0).querySelectorAll('[data-w]'))
    expect(
      boxes.map((box) => [box.textContent, box.getAttribute('data-c'), box.getAttribute('data-w')]),
    ).toEqual([
      ['✻', '0', '1'],
      ['…', '10', '1'],
      ['漢', '12', '2'],
      ['字', '14', '2'],
    ])
  })

  it('renders only the rows around the viewport of a long scrollback', async () => {
    mirrorFor('p1', 40, 6, 8000)
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const text = Array.from({ length: 7000 }, (_, index) => `line ${index}`).join('\r\n')
    await feed('p1', text)
    const mirror = getMirror('p1')!
    expect(mirror.length).toBeGreaterThan(6000)
    const rendered = container.querySelectorAll('[data-line]')
    expect(rendered.length).toBeLessThan(60)
    // Glued to the end: the newest line is on screen.
    expect(container.textContent).toContain('line 6999')
  })

  it('shows only the screen of a full-screen program', async () => {
    mirrorFor('p1', 40, 6)
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', Array.from({ length: 20 }, (_, index) => `shell ${index}`).join('\r\n'))
    await feed('p1', '\x1b[?1049h\x1b[H\x1b[2JTUI frame')
    expect(container.querySelectorAll('[data-line]').length).toBe(6)
    expect(rowOf(container, 0).textContent).toBe('TUI frame')
    expect(container.textContent).not.toContain('shell')
  })

  it('soft-wraps lines wider than its box when it does not own the size', async () => {
    fakeBox(8 + 6 + 20 * 8.4, 200)
    mirrorFor('p1', 40, 6)
    const { container } = render(<LiveTerminal ptyId="p1" ownsSize={false} />)
    await feed('p1', 'abcdefghijklmnopqrstuvwxyz0123')
    expect(rowOf(container, 0, 0).textContent).toBe('abcdefghijklmnopqrst')
    expect(rowOf(container, 0, 20).textContent).toBe('uvwxyz0123')
    expect(tauri.resizePty).not.toHaveBeenCalled()
  })
})

describe('LiveTerminal size', () => {
  it('fits the PTY to its box once, without re-signalling the same size', async () => {
    fakeBox(808, 400)
    mirrorFor('p1', 40, 6)
    render(<LiveTerminal ptyId="p1" />)
    await settle(150)
    expect(tauri.resizePty).toHaveBeenCalledTimes(1)
    expect(tauri.resizePty).toHaveBeenCalledWith('p1', 94, 23)
    await feed('p1', 'more output')
    await settle(150)
    expect(tauri.resizePty).toHaveBeenCalledTimes(1)
  })

  it('lets only one of two views of the same PTY resize it', async () => {
    fakeBox(808, 400)
    mirrorFor('p1', 40, 6)
    render(
      <>
        <LiveTerminal ptyId="p1" />
        <LiveTerminal ptyId="p1" />
      </>,
    )
    await settle(150)
    expect(tauri.resizePty).toHaveBeenCalledTimes(1)
  })

  it('creates the mirror itself for a running PTY born without one', async () => {
    created.add('restored')
    rememberTerminalSize('restored', 50, 10)
    tauri.ptyExists.mockResolvedValueOnce(true)
    render(<LiveTerminal ptyId="restored" />)
    expect(getMirror('restored')).toBeNull()
    await settle(MIRROR_FALLBACK_MS + 100)
    const mirror = getMirror('restored')
    expect(mirror).not.toBeNull()
    expect([mirror?.cols, mirror?.rows]).toEqual([50, 10])
    expect(screen.queryByText('Waiting for the terminal…')).toBeNull()
    forgetTerminalSize('restored')
  })
})

describe('LiveTerminal copy', () => {
  it('copies full lines through mirror.getText on the copy event', async () => {
    const mirror = mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'first line   \r\nsecond')
    const getText = vi.spyOn(mirror, 'getText')
    select(firstText(rowOf(container, 0)), 0, firstText(rowOf(container, 1)), 6)
    const { event, setData } = dispatchCopy()
    expect(getText).toHaveBeenCalledWith(0, 2)
    expect(setData).toHaveBeenCalledWith('text/plain', 'first line\nsecond')
    expect(event.defaultPrevented).toBe(true)
  })

  it('copies a partial selection without trailing spaces', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'alpha beta   \r\ngamma delta')
    select(firstText(rowOf(container, 0)), 6, firstText(rowOf(container, 1)), 5)
    const { setData } = dispatchCopy()
    expect(setData).toHaveBeenCalledWith('text/plain', 'beta\ngamma')
  })

  it('leaves copies of other parts of the page alone', async () => {
    mirrorFor('p1')
    render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'terminal text')
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.appendChild(outside)
    select(outside.firstChild!, 0, outside.firstChild!, 4)
    const { event, setData } = dispatchCopy()
    expect(setData).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    outside.remove()
  })

  it('Ctrl+C copies the selection, and sends ^C when nothing is selected', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'copy me')
    fireEvent.keyDown(inputOf(container), { key: 'c', ctrlKey: true })
    await waitFor(() => expect(tauri.writePty).toHaveBeenCalledWith('p1', '\x03'))
    tauri.writePty.mockClear()

    const text = firstText(rowOf(container, 0))
    select(text, 0, text, 4)
    fireEvent.keyDown(viewportOf(container), { key: 'c', ctrlKey: true })
    await waitFor(() => expect(tauri.writeClipboardText).toHaveBeenCalledWith('copy'))
    await settle()
    expect(tauri.writePty).not.toHaveBeenCalled()
    // Copying clears the selection, like the classic terminal.
    expect(document.getSelection()?.isCollapsed).toBe(true)
  })

  it('selects everything from the menu and copies the whole buffer', async () => {
    const mirror = mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'one\r\ntwo')
    fireEvent.contextMenu(viewportOf(container), { shiftKey: true, clientX: 30, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select all' }))
    const getText = vi.spyOn(mirror, 'getText')
    fireEvent.keyDown(inputOf(container), { key: 'c', ctrlKey: true })
    await waitFor(() => expect(tauri.writeClipboardText).toHaveBeenCalledWith('one\ntwo'))
    expect(getText).toHaveBeenCalledWith(0, mirror.length)
  })
})

describe('LiveTerminal input', () => {
  it('sends keys through encodeKey and typed text through the input event', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const input = inputOf(container)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(written()).toBe('\r'))
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    await waitFor(() => expect(written()).toBe('\r\x1b[A\x1b\x1b[Z'))
    // Printable keys are left to the input event, which also carries IME and dead keys.
    const event = fireEvent.keyDown(input, { key: 'a' })
    expect(event).toBe(true)
    fireEvent.input(input, { target: { value: 'á' } })
    await waitFor(() => expect(written()).toBe('\r\x1b[A\x1b\x1b[Zá'))
    expect(input.value).toBe('')
  })

  it('sends a finished IME composition once', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const input = inputOf(container)
    fireEvent.compositionStart(input)
    fireEvent.input(input, { target: { value: 'に' }, isComposing: true })
    fireEvent.compositionEnd(input, { data: '日本' })
    await waitFor(() => expect(written()).toBe('日本'))
    await settle()
    expect(written()).toBe('日本')
  })

  it('ignores keys the app or another handler already took', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const input = inputOf(container)
    input.addEventListener('keydown', (event) => event.preventDefault(), { capture: true })
    fireEvent.keyDown(input, { key: 'L', ctrlKey: true, shiftKey: true })
    await settle()
    expect(tauri.writePty).not.toHaveBeenCalled()
  })

  it('pastes the clipboard, bracketed when the program asks for it', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const input = inputOf(container)
    tauri.readClipboardPayload.mockResolvedValueOnce({ kind: 'text', text: 'one\ntwo' })
    fireEvent.keyDown(input, { key: 'v', ctrlKey: true })
    await waitFor(() => expect(tauri.writePty).toHaveBeenCalledWith('p1', 'one\rtwo'))

    await feed('p1', '\x1b[?2004h')
    tauri.readClipboardPayload.mockResolvedValueOnce({ kind: 'paths', paths: ['C:\\a b\\x.txt'] })
    fireEvent.keyDown(input, { key: 'v', ctrlKey: true })
    await waitFor(() =>
      expect(tauri.writePty).toHaveBeenCalledWith('p1', '\x1b[200~"C:\\a b\\x.txt" \x1b[201~'),
    )
  })

  it('pastes the text of a native paste event', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    fireEvent.paste(inputOf(container), { clipboardData: { getData: () => 'native text' } })
    await waitFor(() => expect(tauri.writePty).toHaveBeenCalledWith('p1', 'native text'))
  })

  it('right-click copies a selection and pastes without one', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'right click')
    const viewport = viewportOf(container)

    fireEvent.contextMenu(viewport, { clientX: 400, clientY: 90 })
    await waitFor(() => expect(tauri.writePty).toHaveBeenCalledWith('p1', 'pasted'))

    const text = firstText(rowOf(container, 0))
    select(text, 0, text, 5)
    fireEvent.contextMenu(viewport, { clientX: 20, clientY: 9 })
    await waitFor(() => expect(tauri.writeClipboardText).toHaveBeenCalledWith('right'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the full menu with Shift+right-click and the Menu key', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    fireEvent.contextMenu(viewportOf(container), { shiftKey: true, clientX: 30, clientY: 30 })
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(['Copy', 'Paste', 'Select all', 'Find…'])
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(inputOf(container), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('stops sending input once the process ended', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'bye')
    await act(async () => {
      pty.exit.get('p1')?.({ code: 0, reason: 'exited' })
      await wait(40)
    })
    expect(screen.getByText('Process ended · read only')).toBeInTheDocument()
    const input = inputOf(container)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.input(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'v', ctrlKey: true })
    await settle()
    expect(tauri.writePty).not.toHaveBeenCalled()
    expect(rowOf(container, 0).textContent).toBe('bye')
  })

  it('never writes when read only', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" readOnly />)
    const input = inputOf(container)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.input(input, { target: { value: 'x' } })
    fireEvent.contextMenu(viewportOf(container), { clientX: 30, clientY: 30 })
    await settle()
    expect(tauri.writePty).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: 'Paste' })).toBeDisabled()
  })
})

describe('LiveTerminal scrolling', () => {
  it('stays glued to the end and offers a pill after scrolling up', async () => {
    mirrorFor('p1', 40, 6)
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const viewport = viewportOf(container)
    const scroll = fakeScroll(viewport, 4 + 6 * 17 + 2)
    await feed('p1', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\r\n'))
    const max = () => viewport.scrollHeight - viewport.clientHeight
    expect(max()).toBe(24 * 17)
    expect(scroll.top).toBe(max())

    scroll.top = 0
    fireEvent.scroll(viewport)
    expect(screen.getByRole('button', { name: '↓ Jump to the end' })).toBeInTheDocument()

    await feed('p1', '\r\nmore\r\nlines')
    expect(screen.getByRole('button', { name: '↓ 2 new lines' })).toBeInTheDocument()
    // The reader keeps the place they scrolled to.
    expect(scroll.top).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: '↓ 2 new lines' }))
    await settle()
    expect(scroll.top).toBe(max())
    expect(screen.queryByRole('button', { name: /new lines|Jump to the end/ })).toBeNull()
  })

  it('keeps the reading position while a full scrollback drops lines', async () => {
    mirrorFor('p1', 40, 6, 20)
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const viewport = viewportOf(container)
    const scroll = fakeScroll(viewport, 4 + 6 * 17 + 2)
    await feed('p1', Array.from({ length: 40 }, (_, index) => `old ${index}`).join('\r\n'))
    scroll.top = 10 * 17
    fireEvent.scroll(viewport)
    const before = getMirror('p1')!.trimmed
    await feed('p1', '\r\nnew 1\r\nnew 2\r\nnew 3')
    const dropped = getMirror('p1')!.trimmed - before
    expect(dropped).toBe(3)
    expect(scroll.top).toBe(7 * 17)
  })

  it('pages with Shift+PageUp and jumps with Ctrl+Home / Ctrl+End', async () => {
    mirrorFor('p1', 40, 6)
    const { container } = render(<LiveTerminal ptyId="p1" />)
    const viewport = viewportOf(container)
    const scroll = fakeScroll(viewport, 4 + 6 * 17 + 2)
    await feed('p1', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\r\n'))
    const input = inputOf(container)
    const bottom = scroll.top
    fireEvent.keyDown(input, { key: 'PageUp', shiftKey: true })
    expect(scroll.top).toBe(bottom - (viewport.clientHeight - 17))
    fireEvent.keyDown(input, { key: 'Home', ctrlKey: true })
    expect(scroll.top).toBe(0)
    fireEvent.keyDown(input, { key: 'End', ctrlKey: true })
    await settle()
    expect(scroll.top).toBe(bottom)
    expect(tauri.writePty).not.toHaveBeenCalled()
  })

  it('turns the wheel into mouse reports or arrows in full-screen programs', async () => {
    mirrorFor('p1', 40, 6)
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', '\x1b[?1049h')
    const viewport = viewportOf(container)
    fireEvent.wheel(viewport, {
      deltaY: 2,
      deltaMode: 1,
      clientX: 8 + 2 * 8.4 + 1,
      clientY: 4 + 17 + 5,
    })
    await waitFor(() => expect(written()).toBe('\x1b[B\x1b[B'))
    tauri.writePty.mockClear()
    await feed('p1', '\x1b[?1000h\x1b[?1006h')
    fireEvent.wheel(viewport, {
      deltaY: 40,
      deltaMode: 0,
      clientX: 8 + 2 * 8.4 + 1,
      clientY: 4 + 17 + 5,
    })
    await waitFor(() => expect(written()).toBe('\x1b[<65;3;2M'))
  })

  it('leaves the wheel to the browser in a full-screen program once the input is off', async () => {
    mirrorFor('p1', 40, 6)
    const { container } = render(<LiveTerminal ptyId="p1" readOnly />)
    await feed('p1', '\x1b[?1049h\x1b[?1000h\x1b[?1006h')
    const notPrevented = fireEvent.wheel(viewportOf(container), { deltaY: 40, deltaMode: 0 })
    expect(notPrevented).toBe(true)
    await settle()
    expect(tauri.writePty).not.toHaveBeenCalled()
  })

  it('shows the history a real Claude Code session scrolled off its full screen', async () => {
    // Recorded through ConPTY at 120x32 (see src/lib/terminalMirror/fixtures).
    const recording = readFileSync(
      join(process.cwd(), 'src/lib/terminalMirror/fixtures/claude-code-alt-screen.bin'),
    ).toString('utf8')
    mirrorFor('cc', 120, 32)
    const { container } = render(<LiveTerminal ptyId="cc" readOnly />)
    await act(async () => {
      for (let start = 0; start < recording.length; start += 16 * 1024) {
        feedMirror('cc', recording.slice(start, start + 16 * 1024))
      }
      await wait(60)
    })
    const mirror = getMirror('cc')!
    expect(mirror.bufferType).toBe('alternate')
    expect(mirror.baseY).toBeGreaterThanOrEqual(30)
    expect(mirror.getText(0, mirror.baseY)).toContain('Claude Code v2.1.289')
    const divider = container.querySelector('[data-alt-divider]') as HTMLElement
    expect(divider).not.toBeNull()
    expect(divider.style.top).toBe(`calc(${mirror.baseY} * var(--lt-row-h))`)
    // Read only: the wheel scrolls that history instead of going to the program.
    expect(fireEvent.wheel(viewportOf(container), { deltaY: -120, deltaMode: 0 })).toBe(true)
  })
})

describe('LiveTerminal search and links', () => {
  it('finds matches with Ctrl+F, counts them and steps with Enter', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'foo bar\r\nbaz foo\r\nfoo')
    fireEvent.keyDown(inputOf(container), { key: 'f', ctrlKey: true })
    const field = screen.getByPlaceholderText('Find')
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'foo' } })
    await settle(180)
    expect(screen.getByText('3/3')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-match]').length).toBe(3)
    expect(container.querySelectorAll('[data-match="active"]').length).toBe(1)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByText('1/3')).toBeInTheDocument()
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('3/3')).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'nothing here' } })
    await settle(180)
    expect(screen.getByText('No results')).toBeInTheDocument()

    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Find')).toBeNull()
    expect(container.querySelectorAll('[data-match]').length).toBe(0)
    expect(inputOf(container)).toHaveFocus()
  })

  it('opens a link with Ctrl+click and offers a link menu on right-click', async () => {
    mirrorFor('p1')
    const { container } = render(<LiveTerminal ptyId="p1" />)
    await feed('p1', 'see https://example.com/docs now')
    const viewport = viewportOf(container)
    const onLink = { clientX: 8 + 6 * 8.4 + 1, clientY: 4 + 5 }

    fireEvent.click(viewport, onLink)
    expect(tauri.openInBrowser).not.toHaveBeenCalled()
    fireEvent.click(viewport, { ...onLink, ctrlKey: true })
    expect(tauri.openInBrowser).toHaveBeenCalledWith('https://example.com/docs')

    fireEvent.contextMenu(viewport, onLink)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open link',
      'Copy link',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() =>
      expect(tauri.writeClipboardText).toHaveBeenCalledWith('https://example.com/docs'),
    )
  })
})
