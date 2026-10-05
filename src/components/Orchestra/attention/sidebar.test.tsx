import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))
vi.mock('../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))
// The sidebar's panels read git, files, Spotify, updates and profiles; only its tab strip matters.
vi.mock('../../ProjectSidebar/FileExplorer', () => ({ FileExplorer: () => null }))
vi.mock('../../ProjectSidebar/GitControl', () => ({ GitControl: () => null }))
vi.mock('../../ProjectSidebar/LegacyResync', () => ({ LegacyResync: () => null }))
vi.mock('../../ProjectSidebar/SidebarUpdate', () => ({ SidebarUpdate: () => null }))
vi.mock('../../ProjectSidebar/LayoutFooter', () => ({
  LayoutFooter: () => null,
  WorkspaceLayoutFooter: () => null,
}))
vi.mock('../../SidebarNowPlaying', () => ({ SidebarNowPlaying: () => null }))
vi.mock('../../UserProfile', () => ({ UserProfile: () => null }))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { NormalProjectSidebar } from '../../ProjectSidebar/NormalProjectSidebar'
import { useAttentionStore } from './store'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: 'ui',
    task: '',
    after: [],
    ptyId: 'p',
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

function session(agents: OrchestraAgent[]): OrchestraSession {
  return {
    id: 's1',
    projectId: null,
    cwd: 'C:/r',
    goal: '',
    autonomous: false,
    startedAt: 0,
    mode: 'constellation',
    agents,
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
  } as OrchestraSession
}

beforeEach(() => {
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
})

afterEach(() => {
  useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  useAttentionStore.setState({ waiting: {}, last: {} })
  useUiStore.setState({ activeView: 'workspace' })
})

describe('Orchestra tab of the sidebar', () => {
  it('opens the Orchestra and shows how many agents wait for you', () => {
    const ask = { reason: 'question' as const, text: 'Which DB?', at: 1 }
    useOrchestraStore.setState({
      sessions: {
        s1: session([agent('orchestrator'), agent('claude-1', { state: 'blocked', blocked: ask })]),
      },
      order: ['s1'],
    })
    render(<NormalProjectSidebar />)
    const tab = screen.getByRole('tab', { name: 'Orchestra · 1 waiting for you' })
    expect(tab).toHaveTextContent('1')
    expect(tab).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(tab)
    expect(useUiStore.getState().activeView).toBe('orchestra')
    expect(screen.getByRole('tab', { name: /^Orchestra/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('has no badge when nobody waits', () => {
    render(<NormalProjectSidebar />)
    expect(screen.getByRole('tab', { name: 'Orchestra' })).not.toHaveTextContent(/\d/)
  })
})
