import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent, OrchestraLaunch } from '../lib/tauri/orchestra'

type SpawnArgs = {
  id: string
  cols?: number
  rows?: number
  extraArgs?: string[]
  env?: Record<string, string>
}

const mocks = vi.hoisted(() => {
  const bus = { handler: null as ((event: OrchestraEvent) => void) | null }
  const unlisten = vi.fn()
  const launch: OrchestraLaunch = {
    endpoint: 'http://127.0.0.1:1',
    token: 't',
    settings_path: 's.json',
    cli_path: 'orch.cmd',
    path_env: '',
  }
  return {
    bus,
    unlisten,
    listenOrchestra: vi.fn((handler: (event: OrchestraEvent) => void) => {
      bus.handler = handler
      return Promise.resolve(unlisten)
    }),
    orchestraReset: vi.fn((_sessionId: string) => Promise.resolve()),
    orchestraEnd: vi.fn((_sessionId: string) => Promise.resolve()),
    orchestraPrepare: vi.fn((_sessionId: string, _agentId: string) => Promise.resolve(launch)),
    spawnPty: vi.fn((_args: SpawnArgs) => Promise.resolve({ id: '' })),
    killPty: vi.fn((_id: string) => Promise.resolve()),
    writePty: vi.fn((_id: string, _data: string) => Promise.resolve()),
    confirm: vi.fn(() => Promise.resolve(true)),
    ensureMirror: vi.fn((_ptyId: string, _opts: { cols: number; rows: number }) => ({})),
    whenMirrorReady: vi.fn((_ptyId: string) => Promise.resolve()),
    disposeMirror: vi.fn((_ptyId: string) => {}),
    getMirror: vi.fn((_ptyId: string) => null),
    /** Exit and first-output handlers of every PTY the store listened to. */
    exits: new Map<string, (payload: { code: number | null; reason: string }) => void>(),
    outputs: new Map<string, () => void>(),
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.confirm }))

vi.mock('../lib/tauri', () => ({
  spawnPty: mocks.spawnPty,
  killPty: mocks.killPty,
  writePty: mocks.writePty,
  listenPtyExit: vi.fn(
    (id: string, handler: (payload: { code: number | null; reason: string }) => void) => {
      mocks.exits.set(id, handler)
      return Promise.resolve(() => {})
    },
  ),
  listenPtyData: vi.fn((id: string, handler: () => void) => {
    mocks.outputs.set(id, handler)
    return Promise.resolve(() => {})
  }),
  listenPtyActivity: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../lib/tauri/orchestra', () => ({
  orchestraReset: mocks.orchestraReset,
  orchestraEnd: mocks.orchestraEnd,
  orchestraPrepare: mocks.orchestraPrepare,
  listenOrchestra: mocks.listenOrchestra,
}))

vi.mock('../lib/terminalMirror', () => ({
  ensureMirror: mocks.ensureMirror,
  whenMirrorReady: mocks.whenMirrorReady,
  disposeMirror: mocks.disposeMirror,
  getMirror: mocks.getMirror,
}))

import { retiredPtys } from '../components/Orchestra/retiredTerminals'
import {
  DEFAULT_SPAWN_SIZE,
  resetTerminalGeometryCache,
  TERMINAL_SIZE_KEY,
} from '../components/Orchestra/terminalGeometry'
import {
  applyReport,
  confirmStop,
  type OrchestraAgent,
  orchestratorRestartPrompt,
  reopenAgent,
  shownSessionIds,
  taskFromInput,
  useOrchestraStore,
} from './orchestraStore'

const store = () => useOrchestraStore.getState()
const emit = (event: OrchestraEvent) => mocks.bus.handler?.(event)
const session = (id: string) => store().sessions[id]
const agentIn = (sessionId: string, agentId: string) =>
  session(sessionId).agents.find((a) => a.id === agentId)!

async function startSession(cwd = 'C:/repo', goal = 'goal'): Promise<string> {
  const id = await store().start(cwd, goal, true)
  expect(id).toMatch(/^o[a-z0-9]{7}$/)
  return id!
}

/** A first hook: the agent's terminal runs and its prompt takes input. */
function wake(sessionId: string, id: string) {
  emit({
    kind: 'hook',
    session: sessionId,
    at: 1,
    agent_id: id,
    hook: { hook_event_name: 'SessionStart' },
  })
}

async function spawnWorker(sessionId: string, id: string, task = `task of ${id}`) {
  emit({ kind: 'spawn', session: sessionId, at: 1, id, area: 'api', task, after: [] })
  await vi.waitFor(() => expect(agentIn(sessionId, id).ptyId).not.toBeNull())
  wake(sessionId, id)
}

/** The process behind an agent's terminal ends. */
function exitAgent(sessionId: string, id: string, code: number | null = 1, reason = 'exited') {
  const ptyId = agentIn(sessionId, id).ptyId!
  mocks.exits.get(ptyId)?.({ code, reason })
}

/** Writes a test made to `ptyId`, in order. */
const writesTo = (ptyId: string | null) =>
  mocks.writePty.mock.calls.filter(([id]) => id === ptyId).map(([, data]) => data)

function doneAgent(): OrchestraAgent {
  return {
    id: 'claude-1',
    area: 'api',
    task: 'first task',
    after: [],
    ptyId: 'pty-1',
    state: 'done',
    progress: 100,
    note: 'shipped',
    lines: [],
    files: ['a.ts'],
    toolCalls: 7,
    startedAt: 10,
    finishedAt: 20,
    history: [],
    account: null,
    model: null,
    effort: null,
  }
}

describe('per-task status helpers', () => {
  it('reopens a done agent and archives the finished task', () => {
    const patch = reopenAgent(doneAgent(), 30, 'second task')
    expect(patch).toMatchObject({
      state: 'thinking',
      progress: 0,
      note: '',
      task: 'second task',
      startedAt: 30,
      finishedAt: null,
      files: [],
      toolCalls: 0,
    })
    expect(patch.history).toEqual([
      { task: 'first task', note: 'shipped', progress: 100, startedAt: 10, finishedAt: 20 },
    ])
  })

  it('leaves a working agent alone', () => {
    expect(reopenAgent({ ...doneAgent(), state: 'editing' }, 30, 'x')).toEqual({})
  })

  it('treats a non-final report after done as a new task', () => {
    const patch = applyReport(doneAgent(), {
      kind: 'report',
      session: 'oabc1234',
      at: 40,
      agent_id: 'claude-1',
      progress: 10,
      status: 'editing',
      note: 'next',
    })
    expect(patch).toMatchObject({ state: 'editing', progress: 10, note: 'next', startedAt: 40 })
    expect(patch.history).toHaveLength(1)
  })

  it('finishes on done or 100 percent', () => {
    const working = { ...doneAgent(), state: 'editing' as const, progress: 50 }
    const patch = applyReport(working, {
      kind: 'report',
      session: 'oabc1234',
      at: 50,
      agent_id: 'claude-1',
      progress: 100,
      status: null,
      note: '',
    })
    expect(patch).toMatchObject({ state: 'done', progress: 100, finishedAt: 50, note: 'shipped' })
  })

  it('derives the task from relayed input but not from completion notices', () => {
    expect(taskFromInput('[orchestra · from orchestrator] fix\nthe bug')).toBe('fix the bug')
    expect(taskFromInput('[orchestra · from claude-2] finished: all good')).toBeUndefined()
    expect(taskFromInput('turn finished: ok')).toBeUndefined()
    expect(taskFromInput('   ')).toBeUndefined()
  })
})

