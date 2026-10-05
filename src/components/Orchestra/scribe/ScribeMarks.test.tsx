import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../../lib/tauri', () => ({
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
  writeClipboardText: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

// Never talks to a real vault or runs the Claude CLI.
vi.mock('./api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianPut: vi.fn(() => Promise.resolve()),
  obsidianPatchHeading: vi.fn(() => Promise.resolve({ applied: true, preexisting: false })),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() =>
    Promise.resolve({
      vault_exists: true,
      plugin_found: true,
      has_key: true,
      port: 27124,
      authenticated: true,
      error: null,
    }),
  ),
  obsidianSearch: vi.fn(() => Promise.resolve({ total: 0, hits: [] })),
  obsidianRead: vi.fn(() => Promise.reject('note not found')),
  obsidianList: vi.fn(() => Promise.resolve([])),
  obsidianWriteContext: vi.fn(() => Promise.resolve('C:/Temp/alethe-orchestra/context-x.md')),
  obsidianRemoveContext: vi.fn(() => Promise.resolve()),
  scribeAuthorRun: vi.fn(() =>
    Promise.resolve({
      ok: false,
      result: '',
      error: 'cli-missing',
      detail: null,
      durationMs: 1,
      costUsd: null,
      turns: null,
      denials: 0,
      mcp: false,
    }),
  ),
  scribeAuthorCancel: vi.fn(() => Promise.resolve(false)),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
  scribeMaterialRead: vi.fn(() => Promise.resolve('')),
  scribeMaterialRemove: vi.fn(() => Promise.resolve()),
  scribeReadSources: vi.fn(() => Promise.resolve([])),
  scribeVaultIndex: vi.fn(() => Promise.resolve([])),
}))

import { openInBrowser, writeClipboardText } from '../../../lib/tauri'
import { type OrchestraSession, useOrchestraStore } from '../../../stores/orchestraStore'
import { OrchestraSessionProvider } from '../sessionContext'
import { scribeAuthorRun } from './api'
import { IDLE_AUTHOR, patchAuthorStatus, useScribeAuthor } from './authorStatus'
import { DEFAULT_SCRIBE_CONFIG, useScribeConfig } from './config'
import { contextState } from './context'
import { clearSessionContext, setSessionContext } from './contextStore'
import { SCRIBE_ID } from './identity'
import { ScribeChip } from './ScribeChip'
import { ScribeBadge, ScribeCard, ScribeNode, ScribeTile } from './ScribeMarks'
import { useScribeStatus } from './service'
import { useScribePanel } from './ui'

const ID = 'oscribe1'
const DIARY = 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Escriba v2.md'

function session(): OrchestraSession {
  return {
    id: ID,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: false,
    startedAt: Date.now(),
    mode: 'constellation',
    agents: [],
    messages: [
      {
        id: 1,
        at: Date.now(),
        from: SCRIBE_ID,
        to: 'Sessão 2026-10-04 — Escriba v2.md',
        text: 'caso',
      },
    ],
    segments: [],
    selectedId: null,
    error: null,
  } as OrchestraSession
}

function renderInSession(ui: JSX.Element) {
  return render(<OrchestraSessionProvider sessionId={ID}>{ui}</OrchestraSessionProvider>)
}

