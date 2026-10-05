import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ptyExists: vi.fn((_id: string) => Promise.resolve(true)),
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  /** PTYs with a transcript in their mirror. */
  mirrors: new Set<string>(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  open: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))

vi.mock('../../lib/tauri', () => ({
  ptyExists: mocks.ptyExists,
  spawnPty: mocks.spawnPty,
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
  readClipboardPayload: vi.fn(() => Promise.resolve(null)),
  writeClipboardText: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../../lib/tauri/usage', () => ({
  getClaudeUsage: vi.fn(() => Promise.reject(new Error('not in tests'))),
  getAllAccountsUsage: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../lib/tauri/accountMcp', () => ({
  syncAccountMcpServers: vi.fn(() => Promise.resolve({ synced: [], failed: [] })),
}))

// The store installs the scribe on load; it must never reach a real vault.
vi.mock('./scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../lib/terminalMirror', () => ({
  getMirror: (ptyId: string) =>
    mocks.mirrors.has(ptyId)
      ? { baseY: 0, rows: 1, length: 1, getText: () => 'transcript', onChange: () => () => {} }
      : null,
  onMirrorRegistry: () => () => {},
  ensureMirror: vi.fn(),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
}))

// The terminal itself is not under test: whether the drawer asks for a live one is.
vi.mock('./AgentTerminal', () => ({
  AgentTerminal: ({ ptyId, alive }: { ptyId: string; alive: boolean }) => (
    <div data-testid="agent-terminal" data-pty={ptyId} data-alive={String(alive)} />
  ),
  TerminalModeToggle: () => null,
}))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { OrchestraView } from '.'

const ID = 'oended01'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'api',
    task: `task of ${id}`,
    after: [],
    ptyId: `pty-${id}`,
    state: 'thinking',
    progress: 0,
    note: '',
    lines: [],
    files: [],
    toolCalls: 0,
    startedAt: 0,
    finishedAt: null,
    history: [],
    account: null,
    model: null,
    effort: null,
    ...patch,
  }
}

function showDrawerOf(worker: OrchestraAgent) {
  const session: OrchestraSession = {
    id: ID,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: false,
    startedAt: Date.now(),
    mode: 'mission',
    agents: [agent('orchestrator', { state: 'idle' }), worker],
    messages: [],
    segments: [],
    selectedId: worker.id,
    error: null,
  }
  useOrchestraStore.setState({ sessions: { [ID]: session }, order: [ID], activeId: ID })
  return render(<OrchestraView />)
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  mocks.mirrors.clear()
  mocks.ptyExists.mockClear()
  mocks.ptyExists.mockImplementation(() => Promise.resolve(true))
})

afterEach(() => {
  useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  localStorage.clear()
  vi.unstubAllGlobals()
})

const drawerTerminal = () => screen.getByRole('complementary', { name: 'claude-1' })

describe('drawer of an agent whose terminal ended (N10)', () => {
  it('shows the transcript of a worker that ended after done, read-only, never a live claude', async () => {
    mocks.mirrors.add('pty-claude-1')
    showDrawerOf(
      agent('claude-1', {
        state: 'done',
        progress: 100,
        finishedAt: 5,
        exitCode: 0,
        exitReason: 'exited',
      }),
    )
    const terminal = await waitFor(() => {
      const found = drawerTerminal().querySelector('[data-testid="agent-terminal"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(terminal).toHaveAttribute('data-alive', 'false')
    // Its PTY is not even asked about: nothing may attach to it, let alone spawn it again.
    expect(mocks.ptyExists).not.toHaveBeenCalledWith('pty-claude-1')
    expect(mocks.spawnPty).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText(/claude-1/)).toBeDisabled()
  })

  it('never makes a live terminal of a PTY the backend no longer has', async () => {
    mocks.mirrors.add('pty-claude-1')
    mocks.ptyExists.mockImplementation(() => Promise.resolve(false))
    showDrawerOf(agent('claude-1', { state: 'done', progress: 100, finishedAt: 5 }))
    await waitFor(() => expect(mocks.ptyExists).toHaveBeenCalledWith('pty-claude-1'))
    await waitFor(() =>
      expect(drawerTerminal().querySelector('[data-testid="agent-terminal"]')).toHaveAttribute(
        'data-alive',
        'false',
      ),
    )
  })

  it('gives a running worker its live terminal once the backend confirms the PTY', async () => {
    showDrawerOf(agent('claude-1', { state: 'editing', progress: 30 }))
    await waitFor(() =>
      expect(drawerTerminal().querySelector('[data-testid="agent-terminal"]')).toHaveAttribute(
        'data-alive',
        'true',
      ),
    )
  })
})