describe('orchestra store lifecycle', () => {
  let sid = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    sid = await startSession()
    await spawnWorker(sid, 'claude-1', 'task one')
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('keeps spawn settings on the agent', () => {
    emit({
      kind: 'spawn',
      session: sid,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 't',
      after: [],
      account: 'work',
      model: 'opus',
      effort: null,
    })
    expect(agentIn(sid, 'claude-2')).toMatchObject({ account: 'work', model: 'opus', effort: null })
  })

  it('goes back to thinking when a new prompt arrives after done', () => {
    emit({
      kind: 'report',
      session: sid,
      at: 5,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'ok',
    })
    expect(agentIn(sid, 'claude-1').state).toBe('done')

    emit({
      kind: 'hook',
      session: sid,
      at: 6,
      agent_id: 'claude-1',
      hook: {
        hook_event_name: 'UserPromptSubmit',
        prompt: '[orchestra · from orchestrator] task two',
      },
    })
    const a = agentIn(sid, 'claude-1')
    expect(a).toMatchObject({ state: 'thinking', progress: 0, task: 'task two', finishedAt: null })
    expect(a.history.map((h) => h.task)).toEqual(['task one'])
  })

  it('reopens on orch send and on direct input', async () => {
    emit({
      kind: 'report',
      session: sid,
      at: 5,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: '',
    })
    emit({
      kind: 'message',
      session: sid,
      at: 6,
      from: 'orchestrator',
      to: 'claude-1',
      text: 'task two',
    })
    await vi.waitFor(() => expect(agentIn(sid, 'claude-1').state).toBe('thinking'))
    expect(agentIn(sid, 'claude-1').task).toBe('task two')

    emit({
      kind: 'report',
      session: sid,
      at: 7,
      agent_id: 'claude-1',
      progress: null,
      status: 'done',
      note: '',
    })
    store().reopen(sid, 'claude-1', 'typed in pty')
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'thinking', task: 'typed in pty' })
    expect(agentIn(sid, 'claude-1').history).toHaveLength(2)
  })

  it('does not reopen on tool use or Stop after done', () => {
    emit({
      kind: 'report',
      session: sid,
      at: 5,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: '',
    })
    emit({
      kind: 'hook',
      session: sid,
      at: 6,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'PreToolUse', tool_name: 'Bash', target: 'git status' },
    })
    emit({
      kind: 'hook',
      session: sid,
      at: 7,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'Stop' },
    })
    expect(agentIn(sid, 'claude-1').state).toBe('done')
  })

  it('stop survives failing cleanup and ignores late events', async () => {
    mocks.unlisten.mockImplementationOnce(() => {
      throw new Error('already unlistened')
    })
    mocks.killPty.mockImplementationOnce(() => Promise.reject(new Error('HTTP 500')))
    mocks.orchestraEnd.mockImplementationOnce(() => Promise.reject(new Error('gone')))
    const late = mocks.bus.handler
    await expect(store().stop(sid)).resolves.toBeUndefined()
    expect(store()).toMatchObject({ sessions: {}, order: [], activeId: null })

    late?.({ kind: 'spawn', session: sid, at: 9, id: 'claude-9', area: 'x', task: 'y', after: [] })
    expect(store().sessions).toEqual({})
  })
})

