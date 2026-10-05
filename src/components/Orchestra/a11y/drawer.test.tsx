import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  open: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))

vi.mock('../../../lib/tauri', () => ({
  ptyExists: vi.fn(() => Promise.resolve(false)),
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
  readClipboardPayload: vi.fn(() => Promise.resolve(null)),
  writeClipboardText: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../../../lib/tauri/usage', () => ({
  getClaudeUsage: vi.fn(() => Promise.reject(new Error('not in tests'))),
  getAllAccountsUsage: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../../lib/tauri/accountMcp', () => ({
  syncAccountMcpServers: vi.fn(() => Promise.resolve({ synced: [], failed: [] })),
}))

// The store installs the scribe on load; it must never reach a real vault.
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
}))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { OrchestraView } from '..'

const ID = 'odrawer1'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'ui',
    task: `task of ${id}`,
    after: [],
    ptyId: null,
    state: 'waiting',
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

function session(): OrchestraSession {
  return {
    id: ID,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: false,
    startedAt: Date.now(),
    mode: 'mission',
    // Neither agent has a terminal yet, so the drawer shows its waiting text instead of xterm.
    agents: [agent('orchestrator'), agent('claude-1', { after: ['claude-2'] })],
    messages: [],
    segments: [],
    selectedId: 'claude-1',
    error: null,
  }
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  useOrchestraStore.setState({ sessions: { [ID]: session() }, order: [ID], activeId: ID })
})

afterEach(() => {
  useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('agent drawer handle', () => {
  it('resizes from the keyboard like the side-by-side divider', () => {
    render(<OrchestraView />)
    const handle = screen.getByRole('separator', { name: 'Resize panel' })
    expect(handle).toHaveAttribute('tabindex', '0')
    expect(handle).toHaveAttribute('aria-valuenow', '520')
    expect(handle).toHaveAttribute('aria-valuemin', '360')
    expect(handle).toHaveAttribute('aria-valuemax', '960')

    // The handle is the drawer's left edge: moving it left widens the drawer.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '536')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(handle).toHaveAttribute('aria-valuenow', '472')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle).toHaveAttribute('aria-valuenow', '360')
    fireEvent.keyDown(handle, { key: 'End' })
    // jsdom lays nothing out, so the widest drag is the hard maximum.
    expect(handle).toHaveAttribute('aria-valuenow', '960')
    expect(localStorage.getItem('orchestra.drawerWidth')).toBe('960')

    fireEvent.doubleClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '520')
    expect(localStorage.getItem('orchestra.drawerWidth')).toBe('520')
  })

  it('leaves other keys to the page', () => {
    render(<OrchestraView />)
    const handle = screen.getByRole('separator', { name: 'Resize panel' })
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    handle.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(handle).toHaveAttribute('aria-valuenow', '520')
  })
})
