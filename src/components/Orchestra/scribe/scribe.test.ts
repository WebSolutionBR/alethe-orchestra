import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import {
  obsidianAppend,
  obsidianDetectVaults,
  obsidianPatchHeading,
  obsidianPut,
  obsidianRead,
  obsidianSearch,
  type ObsidianStatus,
  obsidianStatus,
  obsidianWriteContext,
  scribeAuthorRun,
  scribeMaterialAppend,
} from './api'
import { authorStatusOf, resetSessionRecords, sessionRecord } from './authorStatus'
import { contextNoteLimit, DEFAULT_SCRIBE_CONFIG, notePathFor, useScribeConfig } from './config'
import { sessionContextOf, whenContextSettled } from './contextStore'
import { issueFromStatus, pickVault, scribeState } from './health'
import {
  isScribeNote,
  isScribeParty,
  noteFileName,
  noteFilePath,
  obsidianOpenUri,
  SCRIBE_ID,
  vaultName,
} from './identity'
import { contextHint, obsidianRule, withObsidianRule } from './rule'
import {
  checkScribe,
  flushScribe,
  installScribe,
  prepareSessionContext,
  scribeSaveReport,
  type ScribeSession,
  type ScribeSource,
  type ScribeStore,
  scribeWriteNow,
  useScribeStatus,
} from './service'

const { AUTHENTICATED } = vi.hoisted(() => ({
  AUTHENTICATED: {
    vault_exists: true,
    plugin_found: true,
    has_key: true,
    port: 27124,
    authenticated: true,
    error: null,
  } satisfies ObsidianStatus,
}))

// Never talks to a real vault or runs the Claude CLI: every call is a mock.
vi.mock('./api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianPut: vi.fn(() => Promise.resolve()),
  obsidianPatchHeading: vi.fn(() => Promise.resolve({ applied: true, preexisting: false })),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.resolve(AUTHENTICATED)),
  obsidianSearch: vi.fn(() => Promise.resolve({ total: 0, hits: [] })),
  obsidianRead: vi.fn(() => Promise.reject('note not found')),
  obsidianList: vi.fn(() => Promise.resolve([])),
  obsidianWriteContext: vi.fn(() => Promise.resolve('C:/Temp/alethe-orchestra/context-x.md')),
  obsidianRemoveContext: vi.fn(() => Promise.resolve()),
  scribeAuthorRun: vi.fn(),
  scribeAuthorCancel: vi.fn(() => Promise.resolve(true)),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
  scribeMaterialRead: vi.fn(() => Promise.resolve('')),
  scribeMaterialRemove: vi.fn(() => Promise.resolve()),
  scribeReadSources: vi.fn(() => Promise.resolve([])),
  scribeVaultIndex: vi.fn(() => Promise.resolve(['Ferramentas/Alethe.md'])),
}))

const at = new Date(2026, 9, 4, 14, 5).getTime()

const PLAN = `=== TITLE ===
Escriba v2
=== END ===
=== SUMMARY ===
Caso do claude-1 registrado
=== END ===
=== NOTE path="@diary" mode="full" ===
# Sessão 2026-10-04 — Escriba v2
## Resumo do dia
Ver [[Alethe]].
=== END ===`

function authorAnswers(result = PLAN) {
  vi.mocked(scribeAuthorRun).mockResolvedValue({
    ok: true,
    result,
    error: null,
    detail: null,
    durationMs: 10,
    costUsd: null,
    turns: 2,
    denials: 0,
    mcp: true,
  })
}

/* ------------------------------------------------------------------ a fake orchestra store */

let state: ScribeSource = { sessions: {} }
const listeners = new Set<(next: ScribeSource, prev: ScribeSource) => void>()
let bus: ((event: OrchestraEvent) => void) | null = null
const posted = vi.fn()
const store: ScribeStore = {
  getState: () => state,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  listen: (handler) => {
    bus = handler
    return () => {
      bus = null
    }
  },
  projectName: () => 'Sistemas e automações',
  post: posted,
}

