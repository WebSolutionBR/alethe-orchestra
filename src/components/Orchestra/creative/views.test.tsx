import { render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  open: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))

vi.mock('../../../lib/tauri', () => ({
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
  readClipboardPayload: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

// The store installs the scribe on load; it must never reach a real vault.
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { OrchestraSessionProvider } from '../sessionContext'
import { FlowView } from '../views/FlowView'
import { MissionControlView } from '../views/MissionControlView'
import { TimelineView } from '../views/TimelineView'
import { CREATIVE_AREA } from './role'

const ID = 'ocreate1'

function agent(id: string, area: string, task: string): OrchestraAgent {
  const at = Date.now() - 60_000
  return {
    id,
    area,
    task,
    after: [],
    ptyId: `pty-${id}`,
    state: 'thinking',
    progress: 40,
    note: '',
    lines: [],
    files: [],
    toolCalls: 0,
    startedAt: at,
    finishedAt: null,
    history: [],
    account: null,
    model: null,
    effort: null,
  }
}

function session(): OrchestraSession {
  const at = Date.now() - 60_000
  return {
    id: ID,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: false,
    startedAt: at,
    mode: 'mission',
    agents: [
      agent('orchestrator', 'orchestrator', 'goal'),
      agent('claude-1', 'ui', 'build the panel'),
      agent('claude-2', CREATIVE_AREA, 'propose improvements'),
    ],
    messages: [
      { id: 1, at: at + 1000, from: 'claude-2', to: 'orchestrator', text: 'proposals' },
      { id: 2, at: at + 2000, from: 'orchestrator', to: 'claude-2', text: 'approved' },
    ],
    segments: [],
    selectedId: null,
    error: null,
  }
}

function renderView(view: JSX.Element) {
  return render(<OrchestraSessionProvider sessionId={ID}>{view}</OrchestraSessionProvider>)
}

beforeAll(() => {
  // jsdom has no layout observers; the canvases only need the constructor to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  useOrchestraStore.setState({ sessions: { [ID]: session() }, order: [ID], activeId: ID })
})

afterEach(() => {
  useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  localStorage.clear()
})

describe('creative identity in the views', () => {
  it('Mission control marks the creative card and colors its bus lines', () => {
    const { container } = renderView(<MissionControlView />)
    expect(screen.getAllByRole('img', { name: 'Creative agent' })).toHaveLength(1)
    expect(container.querySelector('[data-from="creative"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-role="creative"]').length).toBeGreaterThan(0)
  })

  it('Flow marks the creative node and its bus lines', () => {
    const { container } = renderView(<FlowView />)
    // The canvas stays visibility:hidden until it is measured, which jsdom never does, and a
    // hidden node has no computed accessible name: match the label attribute instead.
    expect(container.querySelectorAll('[role="img"][aria-label="Creative agent"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-role="creative"]').length).toBeGreaterThan(0)
  })

  it('Timeline paints the creative lane label with the creative token', () => {
    renderView(<TimelineView />)
    expect(screen.getAllByRole('img', { name: 'Creative agent' })).toHaveLength(1)
    const label = screen.getAllByText('claude-2').find((el) => el.style.color)
    expect(label?.style.color).toBe('var(--agent-creative)')
    const other = screen.getAllByText('claude-1').find((el) => el.style.color)
    expect(other?.style.color).toBe('var(--agent-claude)')
  })
})