describe('scribe marks', () => {
  beforeEach(() => {
    // A configured vault that answers, as in daily use.
    useScribeConfig.getState().update({ enabled: true, vaultPath: 'G:\\Meu Drive\\TODO' })
    useScribeStatus.setState({
      health: { issue: null, detail: null, checking: false, checkedAt: null },
    })
    useOrchestraStore.setState({ sessions: { [ID]: session() }, order: [ID], activeId: ID })
  })

  afterEach(() => {
    act(() => useScribePanel.getState().close())
    useScribeStatus.setState({
      health: { issue: null, detail: null, checking: false, checkedAt: null },
      failed: [],
    })
    useScribeAuthor.setState({ bySession: {} })
    useScribeConfig.getState().update({ ...DEFAULT_SCRIBE_CONFIG })
    useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
    clearSessionContext(ID)
    localStorage.clear()
  })

  it('opens the chip panel and the agents note in Obsidian', async () => {
    renderInSession(<ScribeChip />)
    const chip = screen.getByRole('button', { name: /Obsidian scribe: listening/ })
    fireEvent.click(chip)
    expect(screen.getByRole('dialog', { name: 'Obsidian scribe' })).toBeTruthy()
    expect(screen.getByText('not written yet')).toBeTruthy()
    expect(screen.getByText('Alethe Orchestra/', { exact: false })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Open in Obsidian/ }))
    })
    expect(openInBrowser).toHaveBeenCalledWith(
      expect.stringMatching(/^obsidian:\/\/open\?vault=TODO&file=Alethe%20Orchestra%2F/),
    )
  })

  it('shows the session note, what the author did, what it cost, and opens the note', async () => {
    useScribeConfig.getState().update({ authorEnabled: true })
    patchAuthorStatus(ID, {
      ...IDLE_AUTHOR,
      phase: 'ready',
      notePath: DIARY,
      summary: 'Caso do escriba registrado',
      notes: [DIARY, 'Ferramentas/Alethe.md'],
      issues: ['Links removidos (nota inexistente): Sumida'],
      syntheses: 1,
      lastAt: Date.now(),
      lastCostUsd: 0.42,
      sessionCostUsd: 1.1,
    })
    renderInSession(<ScribeChip />)
    fireEvent.click(screen.getByRole('button', { name: /^Obsidian scribe:/ }))
    expect(screen.getByText(/^note ready · /)).toBeTruthy()
    expect(screen.getByText('$0.42 last pass · $1.10 this session')).toBeTruthy()
    expect(screen.getByText('Caso do escriba registrado')).toBeTruthy()
    expect(screen.getByText('Links removidos (nota inexistente): Sumida')).toBeTruthy()
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Sessão 2026-10-04 — Escriba v2.md' })[0],
      )
    })
    expect(openInBrowser).toHaveBeenCalledWith(
      `obsidian://open?vault=TODO&file=${encodeURIComponent(DIARY)}`,
    )
  })

  it('writes the note now on request and says when it failed', async () => {
    useScribeConfig.getState().update({ authorEnabled: true })
    renderInSession(<ScribeChip />)
    fireEvent.click(screen.getByRole('button', { name: /^Obsidian scribe:/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Write note now/ }))
    })
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('The last note failed'),
    )
    expect(screen.getByText(/^failed: the Claude Code CLI was not found/)).toBeTruthy()
  })

  it('starts with the author off, explains the cost and turns it on from the chip', () => {
    // The default: the owner has not turned the author on.
    renderInSession(<ScribeChip />)
    fireEvent.click(screen.getByRole('button', { name: /The note author is off/ }))
    const button = screen.getByRole('button', { name: /Write note now/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('off in Preferences')).toBeTruthy()
    const offer = screen.getByRole('region', { name: 'The note author is off' })
    expect(offer.textContent).toContain('spends that account’s usage, up to 40 turns and $5.00')
    expect(useScribeConfig.getState().authorEnabled).toBe(false)
    fireEvent.click(
      screen.getByRole('button', { name: 'Turn on the scribe author (uses the session account)' }),
    )
    expect(useScribeConfig.getState().authorEnabled).toBe(true)
    expect(screen.queryByRole('region', { name: 'The note author is off' })).toBeNull()
    const enabled = screen.getByRole('button', { name: /Write note now/ }) as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
  })

  it('keeps what could not be written, ready to copy', async () => {
    useScribeStatus.setState({
      failed: [
        {
          id: 7,
          session: ID,
          label: 'síntese',
          notePath: 'Minha nota.md',
          content: '### Caso\n- texto',
          reason: 'a nota já existe e não foi criada pelo escriba: não é sobrescrita',
          at: Date.now(),
        },
        {
          id: 8,
          session: ID,
          label: 'final',
          notePath: 'Diário/x.md',
          content: 'material',
          reason: 'timeout: 720 s',
          reasonKey: 'orchestra.scribe.finalGivenUp',
          reasonParams: { count: 2 },
          at: Date.now(),
        },
      ],
    })
    renderInSession(<ScribeChip />)
    fireEvent.click(screen.getByRole('button', { name: /^Obsidian scribe:/ }))
    expect(screen.getByText('Not written (2)')).toBeTruthy()
    expect(
      screen.getByText(
        'The final pass failed 2 times and was given up; the session material is kept here to copy.',
      ),
    ).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Copy/ })[0])
    })
    expect(writeClipboardText).toHaveBeenCalledWith('### Caso\n- texto')
    expect(screen.getByRole('button', { name: /Copied/ })).toBeTruthy()
  })

  it('shows a warning with the fixes when it cannot write', async () => {
    useScribeConfig.getState().update({ vaultPath: '' })
    useScribeStatus.setState({
      health: { issue: 'no-vault', detail: null, checking: false, checkedAt: 1 },
    })
    renderInSession(<ScribeChip />)
    fireEvent.click(screen.getByRole('button', { name: /Obsidian scribe: failing/ }))
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain('No Obsidian vault found')
    expect(screen.getByRole('button', { name: /Detect again/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Open settings/ }).length).toBeGreaterThan(0)
  })

  it('opens the panel of its session from a view mark', () => {
    const lines = session().messages
    renderInSession(
      <>
        <ScribeChip />
        <ScribeNode sessionId={ID} lines={lines} x={10} y={10} width={200} />
        <ScribeCard sessionId={ID} lines={lines} />
        <ScribeBadge sessionId={ID} count={lines.length} />
      </>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: /1 syntheses/ })[0])
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('shows the last synthesis of its own session in the terminals tile', () => {
    patchAuthorStatus(ID, {
      ...IDLE_AUTHOR,
      phase: 'ready',
      notePath: DIARY,
      summary: 'Caso do escriba registrado',
      notes: [DIARY, 'Ferramentas/Alethe - escriba.md'],
      syntheses: 1,
      lastAt: Date.now(),
    })
    patchAuthorStatus('oother00', { ...IDLE_AUTHOR, summary: 'outra sessão', lastAt: Date.now() })
    renderInSession(<ScribeTile sessionId={ID} />)
    expect(screen.getByText('Sessão 2026-10-04 — Escriba v2.md')).toBeTruthy()
    expect(screen.getByText('Caso do escriba registrado')).toBeTruthy()
    expect(screen.getByText('Alethe - escriba.md')).toBeTruthy()
    expect(screen.queryByText('outra sessão')).toBeNull()
  })

  it('lists the notes consulted for the session and opens them in Obsidian', async () => {
    setSessionContext(
      ID,
      contextState('ready', Date.now(), {
        notes: [
          {
            path: 'Alethe Orchestra/2026-10-04 Orchestra.md',
            title: '2026-10-04 Orchestra',
            kind: 'session',
            terms: [],
          },
          { path: 'Ferramentas/Nota.md', title: 'Nota', kind: 'search', terms: ['alethe'] },
        ],
        file: 'C:/Temp/alethe-orchestra/context-oscribe1.md',
      }),
    )
    renderInSession(<ScribeChip />)
    fireEvent.click(screen.getByRole('button', { name: /^Obsidian scribe:/ }))
    expect(screen.getByRole('region', { name: 'Obsidian context' })).toBeTruthy()
    expect(screen.getByText(/^Consulted: 2 notes · /)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open “Nota” in Obsidian' }))
    })
    expect(openInBrowser).toHaveBeenCalledWith(
      'obsidian://open?vault=TODO&file=Ferramentas%2FNota.md',
    )
  })

  it('warns on the chip and in the panel when Obsidian could not be consulted', () => {
    setSessionContext(ID, contextState('failed', Date.now(), { failure: 'unreachable' }))
    renderInSession(<ScribeChip />)
    const chip = screen.getByRole('button', {
      name: /Obsidian was not consulted for this session\./,
    })
    expect(chip.getAttribute('data-context')).toBe('failed')
    fireEvent.click(chip)
    expect(screen.getByRole('status').textContent).toBe(
      'Could not consult Obsidian: Obsidian did not answer. This session started without that context.',
    )
  })
})