function setSessions(sessions: Record<string, ScribeSession>) {
  const prev = state
  state = { sessions }
  for (const listener of listeners) listener(state, prev)
}

function session(id: string, patch: Partial<ScribeSession> = {}): ScribeSession {
  return {
    id,
    projectId: 'p1',
    cwd: 'C:/repo/alethe',
    goal: 'Refazer o escriba',
    startedAt: at,
    agents: [
      {
        id: 'orchestrator',
        area: 'orchestrator',
        state: 'thinking',
        progress: 0,
        task: 'Refazer o escriba',
      },
      {
        id: 'claude-1',
        area: 'api',
        state: 'done',
        progress: 100,
        task: 'Leia C:/tarefas/claude-1.md',
        note: 'pronto',
        transcriptPath: 'C:/acc/projects/p/c1.jsonl',
      },
    ],
    ...patch,
  }
}

const done = (sessionId: string, agent = 'claude-1'): OrchestraEvent => ({
  kind: 'report',
  session: sessionId,
  at: at + 1,
  agent_id: agent,
  progress: 100,
  status: 'done',
  note: 'API pronta',
})

/* ------------------------------------------------------------------ the scribe service */

describe('the scribe service', () => {
  beforeAll(() => {
    useScribeConfig.getState().update({ vaultPath: 'G:\\Vault' })
    installScribe(store)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    // The owner turned the author on (it is off by default: see the test below).
    useScribeConfig.getState().update({
      ...DEFAULT_SCRIBE_CONFIG,
      vaultPath: 'G:\\Vault',
      authorEnabled: true,
      authorDelaySec: 30,
    })
    authorAnswers()
    vi.mocked(obsidianPut).mockClear()
    vi.mocked(obsidianAppend).mockClear()
    vi.mocked(obsidianPatchHeading).mockClear()
    vi.mocked(scribeMaterialAppend).mockClear()
    vi.mocked(scribeAuthorRun).mockClear()
    vi.mocked(obsidianRead).mockReset().mockRejectedValue('note not found')
    posted.mockClear()
  })

  afterEach(() => {
    setSessions({})
    vi.useRealTimers()
  })

  it('keeps events as local material and never appends a raw block to the vault', async () => {
    setSessions({ omat0001: session('omat0001') })
    bus?.({
      kind: 'hook',
      session: 'omat0001',
      at: at + 1,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'PreToolUse', tool_name: 'Edit', target: 'C:/repo/alethe/src/a.ts' },
    })
    bus?.({
      kind: 'message',
      session: 'omat0001',
      at: at + 2,
      from: 'claude-1',
      to: 'orchestrator',
      text: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 ok',
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(obsidianAppend).not.toHaveBeenCalled()
    expect(obsidianPut).not.toHaveBeenCalled()
    const lines = vi.mocked(scribeMaterialAppend).mock.calls.flatMap((call) => call[1])
    expect(lines.some((l) => l.includes('"kind":"start"'))).toBe(true)
    expect(lines.some((l) => l.includes('C:\\\\repo\\\\alethe\\\\src\\\\a.ts'))).toBe(true)
    // Secrets are masked before they reach the disk.
    expect(lines.join('\n')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(lines.join('\n')).toContain('[redigido]')
  })

  it('is off until the owner turns it on, and then writes only at the end by default', async () => {
    useScribeConfig.getState().update({ ...DEFAULT_SCRIBE_CONFIG, vaultPath: 'G:\\Vault' })
    expect(useScribeConfig.getState()).toMatchObject({
      authorEnabled: false,
      authorOnWorkerDone: false,
      authorOnSessionEnd: true,
      authorMaxTurns: 40,
      authorMaxBudgetUsd: 5,
    })
    setSessions({ odflt001: session('odflt001') })
    bus?.(done('odflt001'))
    setSessions({})
    await vi.advanceTimersByTimeAsync(300_000)
    expect(scribeAuthorRun).not.toHaveBeenCalled()
    expect(sessionRecord('odflt001')?.pendingFinal ?? false).toBe(false)

    // Turned on: a finished worker still does not write; the end of the session does.
    useScribeConfig.getState().update({ authorEnabled: true })
    setSessions({ odflt002: session('odflt002') })
    bus?.(done('odflt002'))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(scribeAuthorRun).not.toHaveBeenCalled()
    setSessions({})
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(1))
  })

  it('writes the session note after a worker finishes, when that option is on', async () => {
    useScribeConfig.getState().update({ authorOnWorkerDone: true })
    setSessions({ odone001: session('odone001') })
    bus?.(done('odone001'))
    expect(authorStatusOf('odone001').phase).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(scribeAuthorRun).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(obsidianPut).toHaveBeenCalledTimes(1))
    const [, notePath, content] = vi.mocked(obsidianPut).mock.calls[0]
    expect(notePath).toBe('Diário/2026/10 - Outubro/Sessão 2026-10-04 — Escriba v2.md')
    expect(content).toContain('escriba: alethe-orchestra')
    const request = vi.mocked(scribeAuthorRun).mock.calls[0][0]
    expect(request.prompt).toContain('Worker(s) claude-1 just finished')
    // Only this session's transcripts and task files, with the turn and spending ceilings.
    expect(request).toMatchObject({
      sessionId: 'odone001',
      sessionFolder: 'C:/repo/alethe',
      transcripts: [{ name: 'claude-1', path: 'C:/acc/projects/p/c1.jsonl' }],
      sources: ['C:/tarefas/claude-1.md'],
      maxTurns: 40,
      maxBudgetUsd: 5,
    })
    expect(request).not.toHaveProperty('readDirs')
    await vi.waitFor(() => expect(authorStatusOf('odone001').phase).toBe('ready'))
    expect(authorStatusOf('odone001')).toMatchObject({
      notePath,
      summary: 'Caso do claude-1 registrado',
      syntheses: 1,
    })
    expect(posted).toHaveBeenCalledWith(
      'odone001',
      'Sessão 2026-10-04 — Escriba v2.md',
      'Caso do claude-1 registrado',
      expect.any(Number),
    )
    expect(sessionRecord('odone001')).toMatchObject({ diaryPath: notePath, title: 'Escriba v2' })
  })

  it('runs the final pass when the session ends, and when its agents are stopped', async () => {
    setSessions({ oend0001: session('oend0001'), ostop001: session('ostop001') })
    setSessions({ ostop001: session('ostop001') })
    // Owed from the moment the session ends, until its final pass is written.
    expect(sessionRecord('oend0001')?.pendingFinal).toBe(true)
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(1))
    expect(vi.mocked(scribeAuthorRun).mock.calls[0][0].prompt).toContain('This is the final pass')
    await vi.waitFor(() => expect(sessionRecord('oend0001')?.pendingFinal).toBe(false))

    // Stopping the agents keeps the session on screen but ends it for the scribe.
    setSessions({ ostop001: session('ostop001', { stoppedAt: at + 5 }) })
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(2))
    // Closing it later only forgets it: no third pass.
    setSessions({})
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scribeAuthorRun).toHaveBeenCalledTimes(2)
  })

  it('does nothing automatic with the author off, and "write now" respects it', async () => {
    useScribeConfig.getState().update({ authorEnabled: false })
    setSessions({ ooff0001: session('ooff0001') })
    bus?.(done('ooff0001'))
    scribeWriteNow('ooff0001')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scribeAuthorRun).not.toHaveBeenCalled()
    useScribeConfig.getState().update({ authorEnabled: true })
    scribeWriteNow('ooff0001')
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(1))
  })

  it('reports why a pass failed and keeps the final pass owed', async () => {
    vi.mocked(scribeAuthorRun).mockResolvedValue({
      ok: false,
      result: '',
      error: 'cli-missing',
      detail: 'Claude Code CLI not found',
      durationMs: 1,
      costUsd: null,
      turns: null,
      denials: 0,
      mcp: false,
    })
    setSessions({ ofail001: session('ofail001') })
    setSessions({})
    await vi.waitFor(() => expect(authorStatusOf('ofail001').phase).toBe('failed'))
    expect(authorStatusOf('ofail001')).toMatchObject({ failure: 'cli-missing' })
    // Nothing was spent, so no attempt was used up: the pass stays owed.
    expect(sessionRecord('ofail001')).toMatchObject({ pendingFinal: true, finalAttempts: 0 })
    expect(obsidianPut).not.toHaveBeenCalled()
  })

  it('tries a costly final pass twice at most, then keeps the material to copy', async () => {
    vi.mocked(scribeAuthorRun).mockResolvedValue({
      ok: false,
      result: '',
      error: 'timeout',
      detail: '720 s',
      durationMs: 720_000,
      costUsd: 0.4,
      turns: 12,
      denials: 0,
      mcp: true,
    })
    setSessions({ otwice01: session('otwice01') })
    bus?.({
      kind: 'message',
      session: 'otwice01',
      at: at + 1,
      from: 'claude-1',
      to: 'orchestrator',
      text: 'decisão: fila no app',
    })
    setSessions({})
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sessionRecord('otwice01')?.finalAttempts).toBe(1))
    expect(sessionRecord('otwice01')?.pendingFinal).toBe(true)
    expect(authorStatusOf('otwice01')).toMatchObject({ lastCostUsd: 0.4, sessionCostUsd: 0.4 })

    // One more try, later, on its own.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sessionRecord('otwice01')?.pendingFinal).toBe(false))
    expect(sessionRecord('otwice01')).toMatchObject({ finalAttempts: 2, costUsd: 0.8 })
    expect(authorStatusOf('otwice01').sessionCostUsd).toBeCloseTo(0.8)
    const failed = useScribeStatus.getState().failed.filter((f) => f.session === 'otwice01')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      reasonKey: 'orchestra.scribe.finalGivenUp',
      reasonParams: { count: 2 },
      reason: 'timeout: 720 s',
    })
    expect(failed[0].content).toContain('decisão: fila no app')

    // Given up: neither a timer nor the next start runs it again.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(scribeAuthorRun).toHaveBeenCalledTimes(2)
  })

  it('runs a final pass that waited for Obsidian as soon as Obsidian answers again', async () => {
    vi.mocked(obsidianRead).mockRejectedValue('Obsidian is not reachable (is the app open?)')
    setSessions({ owait001: session('owait001') })
    setSessions({})
    await vi.waitFor(() =>
      expect(authorStatusOf('owait001')).toMatchObject({ failure: 'unreachable' }),
    )
    // Nothing ran: no usage spent, no attempt used.
    expect(scribeAuthorRun).not.toHaveBeenCalled()
    expect(sessionRecord('owait001')).toMatchObject({ pendingFinal: true, finalAttempts: 0 })

    vi.mocked(obsidianRead).mockReset().mockRejectedValue('note not found')
    useScribeStatus.setState((s) => ({ health: { ...s.health, issue: 'unreachable' } }))
    await checkScribe()
    // Every pass still owed goes now (earlier tests left some); this one among them.
    const ranFor = () =>
      vi.mocked(scribeAuthorRun).mock.calls.filter(([request]) => request.sessionId === 'owait001')
    await vi.waitFor(() => expect(ranFor()).toHaveLength(1))
    await vi.waitFor(() => expect(sessionRecord('owait001')?.pendingFinal).toBe(false))
  })

  it('files an agent `orch note` in the agents note, under its own heading', async () => {
    setSessions({ onote001: session('onote001') })
    bus?.({
      kind: 'note',
      session: 'onote001',
      at: at + 3,
      agent_id: 'claude-1',
      text: '### Decisão\n- A fila fica no app porque a chave não sai do backend. password=abc12345',
    })
    await vi.waitFor(() => expect(obsidianPut).toHaveBeenCalledTimes(1))
    const [, notePath, content] = vi.mocked(obsidianPut).mock.calls[0]
    expect(notePath).toBe(notePathFor(useScribeConfig.getState(), at + 3))
    expect(content).toContain('## claude-1 · api')
    expect(content).toContain('password=[redigido]')
    // Filed as is: it is not a synthesis of the author.
    await vi.advanceTimersByTimeAsync(0)
    expect(authorStatusOf('onote001').syntheses).toBe(0)
    expect(posted).not.toHaveBeenCalled()
  })

  it('saves a report as material folded into the session note', async () => {
    setSessions({ orep0001: session('orep0001') })
    const saved = scribeSaveReport({
      sessionId: 'orep0001',
      markdown: '# Relatório\n- claude-1: concluído',
    })
    await vi.waitFor(() => expect(scribeAuthorRun).toHaveBeenCalledTimes(1))
    expect(vi.mocked(scribeAuthorRun).mock.calls[0][0].prompt).toContain('# Relatório')
    await expect(saved).resolves.toMatchObject({
      status: 'written',
      notePath: 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Escriba v2.md',
    })
  })

  it('keeps the final pass of running sessions owed when the app closes', async () => {
    setSessions({ oclose01: session('oclose01') })
    vi.mocked(scribeMaterialAppend).mockClear()
    await flushScribe(500)
    expect(sessionRecord('oclose01')).toMatchObject({ pendingFinal: true })
    expect(sessionRecord('oclose01')?.snapshot?.agents.map((a) => a.id)).toEqual([
      'orchestrator',
      'claude-1',
    ])
    expect(scribeMaterialAppend).toHaveBeenCalled()
    resetSessionRecords()
    expect(sessionRecord('oclose01')?.pendingFinal).toBe(true)
  })
})

