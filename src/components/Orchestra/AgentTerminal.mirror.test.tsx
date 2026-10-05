import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// xterm probes a canvas when it loads; jsdom has none.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

vi.mock('../../lib/tauri/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri/pty')>()),
  listenPtyData: vi.fn(() => Promise.resolve(() => {})),
  listenPtyActivity: vi.fn(() => Promise.resolve(() => {})),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  attachPty: vi.fn(() => Promise.resolve('')),
}))

vi.mock('../LiveTerminal', () => ({
  LiveTerminal: (props: { ptyId: string }) => <div data-live-terminal={props.ptyId} />,
}))

vi.mock('../XTermView', () => ({ XTermView: () => null }))

import { disposeMirror, ensureMirror, whenMirrorReady } from '../../lib/terminalMirror'
import { AgentTerminal } from './AgentTerminal'
import {
  resetTerminalGeometryCache,
  spawnTerminalSize,
  TERMINAL_SIZE_KEY,
} from './terminalGeometry'

describe('AgentTerminal with a real mirror', () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  afterEach(() => {
    disposeMirror('pty-real')
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  it('remembers the size a view fitted the PTY to for the next agent of the role', async () => {
    const mirror = ensureMirror('pty-real', { cols: 100, rows: 30 })
    await whenMirrorReady('pty-real')
    render(<AgentTerminal ptyId="pty-real" role="worker" alive cwd={null} />)

    // What the pty.ts wrapper does once the backend applied a view's resizePty.
    mirror.resize(91, 33)
    await waitFor(() => expect(spawnTerminalSize('worker')).toEqual({ cols: 91, rows: 33 }))
    expect(spawnTerminalSize('orchestrator')).toEqual({ cols: 91, rows: 33 })
  })
})