describe('several sessions at once', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('gives each session its own claude-1 without stopping the others', async () => {
    const a = await startSession('C:/repo-a', 'goal a')
    const b = await startSession('C:/repo-b', 'goal b')
    expect(a).not.toBe(b)
    expect(store()).toMatchObject({ order: [a, b], activeId: b })
    expect(session(a).agents.map((x) => x.id)).toEqual(['orchestrator'])
    expect(mocks.orchestraReset.mock.calls).toEqual([[a], [b]])
    expect(mocks.listenOrchestra).toHaveBeenCalledTimes(1)

    await spawnWorker(a, 'claude-1', 'api for a')
    await spawnWorker(b, 'claude-1', 'ui for b')
    expect(agentIn(a, 'claude-1').task).toBe('api for a')
    expect(agentIn(b, 'claude-1').task).toBe('ui for b')
    // The third argument is the session folder, which the backend checks still exists.
    expect(mocks.orchestraPrepare).toHaveBeenCalledWith(a, 'claude-1', 'C:/repo-a')
    expect(mocks.orchestraPrepare).toHaveBeenCalledWith(b, 'claude-1', 'C:/repo-b')

    const envOf = (ptyId: string | null) =>
      mocks.spawnPty.mock.calls.find(([args]) => args.id === ptyId)?.[0].env
    expect(agentIn(a, 'claude-1').ptyId).toContain(`orchestra-${a}-claude-1-`)
    expect(envOf(agentIn(a, 'claude-1').ptyId)).toMatchObject({
      ALETHE_ORCHESTRA_SESSION: a,
      ALETHE_ORCHESTRA_AGENT_ID: 'claude-1',
    })
    expect(envOf(agentIn(b, 'claude-1').ptyId)).toMatchObject({ ALETHE_ORCHESTRA_SESSION: b })
  })

  it('routes events by session and drops unknown sessions', async () => {
    const a = await startSession()
    const b = await startSession()
    await spawnWorker(a, 'claude-1')
    await spawnWorker(b, 'claude-1')

    emit({
      kind: 'report',
      session: a,
      at: 5,
      agent_id: 'claude-1',
      progress: 40,
      status: 'editing',
      note: 'half',
    })
    expect(agentIn(a, 'claude-1')).toMatchObject({ progress: 40, state: 'editing', note: 'half' })
    expect(agentIn(b, 'claude-1')).toMatchObject({ progress: 0, note: '' })

    const before = store().sessions
    emit({
      kind: 'report',
      session: 'default',
      at: 6,
      agent_id: 'claude-1',
      progress: 90,
      status: 'testing',
      note: 'legacy',
    })
    emit({
      kind: 'spawn',
      session: 'ogone1234',
      at: 7,
      id: 'claude-2',
      area: 'x',
      task: 'y',
      after: [],
    })
    expect(store().sessions).toBe(before)
  })

  it('keeps send all inside its session', async () => {
    const a = await startSession()
    const b = await startSession()
    await spawnWorker(a, 'claude-1')
    await spawnWorker(a, 'claude-2')
    await spawnWorker(b, 'claude-1')
    mocks.writePty.mockClear()

    emit({ kind: 'message', session: a, at: 8, from: 'claude-1', to: 'all', text: 'heads up' })
    // A bracketed paste is four writes: open, text, close and the Enter that submits it.
    await vi.waitFor(() => expect(mocks.writePty).toHaveBeenCalledTimes(4))
    const targets = new Set(mocks.writePty.mock.calls.map(([ptyId]) => ptyId))
    expect([...targets]).toEqual([agentIn(a, 'claude-2').ptyId])
    expect(session(a).messages.at(-1)).toMatchObject({ from: 'claude-1', to: 'all' })
    expect(session(b).messages.some((m) => m.text === 'heads up')).toBe(false)
  })

  it('keeps two interleaved event streams apart, before and after one session stops', async () => {
    const a = await startSession('C:/repo-a', 'goal a')
    const b = await startSession('C:/repo-b', 'goal b')
    // Both orchestrators are up: notices to them go straight in.
    for (const id of [a, b]) {
      await vi.waitFor(() => expect(agentIn(id, 'orchestrator').ptyId).not.toBeNull())
      wake(id, 'orchestrator')
    }
    await spawnWorker(a, 'claude-1', 'task a1')
    await spawnWorker(b, 'claude-1', 'task b1')
    // b's claude-2 waits for b's own claude-1, never for a's.
    emit({
      kind: 'spawn',
      session: b,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 'task b2',
      after: ['claude-1'],
    })
    expect(agentIn(b, 'claude-2').state).toBe('waiting')
    mocks.writePty.mockClear()

    const ptyOf = (sessionId: string, agentId: string) => agentIn(sessionId, agentId).ptyId
    const relays = () =>
      mocks.writePty.mock.calls
        .filter(([, data]) => data.startsWith('[orchestra · from'))
        .map(([ptyId, data]) => `${ptyId} ${data}`)
        .sort()

    emit({
      kind: 'hook',
      session: a,
      at: 3,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'PreToolUse', tool_name: 'Edit', target: 'src/a.ts' },
    })
    emit({
      kind: 'hook',
      session: b,
      at: 4,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'PreToolUse', tool_name: 'Read', target: 'src/b.ts' },
    })
    emit({
      kind: 'report',
      session: b,
      at: 5,
      agent_id: 'claude-1',
      progress: 30,
      status: 'testing',
      note: 'b note',
    })
    emit({
      kind: 'message',
      session: a,
      at: 6,
      from: 'orchestrator',
      to: 'claude-1',
      text: 'a only',
    })
    emit({
      kind: 'hook',
      session: b,
      at: 7,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'Notification', message: 'needs input' },
    })
    emit({
      kind: 'report',
      session: a,
      at: 8,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'a shipped',
    })

    expect(agentIn(a, 'claude-1')).toMatchObject({
      state: 'done',
      progress: 100,
      files: ['src/a.ts'],
      toolCalls: 1,
    })
    expect(agentIn(b, 'claude-1')).toMatchObject({
      state: 'blocked',
      progress: 30,
      note: 'b note',
      files: [],
      toolCalls: 1,
    })
    // a's worker finishing does not release b's waiting worker.
    expect(agentIn(b, 'claude-2')).toMatchObject({ state: 'waiting', ptyId: null })

    const linesOf = (sessionId: string) => agentIn(sessionId, 'claude-1').lines.map((l) => l.text)
    expect(linesOf(a)).toEqual(['> task a1', '● Edit(src/a.ts)', '◆ 100% a shipped'])
    expect(linesOf(b)).toEqual(['> task b1', '● Read(src/b.ts)', '◆ 30% b note', '! needs input'])

    const kindsOf = (sessionId: string) =>
      session(sessionId)
        .segments.filter((s) => s.agentId === 'claude-1')
        .map((s) => s.kind)
    expect(kindsOf(a)).toEqual(['thinking', 'editing', 'idle'])
    expect(kindsOf(b)).toEqual(['thinking', 'reading', 'blocked'])

    const busOf = (sessionId: string) =>
      session(sessionId).messages.map((m) => `${m.from}>${m.to} ${m.text}`)
    expect(busOf(a)).toEqual([
      'orchestrator>claude-1 task a1',
      'orchestrator>claude-1 a only',
      'claude-1>orchestrator done · a shipped',
    ])
    expect(busOf(b)).toEqual(['orchestrator>claude-1 task b1', 'orchestrator>claude-2 task b2'])

    // Relays reach a's terminals only: the message to its worker, the completion to its orchestrator.
    await vi.waitFor(() => expect(relays()).toHaveLength(2))
    expect(relays()).toEqual(
      [
        `${ptyOf(a, 'claude-1')} [orchestra · from orchestrator] a only`,
        `${ptyOf(a, 'orchestrator')} [orchestra · from claude-1] finished: a shipped`,
      ].sort(),
    )

    // Stopping a kills only a's terminals and ends only a; a's late events are dropped.
    const ptysOfA = session(a).agents.map((x) => x.ptyId)
    mocks.killPty.mockClear()
    mocks.writePty.mockClear()
    await store().stop(a)
    expect(mocks.killPty.mock.calls.map(([id]) => id).sort()).toEqual([...ptysOfA].sort())
    expect(mocks.orchestraEnd.mock.calls).toEqual([[a]])
    emit({
      kind: 'report',
      session: a,
      at: 9,
      agent_id: 'claude-1',
      progress: 50,
      status: 'editing',
      note: 'late',
    })
    emit({ kind: 'spawn', session: a, at: 9, id: 'claude-3', area: 'x', task: 'late', after: [] })
    expect(store().sessions[a]).toBeUndefined()
    expect(store().order).toEqual([b])

    // b keeps running: its claude-1 finishing releases its claude-2, launched in session b.
    emit({
      kind: 'report',
      session: b,
      at: 10,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'b shipped',
    })
    await vi.waitFor(() => expect(ptyOf(b, 'claude-2')).not.toBeNull())
    expect(mocks.orchestraPrepare).toHaveBeenLastCalledWith(b, 'claude-2', 'C:/repo-b')
    const spawned = mocks.spawnPty.mock.calls.find(([args]) => args.id === ptyOf(b, 'claude-2'))
    expect(spawned?.[0].env).toMatchObject({
      ALETHE_ORCHESTRA_SESSION: b,
      ALETHE_ORCHESTRA_AGENT_ID: 'claude-2',
    })
    expect(ptyOf(b, 'claude-2')).toContain(`orchestra-${b}-claude-2-`)
    await vi.waitFor(() =>
      expect(relays()).toEqual([
        `${ptyOf(b, 'orchestrator')} [orchestra · from claude-1] finished: b shipped`,
      ]),
    )
  })

  it('stopping one session keeps the others and activates a neighbour', async () => {
    const a = await startSession()
    const b = await startSession()
    const c = await startSession()
    await spawnWorker(b, 'claude-1')
    store().setActive(b)
    const ptysOfB = session(b).agents.map((x) => x.ptyId)
    mocks.killPty.mockClear()

    await store().stop(b)
    expect(store()).toMatchObject({ order: [a, c], activeId: c })
    expect(mocks.killPty.mock.calls.map(([id]) => id).sort()).toEqual([...ptysOfB].sort())
    expect(mocks.orchestraEnd).toHaveBeenCalledWith(b)
    expect(mocks.unlisten).not.toHaveBeenCalled()

    await spawnWorker(a, 'claude-1')
    expect(agentIn(a, 'claude-1').state).toBe('thinking')

    await store().stop(c)
    expect(store().activeId).toBe(a)
    await store().stop(a)
    expect(store()).toMatchObject({ sessions: {}, order: [], activeId: null })
    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
  })

  it('stopAll also ends a session that is still starting', async () => {
    let release: (() => void) | undefined
    mocks.orchestraReset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const pending = store().start('C:/repo', 'goal', true)
    await store().stopAll()
    release?.()
    await expect(pending).resolves.toBeNull()
    expect(store().order).toEqual([])
    expect(mocks.orchestraEnd).toHaveBeenCalledTimes(1)
    expect(mocks.listenOrchestra).not.toHaveBeenCalled()
    expect(mocks.spawnPty).not.toHaveBeenCalled()
  })

  it('reports a failed start without touching the running sessions', async () => {
    const a = await startSession()
    mocks.orchestraReset.mockRejectedValueOnce(new Error('backend down'))
    await expect(store().start('C:/x', 'g', false)).resolves.toBeNull()
    expect(store().error).toContain('backend down')
    expect(store()).toMatchObject({ order: [a], activeId: a })
  })

  it('keeps the view mode per session and remembers the last one', async () => {
    const a = await startSession()
    const b = await startSession()
    store().setMode(b, 'flow')
    store().setMode(a, 'hive')
    expect(session(a).mode).toBe('hive')
    expect(session(b).mode).toBe('flow')
    expect(store().lastMode).toBe('hive')
    expect(localStorage.getItem('orchestra.viewMode')).toBe('hive')
    const c = await startSession()
    expect(session(c).mode).toBe('hive')
  })
})

describe('side-by-side view', () => {
  const shown = () => shownSessionIds(store())

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('pairs the active session with the previous one, in tab order', async () => {
    const a = await startSession()
    const b = await startSession()
    expect(shown()).toEqual([b])
    store().toggleSplit()
    expect(shown()).toEqual([a, b])
    expect(store().activeId).toBe(b)
    store().toggleSplit()
    expect(shown()).toEqual([b])
  })

  it('shows a clicked tab in the focused pane and moves the focus to a shown one', async () => {
    const a = await startSession()
    const b = await startSession()
    const c = await startSession()
    store().toggleSplit()
    expect(shown()).toEqual([b, c])
    store().setActive(a)
    expect(shown()).toEqual([b, a])
    // The other pane's tab only takes the focus: no session ever fills both panes.
    store().setActive(b)
    expect(shown()).toEqual([b, a])
    expect(store()).toMatchObject({ activeId: b, splitId: a })
  })

  it('lets the other pane take over when one of the pair stops', async () => {
    const a = await startSession()
    const b = await startSession()
    const c = await startSession()
    store().toggleSplit()
    await store().stop(c)
    expect(shown()).toEqual([b])
    expect(store()).toMatchObject({ activeId: b, splitId: null })

    store().setActive(a)
    store().toggleSplit()
    expect(shown()).toEqual([a, b])
    await store().stop(b)
    expect(shown()).toEqual([a])
    expect(store().splitId).toBeNull()
  })

  it('keeps the pair behind the start screen and puts a new session in the focused pane', async () => {
    const a = await startSession()
    const b = await startSession()
    store().toggleSplit()
    store().setActive(null)
    expect(shown()).toEqual([])
    expect(store().recent[0]).toBe(b)
    store().setActive(b)
    expect(shown()).toEqual([a, b])

    store().setActive(null)
    const c = await startSession()
    expect(shown()).toEqual([a, c])
    expect(store().recent).toEqual([c, b, a])
  })

  it('stays on the project when its focused orchestration stops', async () => {
    const a = (await store().start('C:/one', 'first', true, 'p1'))!
    await store().start('C:/two', 'other project', true, 'p2')
    const c = (await store().start('C:/one', 'second', true, 'p1'))!
    expect(store().activeId).toBe(c)
    // Not the tab-order neighbour (p2): the project's most recent other orchestration.
    await store().stop(c)
    expect(store().activeId).toBe(a)
    // The project has none left: its start screen, while p2 keeps running in its tab.
    await store().stop(a)
    expect(store().activeId).toBeNull()
    expect(store().order).toHaveLength(1)
  })
})