/* ------------------------------------------------------------------ settings, health, identity */

describe('notePathFor', () => {
  it('fills the date and keeps the path inside the vault', () => {
    expect(notePathFor(DEFAULT_SCRIBE_CONFIG, at)).toBe('Alethe Orchestra/2026-10-04 Orchestra.md')
    expect(
      notePathFor({ ...DEFAULT_SCRIBE_CONFIG, folder: '../x/./y', noteName: 'a:b {date}' }, at),
    ).toBe('x/y/a-b 2026-10-04.md')
  })
})

describe('scribe health', () => {
  afterEach(() => {
    useScribeConfig.getState().update({ ...DEFAULT_SCRIBE_CONFIG })
    vi.mocked(obsidianDetectVaults).mockReset().mockResolvedValue([])
    vi.mocked(obsidianStatus).mockReset().mockResolvedValue(AUTHENTICATED)
  })

  it('picks the open vault, else the only one, never a guess', () => {
    const closed = { path: 'D:\\Closed', open: false }
    const open = { path: 'G:\\Meu Drive\\TODO', open: true }
    expect(pickVault([closed, open])).toBe(open.path)
    expect(pickVault([closed])).toBe(closed.path)
    expect(pickVault([closed, { path: 'E:\\Other', open: false }])).toBeNull()
    expect(pickVault([])).toBeNull()
  })

  it('names why it cannot write', () => {
    expect(issueFromStatus(AUTHENTICATED)).toBeNull()
    const down = { ...AUTHENTICATED, authenticated: false }
    expect(issueFromStatus({ ...down, vault_exists: false })).toBe('vault-missing')
    expect(issueFromStatus({ ...down, plugin_found: false })).toBe('plugin-missing')
    expect(issueFromStatus({ ...down, has_key: false })).toBe('no-key')
    expect(issueFromStatus({ ...down, error: 'Local REST API rejected the key' })).toBe('rejected')
    expect(issueFromStatus({ ...down, error: 'Obsidian is not reachable' })).toBe('unreachable')
  })

  it('derives the chip state with failures first, the author included', () => {
    const base = { enabled: true, issue: null, sending: false, pending: 0, failures: 0 }
    expect(scribeState(base)).toBe('listening')
    expect(scribeState({ ...base, author: 'scheduled' })).toBe('scheduled')
    expect(scribeState({ ...base, author: 'writing' })).toBe('writing')
    expect(scribeState({ ...base, author: 'failed' })).toBe('failing')
    expect(scribeState({ ...base, pending: 2, author: 'scheduled' })).toBe('pending')
    expect(scribeState({ ...base, pending: 2, sending: true })).toBe('writing')
    expect(scribeState({ ...base, sending: true, failures: 1 })).toBe('failing')
    expect(scribeState({ ...base, issue: 'no-vault' })).toBe('failing')
    expect(scribeState({ ...base, enabled: false, issue: 'no-vault' })).toBe('off')
  })

  it('adopts the open vault when none is configured', async () => {
    useScribeConfig.getState().update({ enabled: true, vaultPath: '' })
    vi.mocked(obsidianDetectVaults).mockResolvedValue([
      { path: 'D:\\Closed', open: false },
      { path: 'G:\\Meu Drive\\TODO', open: true },
    ])
    await checkScribe()
    expect(useScribeConfig.getState().vaultPath).toBe('G:\\Meu Drive\\TODO')
    expect(obsidianStatus).toHaveBeenCalledWith({ vaultPath: 'G:\\Meu Drive\\TODO' })
    expect(useScribeStatus.getState().health.issue).toBeNull()
  })

  it('warns instead of failing silently when no vault can be chosen', async () => {
    useScribeConfig.getState().update({ enabled: true, vaultPath: '' })
    await checkScribe()
    expect(useScribeStatus.getState().health.issue).toBe('no-vault')
    vi.mocked(obsidianDetectVaults).mockResolvedValue([
      { path: 'D:\\A', open: false },
      { path: 'D:\\B', open: false },
    ])
    await checkScribe()
    expect(useScribeStatus.getState().health.issue).toBe('pick-vault')
    expect(useScribeConfig.getState().vaultPath).toBe('')
  })
})

