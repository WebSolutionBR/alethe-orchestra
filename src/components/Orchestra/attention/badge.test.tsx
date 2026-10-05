import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))
vi.mock('../../../lib/tauri', () => ({
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

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { AttentionIcon } from './AttentionBadge'
import { AttentionLive } from './AttentionLive'
import { useAttentionStore } from './store'
import { useAttentionLabel } from './useAttention'

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

function session(id: string, agents: OrchestraAgent[]): OrchestraSession {
  return {
    id,
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

function Button() {
  const label = useAttentionLabel('Orchestra')
  return (
    <button type="button" aria-label={label}>
      <AttentionIcon>
        <i />
      </AttentionIcon>
    </button>
  )
}

beforeEach(() => {
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
})

afterEach(() => {
  useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  useAttentionStore.setState({ waiting: {}, last: {} })
})

describe('attention badge', () => {
  it('counts what waits on the user across orchestrations', () => {
    const ask = { reason: 'permission' as const, text: 'Allow?', at: 1 }
    useOrchestraStore.setState({
      sessions: {
        s1: session('s1', [
          agent('orchestrator'),
          agent('claude-1', { state: 'blocked', blocked: ask }),
        ]),
        s2: session('s2', [agent('orchestrator'), agent('claude-1', { state: 'exited' })]),
      },
      order: ['s1', 's2'],
    })
    useAttentionStore.setState({ waiting: { s2: { text: 'Deploy?', at: 1 } }, last: {} })
    render(<Button />)
    expect(screen.getByRole('button', { name: 'Orchestra · 3 waiting for you' })).toHaveTextContent(
      '3',
    )
  })

  it('leaves stopped sessions out of the count', () => {
    const ask = { reason: 'permission' as const, text: 'Allow?', at: 1 }
    useOrchestraStore.setState({
      sessions: {
        live: session('live', [
          agent('orchestrator'),
          agent('claude-1', { state: 'blocked', blocked: ask }),
        ]),
        // Read-only after Stop: its failed worker and idle orchestrator need nobody anymore.
        done: {
          ...session('done', [agent('orchestrator'), agent('claude-1', { state: 'exited' })]),
          stoppedAt: 5,
        },
      },
      order: ['live', 'done'],
    })
    useAttentionStore.setState({ waiting: { done: { text: 'Deploy?', at: 1 } }, last: {} })
    render(<Button />)
    expect(screen.getByRole('button', { name: 'Orchestra · 1 waiting for you' })).toHaveTextContent(
      '1',
    )
  })

  it('shows nothing when nobody waits', () => {
    useOrchestraStore.setState({
      sessions: { s1: session('s1', [agent('orchestrator'), agent('claude-1')]) },
      order: ['s1'],
    })
    render(<Button />)
    const button = screen.getByRole('button', { name: 'Orchestra' })
    expect(button).toHaveTextContent('')
  })

  it('reads the latest notice of its session in a polite live region', () => {
    useAttentionStore.setState({
      waiting: {},
      last: { s1: { text: 'claude-1 needs you. Allow?', at: 1 } },
    })
    render(<AttentionLive sessionId="s1" />)
    expect(screen.getByRole('status')).toHaveTextContent('claude-1 needs you. Allow?')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })
})
