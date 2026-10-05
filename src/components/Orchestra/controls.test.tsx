import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn((_text: string) => Promise.resolve()),
  saveTextFile: vi.fn((_path: string, _content: string) => Promise.resolve()),
  saveFile: vi.fn(() => Promise.resolve('C:\\Users\\me\\report.md' as string | null)),
  scribeSaveReport: vi.fn(() =>
    Promise.resolve({ status: 'written', notePath: 'Diario/Sessao.md', detail: null }),
  ),
  mirrors: new Set<string>(),
  /** Screens of fake terminals, for the dialogs an alert reads. */
  screens: new Map<string, string[]>(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  writeClipboardText: mocks.writeClipboardText,
}))

vi.mock('../../lib/tauri/export', () => ({ saveTextFile: mocks.saveTextFile }))
vi.mock('../../lib/dialog', () => ({ saveFile: mocks.saveFile }))

vi.mock('../../lib/terminalMirror', () => ({
  getMirror: (ptyId: string) => {
    const screen = mocks.screens.get(ptyId)
    if (screen) {
      return {
        baseY: 0,
        rows: screen.length,
        modes: { applicationCursorKeys: false },
        getText: () => screen.join('\n'),
        onChange: () => () => {},
      }
    }
    return mocks.mirrors.has(ptyId)
      ? { length: 2, getText: () => 'line one\nline two', onChange: () => () => {} }
      : null
  },
  onMirrorRegistry: () => () => {},
  ensureMirror: vi.fn(),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
}))

vi.mock('./scribe/service', () => ({
  installScribe: vi.fn(),
  prepareSessionContext: vi.fn(() => Promise.resolve()),
  scribeSaveReport: mocks.scribeSaveReport,
}))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { AgentAlert } from './AgentAlert'
import { AgentControls } from './AgentControls'
import { ReportDialog } from './ReportDialog'
import { OrchestraSessionProvider } from './sessionContext'

const ID = 'octrl001'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: 'api',
    task: `task of ${id}`,
    after: [],
    ptyId: `pty-${id}`,
    state: 'thinking',
    progress: 20,
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

function withSession(agents: OrchestraAgent[], patch: Partial<OrchestraSession> = {}) {
  useOrchestraStore.setState({
    sessions: {
      [ID]: {
        id: ID,
        projectId: null,
        cwd: 'C:/repo',
        goal: 'ship it',
        autonomous: false,
        startedAt: 1,
        mode: 'mission',
        agents,
        messages: [],
        segments: [],
        selectedId: null,
        error: null,
        ...patch,
      },
    },
    order: [ID],
    activeId: ID,
  })
}

const inSession = (ui: JSX.Element) =>
  render(<OrchestraSessionProvider sessionId={ID}>{ui}</OrchestraSessionProvider>)