describe('scribe identity', () => {
  it('builds the obsidian://open link and the note file path', () => {
    const note = 'Alethe Orchestra/2026-10-04 Orchestra.md'
    expect(vaultName('G:\\Meu Drive\\Anotações\\TODO\\')).toBe('TODO')
    expect(obsidianOpenUri('G:\\Meu Drive\\Anotações\\TODO', note)).toBe(
      'obsidian://open?vault=TODO&file=Alethe%20Orchestra%2F2026-10-04%20Orchestra.md',
    )
    expect(obsidianOpenUri('', note)).toBeNull()
    expect(noteFilePath('G:\\Vault\\', note)).toBe(
      'G:\\Vault\\Alethe Orchestra\\2026-10-04 Orchestra.md',
    )
    expect(noteFileName(note)).toBe('2026-10-04 Orchestra.md')
  })

  it('tells the scribe apart from agents on the bus', () => {
    expect(isScribeParty(SCRIBE_ID)).toBe(true)
    expect(isScribeNote('2026-10-04 Orchestra.md')).toBe(true)
    expect(isScribeParty('claude-1')).toBe(false)
    expect(isScribeParty('orchestrator')).toBe(false)
  })
})

describe('obsidianRule', () => {
  const config = { ...DEFAULT_SCRIBE_CONFIG, vaultPath: 'G:\\Vault' }

  it('names the note and can be turned off', () => {
    expect(obsidianRule(config, at)).toContain('"Alethe Orchestra/2026-10-04 Orchestra.md"')
    expect(obsidianRule(config, at)).toContain('"G:/Vault"')
    expect(withObsidianRule('base', { ...config, injectRule: false })).toBe('base')
  })

  it("asks for the owner's pattern and never says where the REST API key lives", () => {
    const rule = obsidianRule(config, at)
    expect(rule).toMatch(/^Fixed user rule \(mandatory\): before you start, consult Obsidian/)
    expect(rule).toContain('read the notes of that area in full first.')
    for (const part of [
      'Write knowledge, not a log, in Brazilian Portuguese',
      'dates as DD/MM/AAAA',
      'each decision with its reason',
      'how it was validated',
      'the gotcha',
      'No command logs',
      '[[links]] only to notes that exist',
      'never secrets',
      '# Notas relacionadas',
      'orch.cmd note --stdin',
    ])
      expect(rule).toContain(part)
    expect(rule).not.toMatch(/data\.json|27124|REST API/)
    const off = obsidianRule({ ...config, consultContext: false }, at)
    expect(off).not.toContain('consult Obsidian')
    expect(off).toMatch(/^Fixed user rule \(mandatory\): before you report done, record your part/)
  })

  it('points the agents to the context file of their session', () => {
    const ready = { status: 'ready' as const, file: 'C:\\Temp\\alethe-orchestra\\context-oabc.md' }
    expect(contextHint('orchestrator', ready, config)).toContain(
      'saved a summary to "C:/Temp/alethe-orchestra/context-oabc.md". Read that file before you split the work',
    )
    expect(contextHint('worker', ready, config)).toContain(
      'is in "C:/Temp/alethe-orchestra/context-oabc.md": read it before you start.',
    )
    const failed = { status: 'failed' as const, file: null }
    expect(contextHint('orchestrator', failed, config)).toContain(
      'could not consult Obsidian when this session started',
    )
    expect(contextHint('worker', failed, config)).toBe('')
    expect(contextHint('orchestrator', ready, { ...config, consultContext: false })).toBe('')
    expect(contextHint('worker', null, config)).toBe('')
  })
})