describe('terminal mirror and spawn geometry', () => {
  const spawnOf = (ptyId: string | null) =>
    mocks.spawnPty.mock.calls.find(([args]) => args.id === ptyId)?.[0]
  const mirrorIds = () => mocks.ensureMirror.mock.calls.map(([ptyId]) => ptyId)

  function deferReady(): () => void {
    let ready: () => void = () => {}
    mocks.whenMirrorReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        }),
    )
    return () => ready()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  afterEach(async () => {
    await store().stopAll()
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  it('creates the mirror and waits until it listens before spawning the PTY', async () => {
    const ready = deferReady()
    const pending = store().start('C:/repo', 'goal', true)
    await vi.waitFor(() => expect(mocks.whenMirrorReady).toHaveBeenCalledTimes(1))
    const [ptyId] = mirrorIds()
    expect(mocks.whenMirrorReady).toHaveBeenCalledWith(ptyId)
    expect(mocks.spawnPty).not.toHaveBeenCalled()

    ready()
    const sid = await pending
    expect(spawnOf(ptyId)).toBeDefined()
    expect(mocks.ensureMirror.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawnPty.mock.invocationCallOrder[0],
    )
    expect(agentIn(sid!, 'orchestrator').ptyId).toBe(ptyId)
  })

  it('spawns at the size a view last fitted the role to, else 100x30', async () => {
    const a = await startSession()
    const first = spawnOf(agentIn(a, 'orchestrator').ptyId)
    expect(first).toMatchObject(DEFAULT_SPAWN_SIZE)
    expect(mocks.ensureMirror).toHaveBeenCalledWith(first?.id, { cols: 100, rows: 30 })

    // What a worker cell or the drawer measured, as recorded by the views.
    localStorage.setItem(TERMINAL_SIZE_KEY, JSON.stringify({ worker: { cols: 88, rows: 26 } }))
    resetTerminalGeometryCache()
    await spawnWorker(a, 'claude-1')
    const worker = spawnOf(agentIn(a, 'claude-1').ptyId)
    expect(worker).toMatchObject({ cols: 88, rows: 26 })
    expect(mocks.ensureMirror).toHaveBeenLastCalledWith(worker?.id, { cols: 88, rows: 26 })

    // An orchestrator borrows the worker size until an orchestrator view has measured one.
    const b = await startSession()
    expect(spawnOf(agentIn(b, 'orchestrator').ptyId)).toMatchObject({ cols: 88, rows: 26 })
    localStorage.setItem(
      TERMINAL_SIZE_KEY,
      JSON.stringify({ worker: { cols: 88, rows: 26 }, orchestrator: { cols: 150, rows: 44 } }),
    )
    resetTerminalGeometryCache()
    const c = await startSession()
    expect(spawnOf(agentIn(c, 'orchestrator').ptyId)).toMatchObject({ cols: 150, rows: 44 })
  })

  it('disposes the mirrors of the stopped session only, after killing its PTYs', async () => {
    const a = await startSession()
    const b = await startSession()
    await spawnWorker(a, 'claude-1')
    await spawnWorker(b, 'claude-1')
    const ptysOfA = session(a).agents.map((x) => x.ptyId)
    const ptysOfB = session(b).agents.map((x) => x.ptyId)

    await store().stop(a)
    expect(mocks.disposeMirror.mock.calls.map(([id]) => id).sort()).toEqual([...ptysOfA].sort())
    expect(Math.min(...mocks.disposeMirror.mock.invocationCallOrder)).toBeGreaterThan(
      Math.max(...mocks.killPty.mock.invocationCallOrder),
    )

    mocks.disposeMirror.mockClear()
    await store().stop(b)
    expect(mocks.disposeMirror.mock.calls.map(([id]) => id).sort()).toEqual([...ptysOfB].sort())
  })

  it('frees the mirror of a spawn that failed', async () => {
    mocks.spawnPty.mockRejectedValueOnce(new Error('spawn failed'))
    const a = await startSession()
    const [failed] = mirrorIds()
    expect(mocks.disposeMirror).toHaveBeenCalledWith(failed)
    expect(agentIn(a, 'orchestrator')).toMatchObject({ state: 'exited', ptyId: null })
  })

  it('never spawns a worker whose session stopped while its mirror got ready', async () => {
    const a = await startSession()
    const ready = deferReady()
    emit({ kind: 'spawn', session: a, at: 1, id: 'claude-1', area: 'api', task: 't', after: [] })
    await vi.waitFor(() => expect(mocks.whenMirrorReady).toHaveBeenCalledTimes(2))
    const pending = mirrorIds()[1]

    await store().stop(a)
    ready()
    await vi.waitFor(() => expect(mocks.disposeMirror).toHaveBeenCalledWith(pending))
    expect(spawnOf(pending)).toBeUndefined()
  })

  it('does not wait forever for a mirror that never listens', async () => {
    vi.useFakeTimers()
    try {
      mocks.whenMirrorReady.mockImplementationOnce(() => new Promise<void>(() => {}))
      const pending = store().start('C:/repo', 'goal', true)
      await vi.advanceTimersByTimeAsync(1500)
      await expect(pending).resolves.toMatch(/^o[a-z0-9]{7}$/)
      expect(mocks.spawnPty).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('an agent that goes down is never silent (A1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('marks a worker that exits without done as failed and tells the bus and the orchestrator', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1', 'run the tests')
    emit({
      kind: 'report',
      session: sid,
      at: 2,
      agent_id: 'claude-1',
      progress: 35,
      status: 'testing',
      note: 'running cargo test',
    })
    mocks.writePty.mockClear()

    exitAgent(sid, 'claude-1', 1)
    expect(agentIn(sid, 'claude-1')).toMatchObject({
      state: 'exited',
      exitCode: 1,
      exitReason: 'exited',
      progress: 35,
    })
    expect(session(sid).messages.at(-1)).toMatchObject({
      from: 'claude-1',
      to: 'orchestrator',
      text: 'failed · exited with code 1 without reporting done · last note: running cargo test',
    })
    const orchestratorPty = agentIn(sid, 'orchestrator').ptyId
    await vi.waitFor(() =>
      expect(writesTo(orchestratorPty)).toContain(
        '[orchestra · from claude-1] failed: claude-1 exited with code 1 without reporting done; last note: running cargo test',
      ),
    )
  })

  it('keeps a worker that exits after done as done, without any alarm', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    emit({
      kind: 'report',
      session: sid,
      at: 2,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'ok',
    })
    const lines = session(sid).messages.length
    exitAgent(sid, 'claude-1', 0)
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'done', exitCode: 0 })
    expect(session(sid).messages).toHaveLength(lines)
  })

  it('names the agent whose launch failed in the session error', async () => {
    mocks.spawnPty.mockRejectedValueOnce(new Error('claude not found'))
    const sid = await startSession()
    expect(agentIn(sid, 'orchestrator')).toMatchObject({
      state: 'exited',
      exitReason: 'launch-failed',
      note: 'Error: claude not found',
    })
    expect(session(sid).error).toBe('orchestrator: Error: claude not found')
    store().dismissError(sid)
    expect(session(sid).error).toBeNull()
  })

  it('holds a dependent of a failed worker with the reason, then starts it on demand', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    emit({
      kind: 'spawn',
      session: sid,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 'needs claude-1',
      after: ['claude-1'],
    })
    expect(agentIn(sid, 'claude-2').state).toBe('waiting')

    exitAgent(sid, 'claude-1', 3)
    expect(agentIn(sid, 'claude-2')).toMatchObject({
      state: 'blocked',
      ptyId: null,
      blocked: { reason: 'dependency', text: 'claude-1' },
    })

    store().startNow(sid, 'claude-2', 'Started claude-2 without claude-1.')
    await vi.waitFor(() => expect(agentIn(sid, 'claude-2').ptyId).not.toBeNull())
    expect(agentIn(sid, 'claude-2')).toMatchObject({ state: 'starting', blocked: null })
    expect(session(sid).messages.at(-1)).toMatchObject({
      from: 'you',
      to: 'orchestrator',
      text: 'Started claude-2 without claude-1.',
    })
  })

  it('cancels a held worker: it stays in the session as cancelled and its dependents are held', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    emit({
      kind: 'spawn',
      session: sid,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 't2',
      after: ['claude-1'],
    })
    emit({
      kind: 'spawn',
      session: sid,
      at: 3,
      id: 'claude-3',
      area: 'qa',
      task: 't3',
      after: ['claude-2'],
    })
    emit({
      kind: 'message',
      session: sid,
      at: 4,
      from: 'orchestrator',
      to: 'claude-2',
      text: 'later',
    })
    exitAgent(sid, 'claude-1')

    store().cancelWaiting(sid, 'claude-2', 'Cancelled claude-2.')
    // Kept, as cancelled: never launched, frozen where it was cancelled.
    expect(agentIn(sid, 'claude-2')).toMatchObject({
      state: 'idle',
      exitReason: 'cancelled',
      ptyId: null,
      blocked: null,
    })
    expect(agentIn(sid, 'claude-2').finishedAt).not.toBeNull()
    expect(agentIn(sid, 'claude-3')).toMatchObject({
      state: 'blocked',
      blocked: { reason: 'dependency', text: 'claude-2' },
    })
    expect(session(sid).messages.find((m) => m.text === 'later')).toMatchObject({
      delivery: 'failed',
      failure: 'cancelled',
    })
    // Stopping the session later does not turn it into "stopped".
    await store().stopAgents(sid)
    expect(agentIn(sid, 'claude-2').exitReason).toBe('cancelled')
  })

  it('releases a dependent normally once its dependency is done', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    emit({
      kind: 'spawn',
      session: sid,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 't2',
      after: ['claude-1'],
    })
    emit({
      kind: 'report',
      session: sid,
      at: 3,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: '',
    })
    await vi.waitFor(() => expect(agentIn(sid, 'claude-2').ptyId).not.toBeNull())
    expect(agentIn(sid, 'claude-2').blocked).toBeNull()
  })
})