describe('agent controls', () => {
  beforeEach(() => {
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
    mocks.mirrors.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  })

  it('offers interrupt and restart on a working agent, resume once its conversation is known', () => {
    const working = agent('claude-1', { claudeSessionId: 'conv-1' })
    withSession([working])
    inSession(<AgentControls agent={working} />)
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('offers no interrupt on a failed agent, and only export in a stopped orchestration', () => {
    const failed = agent('claude-2', { state: 'exited', exitCode: 1 })
    mocks.mirrors.add('pty-claude-2')
    withSession([failed])
    const { unmount } = inSession(<AgentControls agent={failed} />)
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    unmount()

    withSession([failed], { stoppedAt: 50 })
    inSession(<AgentControls agent={failed} />)
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Export transcript' })).toBeInTheDocument()
  })

  it('exports the whole transcript to the file picked in the save dialog', async () => {
    const done = agent('claude-3', { state: 'done' })
    mocks.mirrors.add('pty-claude-3')
    mocks.saveFile.mockResolvedValueOnce('C:\\Users\\me\\claude-3.txt')
    withSession([done])
    inSession(<AgentControls agent={done} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export transcript' }))
    await waitFor(() =>
      expect(mocks.saveTextFile).toHaveBeenCalledWith(
        'C:\\Users\\me\\claude-3.txt',
        'line one\nline two\n',
      ),
    )
  })
})

describe('report dialog', () => {
  beforeEach(() => {
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  })

  afterEach(() => {
    vi.clearAllMocks()
    useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  })

  it('shows the report and copies, exports and saves it', async () => {
    withSession(
      [
        agent('orchestrator', { area: 'orchestrator' }),
        agent('claude-1', { state: 'done', progress: 100, note: 'shipped', finishedAt: 61_001 }),
        agent('claude-2', { state: 'exited', exitCode: 1, note: 'tests failed' }),
      ],
      { stoppedAt: 90_001 },
    )
    inSession(<ReportDialog open onClose={() => {}} />)
    expect(screen.getByText(/\| claude-1 \| api \| ✓ done/)).toBeInTheDocument()
    expect(
      screen.getByText(/claude-2\*\* \(api\): Exited without reporting done \(code 1\)/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }))
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledTimes(1))
    expect(mocks.writeClipboardText.mock.calls[0][0]).toContain('**Goal:** ship it')

    fireEvent.click(screen.getByRole('button', { name: 'Export .json' }))
    await waitFor(() => expect(mocks.saveTextFile).toHaveBeenCalledTimes(1))
    expect(JSON.parse(mocks.saveTextFile.mock.calls[0][1])).toMatchObject({
      version: 1,
      totals: { done: 1, failed: 1 },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save in Obsidian' }))
    await screen.findByText('Written to Diario/Sessao.md')
    expect(mocks.scribeSaveReport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ID, markdown: expect.stringContaining('# Report') }),
    )
  })
})

describe('agent alert on a dialog (N3)', () => {
  const request = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for npm publish commands",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel',
  ]

  beforeEach(() => {
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
    mocks.screens.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  })

  const blocked = (reason: 'permission' | 'question' | 'report', text: string) =>
    agent('claude-1', { state: 'blocked', blocked: { reason, text, at: 1 } })

  it('offers the options of the real permission request, never a free-text reply', async () => {
    const asking = blocked('permission', 'Claude needs your permission to use Bash')
    mocks.screens.set('pty-claude-1', request)
    withSession([asking])
    const answer = vi.spyOn(useOrchestraStore.getState(), 'answerDialog').mockResolvedValue(true)
    const onReply = vi.fn()
    inSession(<AgentAlert agent={asking} onReply={onReply} onOpenTerminal={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: "2. Yes, and don't ask again for npm publish commands" }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Deny (Esc)' }))
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith(
        ID,
        'claude-1',
        expect.objectContaining({ index: 3, deny: true }),
        expect.stringContaining('3. No, and tell Claude'),
      ),
    )
    expect(onReply).not.toHaveBeenCalled()
  })

  it('without a request it can read, only opens the terminal, and sends nothing', () => {
    const asking = blocked('permission', 'Claude needs your permission to use Bash')
    withSession([asking])
    const answer = vi.spyOn(useOrchestraStore.getState(), 'answerDialog')
    const onOpenTerminal = vi.fn()
    inSession(<AgentAlert agent={asking} onReply={() => {}} onOpenTerminal={onOpenTerminal} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Open terminal'])
    expect(screen.getByText(/Answer it in its terminal/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
    expect(answer).not.toHaveBeenCalled()
  })

  it('keeps Reply for an agent that waits for a message, not for a question dialog', () => {
    const question = blocked('question', 'Pick a database')
    withSession([question])
    const { unmount } = inSession(
      <AgentAlert agent={question} onReply={() => {}} onOpenTerminal={() => {}} />,
    )
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
    unmount()

    const reported = blocked('report', 'need the API key')
    withSession([reported])
    inSession(<AgentAlert agent={reported} onReply={() => {}} onOpenTerminal={() => {}} />)
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument()
  })
})