describe('prepareSessionContext', () => {
  afterEach(() => {
    useScribeConfig.getState().update({ ...DEFAULT_SCRIBE_CONFIG })
    vi.mocked(obsidianSearch).mockReset().mockResolvedValue({ total: 0, hits: [] })
    vi.mocked(obsidianRead).mockReset().mockRejectedValue('note not found')
    vi.mocked(obsidianWriteContext).mockClear()
  })

  it('stays off when consulting is turned off', async () => {
    useScribeConfig.getState().update({ vaultPath: 'G:\\Vault', consultContext: false })
    const context = await prepareSessionContext({ sessionId: 'ooff1234', goal: 'g', cwd: null })
    expect(context.status).toBe('off')
    expect(sessionContextOf('ooff1234')?.status).toBe('off')
    expect(obsidianSearch).not.toHaveBeenCalled()
  })

  it('consults the vault, saves the file and keeps the result for the prompts', async () => {
    useScribeConfig.getState().update({ vaultPath: 'G:\\Vault', contextNotes: 99 })
    expect(contextNoteLimit(useScribeConfig.getState())).toBe(12)
    vi.mocked(obsidianSearch).mockResolvedValue({
      total: 1,
      hits: [{ filename: 'Ferramentas/Alethe.md', score: -1, match_count: 2, contexts: [] }],
    })
    vi.mocked(obsidianRead).mockImplementation(async (_target, path) => ({
      path,
      content: '## Build\n- o alethe usa o ConPTY',
      size: 30,
      truncated: false,
    }))
    const pending = prepareSessionContext({
      sessionId: 'oyes1234',
      goal: 'Alethe',
      cwd: 'C:/x/alethe',
      at,
    })
    expect(sessionContextOf('oyes1234')?.status).toBe('pending')
    expect(whenContextSettled('oyes1234')).not.toBeNull()
    const context = await pending
    expect(context).toMatchObject({
      status: 'ready',
      file: 'C:/Temp/alethe-orchestra/context-x.md',
    })
    expect(context.notes.map((note) => note.path)).toEqual([
      'Alethe Orchestra/2026-10-04 Orchestra.md',
      'Ferramentas/Alethe.md',
    ])
    expect(obsidianWriteContext).toHaveBeenCalledWith(
      'oyes1234',
      expect.stringContaining('o alethe usa o ConPTY'),
    )
  })
})