describe('nothing typed gets lost (A4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('confirms a message when the target submits it as a prompt', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const sent = await store().send(sid, 'claude-1', 'run the tests again')
    expect(sent.delivery).toBe('pending')
    const line = () => session(sid).messages.find((m) => m.id === sent.id)
    expect(line()).toMatchObject({ delivery: 'pending' })

    // Typing something else in the terminal confirms nothing.
    emit({
      kind: 'hook',
      session: sid,
      at: 5,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'UserPromptSubmit', prompt: 'something I typed' },
    })
    expect(line()?.delivery).toBe('pending')
    emit({
      kind: 'hook',
      session: sid,
      at: 6,
      agent_id: 'claude-1',
      hook: { hook_event_name: 'UserPromptSubmit', prompt: 'run the tests again' },
    })
    expect(line()?.delivery).toBe('delivered')
  })

  it('queues a message for a worker still waiting and delivers it once it runs', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    emit({
      kind: 'spawn',
      session: sid,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 't2',
      after: ['claude-1'],
    })
    const sent = await store().send(sid, 'claude-2', 'start with the header')
    expect(sent.delivery).toBe('queued')
    expect(mocks.writePty).not.toHaveBeenCalledWith(expect.anything(), 'start with the header')

    emit({
      kind: 'report',
      session: sid,
      at: 3,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: '',
    })
    await vi.waitFor(() => expect(agentIn(sid, 'claude-2').ptyId).not.toBeNull())
    wake(sid, 'claude-2')
    await vi.waitFor(() =>
      expect(writesTo(agentIn(sid, 'claude-2').ptyId)).toContain('start with the header'),
    )
    expect(session(sid).messages.find((m) => m.id === sent.id)?.delivery).toBe('pending')
  })

  it('fails a message to an exited or unknown agent and tells the agent that sent it', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    await spawnWorker(sid, 'claude-2')
    exitAgent(sid, 'claude-2')
    mocks.writePty.mockClear()

    emit({ kind: 'message', session: sid, at: 5, from: 'claude-1', to: 'claude-2', text: 'ping' })
    emit({ kind: 'message', session: sid, at: 6, from: 'claude-1', to: 'claude-9', text: 'pong' })
    const byText = (text: string) => session(sid).messages.find((m) => m.text === text)
    expect(byText('ping')).toMatchObject({ delivery: 'failed', failure: 'exited' })
    expect(byText('pong')).toMatchObject({ delivery: 'failed', failure: 'unknown' })
    const sender = agentIn(sid, 'claude-1').ptyId
    await vi.waitFor(() => expect(writesTo(sender)).toHaveLength(8))
    expect(writesTo(sender).filter((data) => data.startsWith('[orchestra'))).toEqual([
      '[orchestra · from orchestra] not delivered: message to claude-2, its terminal has exited',
      '[orchestra · from orchestra] not delivered: message to claude-9, no such agent in this orchestration',
    ])
  })

  it('closes the paste when a write fails halfway, never submits half a message, and resends', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId
    mocks.writePty.mockClear()
    mocks.writePty.mockImplementationOnce(() => Promise.resolve())
    mocks.writePty.mockImplementationOnce(() => Promise.reject(new Error('pipe closed')))

    const sent = await store().send(sid, 'claude-1', 'long message')
    expect(writesTo(pty)).toEqual(['\x1b[200~', 'long message', '\x1b[201~'])
    expect(session(sid).messages.find((m) => m.id === sent.id)).toMatchObject({
      delivery: 'failed',
      failure: 'write',
    })

    mocks.writePty.mockClear()
    await store().resend(sid, sent.id!)
    expect(writesTo(pty)).toEqual(['\x1b[200~', 'long message', '\x1b[201~', '\r'])
    expect(session(sid).messages.filter((m) => m.text === 'long message')).toHaveLength(1)
    expect(session(sid).messages.find((m) => m.id === sent.id)?.delivery).toBe('pending')
  })

  it('strips control characters and never interleaves two pastes into one terminal', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId
    mocks.writePty.mockClear()
    await Promise.all([
      store().send(sid, 'claude-1', 'first\x1b[201~\x07 one'),
      store().send(sid, 'claude-1', 'second'),
    ])
    expect(writesTo(pty)).toEqual([
      '\x1b[200~',
      'first[201~ one',
      '\x1b[201~',
      '\r',
      '\x1b[200~',
      'second',
      '\x1b[201~',
      '\r',
    ])
  })
})

describe('honest states (A9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await store().stopAll()
  })

  const hook = (sid: string, id: string, h: Record<string, string>) =>
    emit({ kind: 'hook', session: sid, at: 9, agent_id: id, hook: h })

  it('keeps a new agent starting until its first output, then thinking', async () => {
    const sid = await startSession()
    emit({ kind: 'spawn', session: sid, at: 1, id: 'claude-1', area: 'api', task: 't', after: [] })
    await vi.waitFor(() => expect(agentIn(sid, 'claude-1').ptyId).not.toBeNull())
    expect(agentIn(sid, 'claude-1').state).toBe('starting')
    mocks.outputs.get(agentIn(sid, 'claude-1').ptyId!)?.()
    expect(agentIn(sid, 'claude-1').state).toBe('thinking')
  })

  it('records why an agent is blocked and clears a permission once a tool runs', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    hook(sid, 'claude-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    })
    expect(agentIn(sid, 'claude-1')).toMatchObject({
      state: 'blocked',
      blocked: { reason: 'permission', text: 'Claude needs your permission to use Bash' },
    })
    hook(sid, 'claude-1', { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'thinking', blocked: null })
  })

  it('treats an idle prompt as waiting, not blocked', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    hook(sid, 'orchestrator', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    })
    expect(agentIn(sid, 'orchestrator')).toMatchObject({ state: 'idle', blocked: null })
  })

  it('keeps a reported block through tool use and the end of the turn until a new prompt', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    emit({
      kind: 'report',
      session: sid,
      at: 5,
      agent_id: 'claude-1',
      progress: 40,
      status: 'blocked',
      note: 'which database?',
    })
    expect(agentIn(sid, 'claude-1').blocked).toMatchObject({
      reason: 'report',
      text: 'which database?',
    })
    hook(sid, 'claude-1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', target: 'orch.cmd' })
    hook(sid, 'claude-1', { hook_event_name: 'Stop' })
    expect(agentIn(sid, 'claude-1').state).toBe('blocked')
    hook(sid, 'claude-1', { hook_event_name: 'UserPromptSubmit', prompt: 'use postgres' })
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'thinking', blocked: null })
  })

  it('fails a launch that shows no sign of life within 30 s', async () => {
    vi.useFakeTimers()
    const sid = (await store().start('C:/repo', 'goal', true))!
    const pty = agentIn(sid, 'orchestrator').ptyId
    expect(agentIn(sid, 'orchestrator').state).toBe('starting')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(agentIn(sid, 'orchestrator')).toMatchObject({
      state: 'exited',
      exitReason: 'launch-timeout',
    })
    expect(mocks.killPty).toHaveBeenCalledWith(pty)
  })

  it('takes the orchestrator’s first prompt as the goal of a session started without one', async () => {
    const sid = await startSession('C:/repo', '')
    hook(sid, 'orchestrator', { hook_event_name: 'UserPromptSubmit', prompt: 'ship the release' })
    expect(session(sid).goal).toBe('ship the release')
    hook(sid, 'orchestrator', { hook_event_name: 'UserPromptSubmit', prompt: 'and the notes' })
    expect(session(sid).goal).toBe('ship the release')
  })
})

