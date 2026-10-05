import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const mirrors = new Set<string>()
  return {
    mirrors,
    alive: new Set<string>(),
    getMirror: (ptyId: string) =>
      mirrors.has(ptyId) ? { ptyId, cols: 100, rows: 30, onChange: () => () => {} } : null,
    onMirrorRegistry: () => () => {},
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../../lib/tauri', () => ({
  ptyExists: vi.fn((id: string) => Promise.resolve(fake.alive.has(id))),
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../../../lib/terminalMirror', () => ({
  getMirror: fake.getMirror,
  onMirrorRegistry: fake.onMirrorRegistry,
  ensureMirror: vi.fn(),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
}))

vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))

vi.mock('../../XTermView', () => ({
  XTermView: (props: { ptyId: string }) => (
    <div data-testid={`classic-${props.ptyId}`}>
      <textarea className="xterm-helper-textarea" />
    </div>
  ),
}))

vi.mock('../../LiveTerminal', () => ({
  LiveTerminal: (props: { ptyId: string; ownsSize?: boolean; readOnly?: boolean }) => (
    <div
      data-testid={`live-${props.ptyId}`}
      data-live-terminal={props.ptyId}
      data-owns-size={String(props.ownsSize ?? true)}
      data-read-only={String(Boolean(props.readOnly))}
    >
      <textarea data-live-terminal-input="" />
    </div>
  ),
}))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { OrchestraSessionProvider } from '../sessionContext'
import { TERMINAL_MODE_KEY, useTerminalModeStore } from '../terminalMode'
import { TerminalsView } from './TerminalsView'

const ID = 'oterms01'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'api',
    task: `task of ${id}`,
    after: [],
    ptyId: `pty-${id}`,
    state: 'thinking',
    progress: 10,
    note: '',
    lines: [],
    files: [],
    toolCalls: 0,
    startedAt: 1,
    finishedAt: null,
    history: [],
    account: null,
    model: null,
    effort: null,
    ...patch,
  }
}

function session(agents: OrchestraAgent[]): OrchestraSession {
  return {
    id: ID,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: true,
    startedAt: 1,
    mode: 'terminals',
    agents,
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
  }
}

function renderView(agents: OrchestraAgent[]) {
  useOrchestraStore.setState({ sessions: { [ID]: session(agents) }, order: [ID], activeId: ID })
  return render(
    <OrchestraSessionProvider sessionId={ID}>
      <TerminalsView />
    </OrchestraSessionProvider>,
  )
}

const paneOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(id)}"]`)!

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('TerminalsView terminals', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    localStorage.removeItem(TERMINAL_MODE_KEY)
    useTerminalModeStore.setState({ mode: 'live' })
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
    fake.alive.clear()
    fake.mirrors.clear()
  })

  afterEach(() => {
    useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
    localStorage.removeItem(TERMINAL_MODE_KEY)
    vi.unstubAllGlobals()
  })

  it('shows live agents as live transcripts and switches every cell from one header', async () => {
    fake.alive.add('pty-orchestrator').add('pty-claude-1')
    fake.mirrors.add('pty-orchestrator').add('pty-claude-1')
    renderView([agent('orchestrator'), agent('claude-1')])

    const live = await screen.findByTestId('live-pty-claude-1')
    expect(live).toHaveAttribute('data-owns-size', 'true')
    expect(screen.getByTestId('live-pty-orchestrator')).toBeInTheDocument()

    const toggle = within(paneOf('claude-1')).getByRole('button', { name: /^Live transcript/ })
    fireEvent.click(toggle)
    expect(screen.getByTestId('classic-pty-claude-1')).toBeInTheDocument()
    expect(screen.getByTestId('classic-pty-orchestrator')).toBeInTheDocument()
    expect(screen.queryByTestId('live-pty-claude-1')).toBeNull()
    // The clicked cell's new terminal takes the keyboard.
    const input = within(paneOf('claude-1')).getByTestId('classic-pty-claude-1').firstChild
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('keeps an ended agent readable, and falls back to its activity without a transcript', async () => {
    fake.alive.add('pty-orchestrator')
    fake.mirrors.add('pty-orchestrator').add('pty-claude-1')
    renderView([
      agent('orchestrator'),
      agent('claude-1', { state: 'exited', lines: [{ at: 1, text: '✓ shipped', tone: 'ok' }] }),
      agent('claude-2', { state: 'exited', lines: [{ at: 1, text: '✓ other', tone: 'ok' }] }),
    ])

    const transcript = await screen.findByTestId('live-pty-claude-1')
    expect(transcript).toHaveAttribute('data-read-only', 'true')
    expect(transcript).toHaveAttribute('data-owns-size', 'false')
    // Nothing to switch for an ended agent.
    expect(
      within(paneOf('claude-1')).queryByRole('button', { name: /^Live transcript/ }),
    ).toBeNull()

    // How it ended replaces the old "session ended" title.
    expect(
      await within(paneOf('claude-2')).findByText('Exited without reporting done'),
    ).toBeInTheDocument()
    expect(within(paneOf('claude-2')).getByText('✓ other')).toBeInTheDocument()
  })

  it('maximizes and restores without remounting the terminal; Esc inside it is the agent’s', async () => {
    fake.alive.add('pty-orchestrator').add('pty-claude-1')
    fake.mirrors.add('pty-orchestrator').add('pty-claude-1')
    renderView([agent('orchestrator'), agent('claude-1')])
    const before = await screen.findByTestId('live-pty-claude-1')

    fireEvent.click(within(paneOf('claude-1')).getByRole('button', { name: /^Maximize claude-1/ }))
    expect(paneOf('claude-1').className).toMatch(/maxed/)
    expect(screen.getByTestId('live-pty-claude-1')).toBe(before)

    // Esc typed in the terminal interrupts the agent; it never restores the grid.
    fireEvent.keyDown(before.querySelector('textarea')!, { key: 'Escape' })
    expect(paneOf('claude-1').className).toMatch(/maxed/)

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' })
    })
    expect(paneOf('claude-1').className).not.toMatch(/maxed/)
    expect(screen.getByTestId('live-pty-claude-1')).toBe(before)
  })
})
