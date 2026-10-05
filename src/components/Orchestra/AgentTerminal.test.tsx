import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeMirror = {
  ptyId: string
  cols: number
  rows: number
  onChange: (listener: () => void) => () => void
}

const fake = vi.hoisted(() => {
  const mirrors = new Map<string, FakeMirror>()
  const registry = new Set<(ptyId: string) => void>()
  const changes = new Map<string, Set<() => void>>()
  const session = { focused: true }
  const notify = (ptyId: string) => registry.forEach((listener) => listener(ptyId))
  return {
    mirrors,
    session,
    create(ptyId: string, cols = 100, rows = 30): FakeMirror {
      const listeners = new Set<() => void>()
      changes.set(ptyId, listeners)
      const mirror: FakeMirror = {
        ptyId,
        cols,
        rows,
        onChange: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
      mirrors.set(ptyId, mirror)
      notify(ptyId)
      return mirror
    },
    /** What the pty.ts wrapper does after a view resized the PTY; output frames call it too. */
    change(ptyId: string, size?: { cols: number; rows: number }) {
      const mirror = mirrors.get(ptyId)
      if (mirror && size) Object.assign(mirror, size)
      changes.get(ptyId)?.forEach((listener) => listener())
    },
    dispose(ptyId: string) {
      mirrors.delete(ptyId)
      changes.delete(ptyId)
      notify(ptyId)
    },
    getMirror: (ptyId: string) => mirrors.get(ptyId) ?? null,
    onMirrorRegistry: (listener: (ptyId: string) => void) => {
      registry.add(listener)
      return () => {
        registry.delete(listener)
      }
    },
    listening: (ptyId: string) => changes.get(ptyId)?.size ?? 0,
  }
})

vi.mock('../../lib/terminalMirror', () => ({
  getMirror: fake.getMirror,
  onMirrorRegistry: fake.onMirrorRegistry,
}))

vi.mock('./sessionContext', () => ({
  useSessionFocusGetter: () => () => fake.session.focused,
}))

vi.mock('../XTermView', () => ({
  XTermView: (props: { ptyId: string; terminalTheme?: string }) => (
    <div data-testid="classic" data-pty={props.ptyId} data-theme={props.terminalTheme}>
      <textarea className="xterm-helper-textarea" />
    </div>
  ),
}))

vi.mock('../LiveTerminal', () => ({
  LiveTerminal: (props: {
    ptyId: string
    ownsSize?: boolean
    readOnly?: boolean
    autoFocus?: boolean
  }) => (
    <div
      data-testid="live"
      data-live-terminal={props.ptyId}
      data-owns-size={String(props.ownsSize ?? true)}
      data-read-only={String(Boolean(props.readOnly))}
      data-auto-focus={String(Boolean(props.autoFocus))}
    >
      <textarea data-live-terminal-input="" />
    </div>
  ),
}))

import { useProjectsStore } from '../../stores/projectsStore'
import { AgentTerminal, TerminalModeToggle } from './AgentTerminal'
import {
  resetTerminalGeometryCache,
  spawnTerminalSize,
  TERMINAL_SIZE_KEY,
} from './terminalGeometry'
import {
  focusTerminalIn,
  isTerminalElement,
  useHasTranscript,
  useTerminalModeShortcut,
} from './terminalHooks'
import { TERMINAL_MODE_KEY, useTerminalModeStore } from './terminalMode'

const mode = () => useTerminalModeStore.getState().mode

function Host(props: { alive?: boolean; role?: 'orchestrator' | 'worker'; autoFocus?: boolean }) {
  useTerminalModeShortcut()
  return (
    <>
      <TerminalModeToggle />
      <AgentTerminal
        ptyId="pty-1"
        role={props.role ?? 'worker'}
        alive={props.alive ?? true}
        cwd="C:/repo"
        autoFocus={props.autoFocus}
      />
    </>
  )
}

function TranscriptProbe({ ptyId }: { ptyId: string | null }) {
  return <span data-testid="probe">{String(useHasTranscript(ptyId))}</span>
}

const shortcut = { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true }

describe('AgentTerminal', () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_MODE_KEY)
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
    useTerminalModeStore.setState({ mode: 'live' })
    fake.session.focused = true
    fake.create('pty-1')
    useProjectsStore.setState((s) => ({
      preferences: { ...s.preferences, language: 'en', terminalTheme: 'nord' },
    }))
  })

  afterEach(() => {
    fake.dispose('pty-1')
    localStorage.removeItem(TERMINAL_MODE_KEY)
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  it('shows the live transcript by default, sized by its own box', () => {
    render(<Host autoFocus />)
    const live = screen.getByTestId('live')
    expect(live).toHaveAttribute('data-live-terminal', 'pty-1')
    expect(live).toHaveAttribute('data-owns-size', 'true')
    expect(live).toHaveAttribute('data-read-only', 'false')
    expect(live).toHaveAttribute('data-auto-focus', 'true')
    expect(screen.queryByTestId('classic')).toBeNull()
  })

  it('switches to the classic terminal with the user theme and remembers it', () => {
    render(<Host />)
    const toggle = screen.getByRole('button', { name: /^Live transcript/ })
    expect(toggle).toHaveAttribute('title', expect.stringContaining('Ctrl+Shift+L'))

    fireEvent.click(toggle)
    expect(mode()).toBe('classic')
    expect(localStorage.getItem(TERMINAL_MODE_KEY)).toBe('classic')
    // Only one view per PTY: the live one is gone, so they never fight over its size.
    expect(screen.queryByTestId('live')).toBeNull()
    expect(screen.getByTestId('classic')).toHaveAttribute('data-theme', 'nord')

    fireEvent.click(screen.getByRole('button', { name: /^Classic terminal/ }))
    expect(screen.getByTestId('live')).toBeInTheDocument()
  })

  it('keeps an ended agent readable: the read-only transcript in either mode', () => {
    useTerminalModeStore.setState({ mode: 'classic' })
    render(<AgentTerminal ptyId="pty-1" role="worker" alive={false} cwd={null} />)
    const live = screen.getByTestId('live')
    expect(live).toHaveAttribute('data-owns-size', 'false')
    expect(live).toHaveAttribute('data-read-only', 'true')
    expect(screen.queryByTestId('classic')).toBeNull()
  })

  it('toggles on Ctrl+Shift+L from inside the terminal without reaching it', async () => {
    render(<Host />)
    const input = screen.getByTestId('live').querySelector('textarea')!
    const reachedTerminal = vi.fn()
    input.addEventListener('keydown', reachedTerminal)

    const event = new KeyboardEvent('keydown', { ...shortcut, bubbles: true, cancelable: true })
    act(() => {
      input.dispatchEvent(event)
    })
    expect(mode()).toBe('classic')
    expect(event.defaultPrevented).toBe(true)
    expect(reachedTerminal).not.toHaveBeenCalled()
    // The view that replaced the focused one takes the keyboard.
    const classicInput = screen.getByTestId('classic').querySelector('textarea')!
    await waitFor(() => expect(document.activeElement).toBe(classicInput))

    // Held down, the key does not flip the mode back and forth.
    fireEvent.keyDown(classicInput, { ...shortcut, repeat: true })
    expect(mode()).toBe('classic')
  })

  it('leaves the shortcut to the focused session and ignores plain Ctrl+L', () => {
    render(<Host />)
    fireEvent.keyDown(window, { ...shortcut, shiftKey: false })
    expect(mode()).toBe('live')

    fake.session.focused = false
    fireEvent.keyDown(window, shortcut)
    expect(mode()).toBe('live')

    fake.session.focused = true
    fireEvent.keyDown(window, shortcut)
    expect(mode()).toBe('classic')
  })

  it('remembers the size the view fitted the PTY to, not the one it was born with', () => {
    const { unmount } = render(<Host role="worker" />)
    expect(fake.listening('pty-1')).toBe(1)
    // An output frame at the spawn size records nothing.
    fake.change('pty-1')
    expect(localStorage.getItem(TERMINAL_SIZE_KEY)).toBeNull()

    fake.change('pty-1', { cols: 88, rows: 26 })
    expect(spawnTerminalSize('worker')).toEqual({ cols: 88, rows: 26 })
    unmount()
    expect(fake.listening('pty-1')).toBe(0)
  })

  it('records nothing for a read-only transcript, which never sizes the PTY', () => {
    render(<AgentTerminal ptyId="pty-1" role="orchestrator" alive={false} cwd={null} />)
    fake.change('pty-1', { cols: 140, rows: 40 })
    expect(localStorage.getItem(TERMINAL_SIZE_KEY)).toBeNull()
  })

  it('follows the mirror registry for a PTY whose mirror comes later', () => {
    render(<Host role="orchestrator" />)
    fake.dispose('pty-1')
    const mirror = fake.create('pty-1', 100, 30)
    fake.change('pty-1', { cols: 132, rows: 41 })
    expect(spawnTerminalSize('orchestrator')).toEqual({ cols: 132, rows: 41 })
    expect(mirror.cols).toBe(132)
  })
})

describe('terminal helpers', () => {
  it('knows whether a PTY has a transcript to read', () => {
    render(<TranscriptProbe ptyId="pty-9" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
    act(() => {
      fake.create('pty-9')
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('true')
    act(() => {
      fake.dispose('pty-9')
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })

  it('treats both terminal views as owners of their keys', () => {
    const live = document.createElement('div')
    live.setAttribute('data-live-terminal', 'pty-1')
    const input = document.createElement('textarea')
    live.append(input)
    const classic = document.createElement('div')
    classic.className = 'xterm'
    expect(isTerminalElement(input)).toBe(true)
    expect(isTerminalElement(classic)).toBe(true)
    expect(isTerminalElement(document.body)).toBe(false)
    expect(isTerminalElement(null)).toBe(false)
  })

  it('focuses a terminal that mounts a few frames later', async () => {
    const pane = document.createElement('section')
    document.body.append(pane)
    focusTerminalIn(pane)
    const input = document.createElement('textarea')
    input.className = 'xterm-helper-textarea'
    setTimeout(() => pane.append(input), 40)
    await waitFor(() => expect(document.activeElement).toBe(input))
    pane.remove()
  })
})