describe('stopping, closing and per-agent controls (B1, B2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('stops the agents but keeps the session readable until it is closed', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    await spawnWorker(sid, 'claude-2')
    emit({
      kind: 'report',
      session: sid,
      at: 3,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'ok',
    })
    emit({
      kind: 'spawn',
      session: sid,
      at: 4,
      id: 'claude-3',
      area: 'qa',
      task: 't3',
      after: ['claude-2'],
    })
    const queued = await store().send(sid, 'claude-3', 'later')
    expect(queued.delivery).toBe('queued')
    const ptys = session(sid)
      .agents.map((a) => a.ptyId)
      .filter(Boolean)

    await store().stopAgents(sid)
    expect(mocks.killPty.mock.calls.map(([id]) => id).sort()).toEqual([...ptys].sort())
    expect(mocks.orchestraEnd).toHaveBeenCalledWith(sid)
    // Still there, read-only: nothing disposed, nothing removed.
    expect(store().order).toContain(sid)
    expect(session(sid).stoppedAt).toEqual(expect.any(Number))
    expect(mocks.disposeMirror).not.toHaveBeenCalled()
    expect(agentIn(sid, 'claude-1').state).toBe('done')
    expect(agentIn(sid, 'claude-2')).toMatchObject({ state: 'idle', exitReason: 'stopped' })
    expect(session(sid).messages.find((m) => m.id === queued.id)).toMatchObject({
      delivery: 'failed',
      failure: 'stopped',
    })
    // Late events of a stopped session change nothing.
    const before = session(sid)
    emit({
      kind: 'report',
      session: sid,
      at: 9,
      agent_id: 'claude-2',
      progress: 90,
      status: 'editing',
      note: 'late',
    })
    expect(session(sid)).toBe(before)

    await store().stop(sid)
    expect(store().sessions[sid]).toBeUndefined()
    expect(mocks.disposeMirror.mock.calls.map(([id]) => id).sort()).toEqual([...ptys].sort())
  })

  it('restarts a failed worker in a new terminal and tells the orchestrator', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1', 'build it')
    emit({
      kind: 'spawn',
      session: sid,
      at: 2,
      id: 'claude-2',
      area: 'ui',
      task: 't2',
      after: ['claude-1'],
    })
    const first = agentIn(sid, 'claude-1').ptyId
    exitAgent(sid, 'claude-1', 1)
    expect(agentIn(sid, 'claude-2').state).toBe('blocked')

    await store().restartAgent(sid, 'claude-1', { notice: 'Restarted claude-1.' })
    const second = agentIn(sid, 'claude-1').ptyId
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(agentIn(sid, 'claude-1')).toMatchObject({
      state: 'starting',
      exitCode: null,
      exitReason: null,
    })
    // The earlier terminal stays readable (until Close), listed as retired.
    expect(mocks.disposeMirror).not.toHaveBeenCalledWith(first)
    expect(retiredPtys(sid, 'claude-1')).toEqual([first])
    // Its dependent waits for it again instead of being held.
    expect(agentIn(sid, 'claude-2')).toMatchObject({ state: 'waiting', blocked: null })
    expect(session(sid).messages.at(-1)).toMatchObject({
      from: 'you',
      to: 'orchestrator',
      text: 'Restarted claude-1.',
    })
    // The old terminal ending now is not a failure of the new one.
    mocks.exits.get(first!)?.({ code: 1, reason: 'killed' })
    expect(agentIn(sid, 'claude-1').state).toBe('starting')
  })

  it('resumes a failed worker in its own conversation when Claude Code told us its id', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1', 'build it')
    emit({
      kind: 'hook',
      session: sid,
      at: 2,
      agent_id: 'claude-1',
      // A real conversation id (a UUID): anything else never reaches `claude --resume`.
      hook: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: '0b3c5d7e-1a2b-4c3d-8e9f-a0b1c2d3e4f5',
      },
    })
    exitAgent(sid, 'claude-1', 1)
    mocks.spawnPty.mockClear()

    await store().restartAgent(sid, 'claude-1', { resume: true, notice: 'Resumed claude-1.' })
    const args = mocks.spawnPty.mock.calls[0]?.[0].extraArgs ?? []
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('0b3c5d7e-1a2b-4c3d-8e9f-a0b1c2d3e4f5')

    // Without a known conversation, Resume starts the task over instead.
    exitAgent(sid, 'claude-1', 1)
    useOrchestraStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [sid]: {
          ...s.sessions[sid],
          agents: s.sessions[sid].agents.map((a) =>
            a.id === 'claude-1' ? { ...a, claudeSessionId: null } : a,
          ),
        },
      },
    }))
    mocks.spawnPty.mockClear()
    await store().restartAgent(sid, 'claude-1', { resume: true })
    expect(mocks.spawnPty.mock.calls[0]?.[0].extraArgs ?? []).not.toContain('--resume')
  })

  it('interrupts with Esc after any paste in flight, and records it on the bus', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId
    mocks.writePty.mockClear()
    await Promise.all([
      store().send(sid, 'claude-1', 'long text'),
      store().interruptAgent(sid, 'claude-1', 'Interrupted (Esc)'),
    ])
    expect(writesTo(pty)).toEqual(['\x1b[200~', 'long text', '\x1b[201~', '\r', '\x1b'])
    expect(session(sid).messages.at(-1)).toMatchObject({ from: 'you', text: 'Interrupted (Esc)' })
  })
})

describe('dialogs take keys, never pasted text (N3)', () => {
  /** What each fake terminal shows; the store reads dialogs from its mirror. */
  const screens = new Map<string, string[]>()

  beforeEach(() => {
    vi.clearAllMocks()
    screens.clear()
    mocks.getMirror.mockImplementation((ptyId: string) => {
      const lines = screens.get(ptyId)
      return (
        lines
          ? {
              baseY: 0,
              rows: lines.length,
              modes: { applicationCursorKeys: false },
              getText: () => lines.join('\n'),
            }
          : null
      ) as never
    })
  })

  afterEach(async () => {
    mocks.getMirror.mockImplementation(() => null)
    mocks.writePty.mockImplementation(() => Promise.resolve())
    await store().stopAll()
  })

  const request = (focused: number) => [
    ' Bash command',
    '   npm publish',
    '',
    ' Do you want to proceed?',
    `${focused === 1 ? ' ❯' : '  '} 1. Yes`,
    `${focused === 2 ? ' ❯' : '  '} 2. Yes, and don't ask again for npm publish commands`,
    `${focused === 3 ? ' ❯' : '  '} 3. No, and tell Claude what to do differently (esc)`,
    '',
    ' Esc to cancel',
  ]
  const prompt = ['╭────────╮', '│ >      │', '╰────────╯', '  ? for shortcuts']
  const hook = (sid: string, at: number, body: Record<string, unknown>) =>
    emit({ kind: 'hook', session: sid, at, agent_id: 'claude-1', hook: body as never })
  const permissionHook = (sid: string, at: number) =>
    hook(sid, at, {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    })
  /** The fake terminal answers like the dialog: arrows move its cursor, Enter and Esc close it. */
  function behaveLikeDialog(pty: string) {
    let cursor = 1
    mocks.writePty.mockImplementation((id: string, data: string) => {
      if (id === pty && screens.get(pty) !== prompt) {
        if (data === '\x1b[B') screens.set(pty, request(++cursor))
        else if (data === '\x1b[A') screens.set(pty, request(--cursor))
        else if (data === '\r' || data === '\x1b') screens.set(pty, prompt)
      }
      return Promise.resolve()
    })
  }

  it('holds a message while a permission request is on screen, before any hook tells', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId!
    // Claude Code reports a permission request to hooks only seconds after drawing it.
    screens.set(pty, request(1))
    mocks.writePty.mockClear()

    const sent = await store().send(sid, 'claude-1', 'also update the docs')
    expect(sent.delivery).toBe('queued')
    // Nothing reached the dialog: no text, and above all no Enter, which would pick "Yes".
    expect(writesTo(pty)).toEqual([])

    // Answered in its terminal: the tool runs, and the message goes in after it.
    screens.set(pty, prompt)
    hook(sid, 5, { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    await vi.waitFor(() =>
      expect(writesTo(pty)).toEqual(['\x1b[200~', 'also update the docs', '\x1b[201~', '\r']),
    )
    expect(session(sid).messages.find((m) => m.id === sent.id)?.delivery).toBe('pending')
  })

  it('holds messages and notices while hooks report a dialog, until Claude Code idles', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId!
    permissionHook(sid, 5)
    expect(agentIn(sid, 'claude-1')).toMatchObject({
      state: 'blocked',
      blocked: { reason: 'permission' },
    })
    mocks.writePty.mockClear()

    expect((await store().send(sid, 'claude-1', 'use pnpm')).delivery).toBe('queued')
    // Its message to nobody comes back as a notice, which waits too.
    emit({ kind: 'message', session: sid, at: 6, from: 'claude-1', to: 'claude-9', text: 'hi' })
    await Promise.resolve()
    expect(writesTo(pty)).toEqual([])

    // Claude Code sends the idle notification only with no dialog open.
    hook(sid, 7, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    })
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'idle', blocked: null })
    await vi.waitFor(() =>
      expect(writesTo(pty).filter((w) => !w.startsWith('\x1b') && w !== '\r')).toEqual([
        'use pnpm',
        '[orchestra · from orchestra] not delivered: message to claude-9, no such agent in this orchestration',
      ]),
    )
  })

  it('answers a permission request with the keys of the option picked, never text', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId!
    screens.set(pty, request(1))
    permissionHook(sid, 5)
    behaveLikeDialog(pty)
    mocks.writePty.mockClear()

    const always = {
      index: 2,
      label: "Yes, and don't ask again for npm publish commands",
      focused: false,
      deny: false,
    }
    await expect(store().answerDialog(sid, 'claude-1', always, 'Answered: 2')).resolves.toBe(true)
    expect(writesTo(pty)).toEqual(['\x1b[B', '\r'])
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'thinking', blocked: null })
    expect(session(sid).messages.at(-1)).toMatchObject({ from: 'you', text: 'Answered: 2' })
  })

  it('refuses with Esc alone, and sends nothing once the request is gone', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId!
    screens.set(pty, request(1))
    permissionHook(sid, 5)
    behaveLikeDialog(pty)
    mocks.writePty.mockClear()

    const deny = {
      index: 3,
      label: 'No, and tell Claude what to do differently (esc)',
      focused: false,
      deny: true,
    }
    await expect(store().answerDialog(sid, 'claude-1', deny)).resolves.toBe(true)
    expect(writesTo(pty)).toEqual(['\x1b'])
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'idle', blocked: null })

    mocks.writePty.mockClear()
    await expect(store().answerDialog(sid, 'claude-1', deny)).resolves.toBe(false)
    expect(writesTo(pty)).toEqual([])
  })
})

describe('restarting the orchestrator (N4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  const CONVERSATION = '6f1e2d3c-4b5a-4987-8a7b-1c2d3e4f5a6b'

  /** An orchestrator that went down while one worker works and another is done. */
  async function downWithWorkers(conversation: string | null) {
    const sid = await startSession('C:/repo', 'ship the release')
    await vi.waitFor(() => expect(agentIn(sid, 'orchestrator').ptyId).not.toBeNull())
    emit({
      kind: 'hook',
      session: sid,
      at: 1,
      agent_id: 'orchestrator',
      hook: {
        hook_event_name: 'SessionStart',
        ...(conversation ? { session_id: conversation } : {}),
      },
    })
    await spawnWorker(sid, 'claude-1', 'build the api')
    emit({
      kind: 'report',
      session: sid,
      at: 2,
      agent_id: 'claude-1',
      progress: 40,
      status: 'editing',
      note: 'routes done',
    })
    await spawnWorker(sid, 'claude-2', 'write the docs')
    emit({
      kind: 'report',
      session: sid,
      at: 3,
      agent_id: 'claude-2',
      progress: 100,
      status: 'done',
      note: 'docs shipped',
    })
    exitAgent(sid, 'orchestrator', 1)
    mocks.spawnPty.mockClear()
    return sid
  }
  const launchArgs = () => mocks.spawnPty.mock.calls[0]?.[0].extraArgs ?? []

  it('restarts it in its own conversation, told where every worker stands', async () => {
    const sid = await downWithWorkers(CONVERSATION)
    await store().restartAgent(sid, 'orchestrator')
    const args = launchArgs()
    expect(args[args.indexOf('--resume') + 1]).toBe(CONVERSATION)
    const first = args.at(-1) ?? ''
    expect(first).toContain('restarted you in this same conversation')
    expect(first).toContain('claude-1 [api] working at 40% (last note: routes done)')
    expect(first).toContain('claude-2 [api] done (last note: docs shipped)')
    expect(first).toContain('Do not plan the goal again')
  })

  it('without its conversation, starts it from where the workers stand, not from the goal', async () => {
    const sid = await downWithWorkers(null)
    await store().restartAgent(sid, 'orchestrator')
    const args = launchArgs()
    expect(args).not.toContain('--resume')
    const first = args.at(-1) ?? ''
    expect(first).toContain('in a new conversation')
    expect(first).toContain('claude-1 [api] working at 40%')
    expect(first).toContain('Do not plan the goal again')
  })
})

describe('a worker whose process ended after done (N10)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('takes no message: it fails at once instead of waiting forever, and senders hear it', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    await spawnWorker(sid, 'claude-2')
    emit({
      kind: 'report',
      session: sid,
      at: 2,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'shipped',
    })
    exitAgent(sid, 'claude-1', 0)
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'done', exitReason: 'exited' })
    const ended = agentIn(sid, 'claude-1').ptyId
    const other = agentIn(sid, 'claude-2').ptyId
    mocks.writePty.mockClear()

    const sent = await store().send(sid, 'claude-1', 'one more thing')
    expect(sent.delivery).toBe('failed')
    expect(session(sid).messages.find((m) => m.id === sent.id)?.failure).toBe('exited')

    // A broadcast skips it; a worker writing to it is told.
    await store().send(sid, 'all', 'status please')
    emit({ kind: 'message', session: sid, at: 3, from: 'claude-2', to: 'claude-1', text: 'thanks' })
    await vi.waitFor(() =>
      expect(writesTo(other)).toContain(
        '[orchestra · from orchestra] not delivered: message to claude-1, its terminal has exited',
      ),
    )
    expect(writesTo(other)).toContain('status please')
    expect(writesTo(ended)).toEqual([])
  })
})

describe('one Stop and one Restart at a time', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('takes a second Stop, while the first ends the processes, as the same Stop', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    await Promise.all([store().stopAgents(sid), store().stopAgents(sid)])
    expect(mocks.orchestraEnd.mock.calls).toEqual([[sid]])
    expect(session(sid).stoppedAt).toBeTruthy()
  })

  it('ignores a second Restart of the same agent while the first one runs', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    await Promise.all([
      store().restartAgent(sid, 'claude-1', { notice: 'Restarted claude-1.' }),
      store().restartAgent(sid, 'claude-1', { notice: 'Restarted claude-1.' }),
    ])
    expect(session(sid).messages.filter((m) => m.text === 'Restarted claude-1.')).toHaveLength(1)
  })
})

describe('relaunches, resumes and notices (final integration review)', () => {
  /** What each fake terminal shows; the store reads dialogs from its mirror. */
  const screens = new Map<string, string[]>()
  const CONVERSATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  const LAUNCH = {
    endpoint: 'http://127.0.0.1:1',
    token: 't',
    settings_path: 's.json',
    cli_path: 'orch.cmd',
    path_env: '',
  }
  const hook = (sid: string, id: string, body: Record<string, unknown>) =>
    emit({ kind: 'hook', session: sid, at: 5, agent_id: id, hook: body as never })
  const trustDialog = [
    ' Do you trust the files in this folder?',
    ' ❯ 1. Yes, proceed',
    '   2. No, exit',
    '',
    ' Enter to confirm · Esc to exit',
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    screens.clear()
    mocks.getMirror.mockImplementation((ptyId: string) => {
      const lines = screens.get(ptyId)
      return (
        lines
          ? {
              baseY: 0,
              rows: lines.length,
              modes: { applicationCursorKeys: false },
              getText: () => lines.join('\n'),
            }
          : null
      ) as never
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    mocks.getMirror.mockImplementation(() => null)
    await store().stopAll()
  })

  it('fails a resumed agent that dies after its first hook, even while a dialog holds it', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    hook(sid, 'claude-1', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'x',
      session_id: CONVERSATION,
    })
    exitAgent(sid, 'claude-1', 1)
    mocks.spawnPty.mockClear()
    await store().restartAgent(sid, 'claude-1', { resume: true })
    const args = mocks.spawnPty.mock.calls[0]?.[0].extraArgs ?? []
    expect(args[args.indexOf('--resume') + 1]).toBe(CONVERSATION)

    // The conversation came back (a hook), then a permission request holds its prompt.
    wake(sid, 'claude-1')
    hook(sid, 'claude-1', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    })
    exitAgent(sid, 'claude-1', 1)

    // An ordinary failure: never "conversation not found", never its task started over.
    expect(agentIn(sid, 'claude-1')).toMatchObject({ state: 'exited', exitCode: 1 })
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1)
    expect(session(sid).messages.some((m) => m.text.startsWith('not resumed'))).toBe(false)
  })

  it('keeps double quotes out of the restart prompt, which crosses a command line', () => {
    const working: OrchestraAgent = {
      ...doneAgent(),
      state: 'thinking',
      progress: 40,
      note: 'renamed "A&B" and wrote "out>log.txt"',
    }
    const asking: OrchestraAgent = {
      ...doneAgent(),
      id: 'claude-2',
      area: 'docs "v2"',
      state: 'blocked',
      note: '',
      blocked: { reason: 'question', text: 'use "pnpm" | npm?', at: 1 },
    }
    const text = orchestratorRestartPrompt([working, asking], true)
    // cmd.exe would see `&`, `|` and `>` outside the argument's quotes after an inner `"`.
    expect(text).not.toContain('"')
    expect(text).toContain("renamed 'A&B' and wrote 'out>log.txt'")
    expect(text).toContain("claude-2 [docs 'v2'] blocked: use 'pnpm' | npm?")
  })

  it('looks at the screen again after a restart before pasting into the new terminal', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    // Claude Code said it idles at its prompt; then the user restarts it.
    hook(sid, 'claude-1', { hook_event_name: 'Stop' })
    await store().restartAgent(sid, 'claude-1')
    const pty = agentIn(sid, 'claude-1').ptyId!
    // The new process opens with a dialog of its own (folder trust, MCP approval...).
    screens.set(pty, trustDialog)
    const sent = await store().send(sid, 'claude-1', 'hello')
    expect(sent.delivery).toBe('queued')

    vi.useFakeTimers()
    mocks.writePty.mockClear()
    mocks.outputs.get(pty)?.()
    await vi.advanceTimersByTimeAsync(4_000)
    // Nothing reached the dialog: no text and, above all, no Enter.
    expect(writesTo(pty)).toEqual([])
    expect(session(sid).messages.find((m) => m.id === sent.id)?.delivery).toBe('queued')
  })

  it('keeps a notice for the orchestrator while it relaunches and gives it once it runs', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    await spawnWorker(sid, 'claude-1')
    let release: () => void = () => {}
    mocks.orchestraPrepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(LAUNCH)
        }),
    )
    const restarting = store().restartAgent(sid, 'orchestrator')
    await vi.waitFor(() => expect(agentIn(sid, 'orchestrator')).toMatchObject({ ptyId: null }))

    // A worker finishes while the orchestrator has no terminal yet.
    emit({
      kind: 'report',
      session: sid,
      at: 6,
      agent_id: 'claude-1',
      progress: 100,
      status: 'done',
      note: 'api shipped',
    })
    release()
    await restarting
    const pty = agentIn(sid, 'orchestrator').ptyId!
    wake(sid, 'orchestrator')
    await vi.waitFor(() =>
      expect(writesTo(pty)).toContain('[orchestra · from claude-1] finished: api shipped'),
    )
  })
})

describe('confirmStop', () => {
  it('uses the native dialog answer', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    await expect(confirmStop('stop?')).resolves.toBe(false)
  })

  it('falls back when the dialog is denied by the ACL', async () => {
    mocks.confirm.mockRejectedValueOnce(new Error('not allowed by ACL'))
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await expect(confirmStop('stop?')).resolves.toBe(false)
    spy.mockRestore()
  })

  it('still lets the user stop when no dialog works', async () => {
    mocks.confirm.mockRejectedValueOnce(new Error('not allowed by ACL'))
    const spy = vi
      .spyOn(window, 'confirm')
      .mockReturnValue(Promise.reject(new Error('denied')) as unknown as boolean)
    await expect(confirmStop('stop?')).resolves.toBe(true)
    spy.mockRestore()
  })
})

describe('notices to the orchestrator and the restart history cap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store().stopAll()
  })

  it('pastes an [orchestra] line into the orchestrator when the session account changes', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    store().setSessionAccount(sid, 'acc-x')
    const orchestratorPty = agentIn(sid, 'orchestrator').ptyId
    await vi.waitFor(() =>
      expect(writesTo(orchestratorPty)).toContain(
        '[orchestra] session account is now acc-x (was default); workers spawned from now on start there',
      ),
    )
  })

  it('tellAgent records a bus line and pastes the notice; a wait of the old account is dropped', async () => {
    const sid = await startSession()
    wake(sid, 'orchestrator')
    store().tellAgent(sid, 'orchestrator', 'quota at 90%')
    expect(session(sid).messages.at(-1)).toMatchObject({
      from: 'orchestra',
      to: 'orchestrator',
      text: 'quota at 90%',
    })
    const orchestratorPty = agentIn(sid, 'orchestrator').ptyId
    await vi.waitFor(() => expect(writesTo(orchestratorPty)).toContain('[orchestra] quota at 90%'))

    store().setLimitWait(sid, { account: null, resetsAt: 5000 })
    expect(session(sid).limitWait).toEqual({ account: null, resetsAt: 5000 })
    store().setSessionAccount(sid, 'acc-x')
    expect(session(sid).limitWait).toBeNull()
  })

  it('keeps only the last 2 earlier terminals: 4 restarts free the 2 oldest mirrors', async () => {
    const sid = await startSession()
    await spawnWorker(sid, 'claude-1')
    const ptys: string[] = []
    for (let i = 0; i < 4; i++) {
      ptys.push(agentIn(sid, 'claude-1').ptyId!)
      await store().restartAgent(sid, 'claude-1')
      await vi.waitFor(() => expect(agentIn(sid, 'claude-1').ptyId).not.toBeNull())
    }
    expect(new Set(ptys).size).toBe(4)
    expect(retiredPtys(sid, 'claude-1')).toEqual(ptys.slice(2))
    expect(mocks.disposeMirror.mock.calls.map(([id]) => id)).toEqual(ptys.slice(0, 2))
    expect(
      session(sid).messages.filter((m) => m.text.startsWith('older terminal discarded')),
    ).toHaveLength(2)
  })
})
