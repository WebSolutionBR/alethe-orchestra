import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent, OrchestraLaunch } from '../lib/tauri/orchestra'
import { disposeMirror } from '../lib/terminalMirror'

type SpawnArgs = { id: string; extraArgs?: string[]; env?: Record<string, string> }
type ExitPayload = { code: number | null; reason: string }

const mocks = vi.hoisted(() => {
  const bus = { handler: null as ((event: OrchestraEvent) => void) | null }
  const launch: OrchestraLaunch = {
    endpoint: 'http://127.0.0.1:1',
    token: 't',
    settings_path: 's.json',
    cli_path: 'C:\\Temp\\alethe-orchestra\\bin\\orch.cmd',
    path_env: '',
  }
  return {
    bus,
    exits: new Map<string, (payload: ExitPayload) => void>(),
    folders: { exists: true },
    listenOrchestra: vi.fn((handler: (event: OrchestraEvent) => void) => {
      bus.handler = handler
      return Promise.resolve(() => {})
    }),
    orchestraReset: vi.fn((_sessionId: string) => Promise.resolve()),
    orchestraEnd: vi.fn((_sessionId: string) => Promise.resolve()),
    orchestraPrepare: vi.fn((_sessionId: string, _agentId: string, _cwd?: string) =>
      Promise.resolve(launch),
    ),
    orchestraResume: vi.fn((_sessionId: string, _next: number) => Promise.resolve()),
    orchestraFolderExists: vi.fn((_path: string) => Promise.resolve(true)),
    orchestraWriteTask: vi.fn((sessionId: string, agentId: string, _text: string) =>
      Promise.resolve(`C:\\Temp\\alethe-orchestra\\task-${sessionId}-${agentId}.md`),
    ),
    spawnPty: vi.fn((_args: SpawnArgs) => Promise.resolve({ id: '' })),
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../lib/tauri', () => ({
  spawnPty: mocks.spawnPty,
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn((id: string, handler: (payload: ExitPayload) => void) => {
    mocks.exits.set(id, handler)
    return Promise.resolve(() => {})
  }),
  listenPtyData: vi.fn(() => Promise.resolve(() => {})),
  listenPtyActivity: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../lib/tauri/accountMcp', () => ({
  syncAccountMcpServers: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../lib/claudeAccounts', () => ({
  accountConfigDirCached: (id: string) => `C:\\data\\claude-accounts\\${id}`,
}))

vi.mock('../lib/tauri/orchestra', () => ({
  orchestraReset: mocks.orchestraReset,
  orchestraEnd: mocks.orchestraEnd,
  orchestraPrepare: mocks.orchestraPrepare,
  orchestraResume: mocks.orchestraResume,
  orchestraFolderExists: mocks.orchestraFolderExists,
  orchestraWriteTask: mocks.orchestraWriteTask,
  orchestraManifestSave: vi.fn(() => Promise.resolve()),
  orchestraManifestRemove: vi.fn(() => Promise.resolve()),
  listenOrchestra: mocks.listenOrchestra,
}))

vi.mock('../lib/terminalMirror', () => ({
  ensureMirror: vi.fn(() => ({})),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
  getMirror: vi.fn(() => null),
}))

import {
  manifestOf,
  type OrchestraManifest,
  WORKER_MOVED_PROMPT,
  WORKER_NOT_RESUMED_PROMPT,
  WORKER_RESTARTED_PROMPT,
  WORKER_RESUMED_PROMPT,
} from '../components/Orchestra/resume/manifest'
import { useLaunchDefaults } from '../components/Orchestra/usage/launchDefaults'
import {
  conversationPatch,
  firstMessage,
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from './orchestraStore'
import { useProjectsStore } from './projectsStore'

const store = () => useOrchestraStore.getState()
const emit = (event: OrchestraEvent) => mocks.bus.handler?.(event)
const agentIn = (sessionId: string, agentId: string) =>
  store().sessions[sessionId].agents.find((a) => a.id === agentId)!
const taskFile = (sessionId: string, agentId: string) =>
  `C:\\Temp\\alethe-orchestra\\task-${sessionId}-${agentId}.md`
/** A Claude Code conversation id (a UUID) for each agent. */
const conv = (id: string) =>
  `00000000-0000-4000-8000-${String(id === 'orchestrator' ? 0 : Number(id.split('-')[1])).padStart(12, '0')}`

/** Launches of an agent, oldest first (its id is in the PTY id). */
function launchesOf(agentId: string): SpawnArgs[] {
  return mocks.spawnPty.mock.calls
    .map(([args]) => args)
    .filter((args) => args.id.includes(`-${agentId}-`))
}

/** Arguments of the latest `claude` launch of an agent. */
function argsOf(agentId: string): string[] {
  const launches = launchesOf(agentId)
  expect(launches.length, `no launch for ${agentId}`).toBeGreaterThan(0)
  return launches.at(-1)!.extraArgs ?? []
}

const flagValue = (args: string[], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'api',
    task: `task of ${id}`,
    after: [],
    ptyId: `orchestra-oresume1-${id}-1`,
    state: 'thinking',
    progress: 30,
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
    exitCode: null,
    exitReason: null,
    blocked: null,
    claudeSessionId: conv(id),
    transcriptPath: null,
    launchedWith: { account: null, model: null, effort: null },
    ...patch,
  }
}

function interrupted(agents?: OrchestraAgent[]): OrchestraManifest {
  const session: OrchestraSession = {
    id: 'oresume1',
    projectId: null,
    cwd: 'C:/repo',
    goal: 'Ship the "reader" & docs',
    autonomous: true,
    startedAt: 100,
    mode: 'timeline',
    agents: agents ?? [
      agent('orchestrator', { state: 'idle' }),
      agent('claude-1', { state: 'done', progress: 100 }),
      agent('claude-2', { state: 'editing' }),
      agent('claude-3', { state: 'idle', claudeSessionId: null }),
      agent('claude-4', { state: 'waiting', after: ['claude-2'], ptyId: null }),
      agent('claude-5', { state: 'exited', exitCode: 1, exitReason: 'exited' }),
    ],
    messages: [
      { id: 7, at: 5, from: 'orchestrator', to: 'claude-2', text: 'hi', delivery: 'delivered' },
      { id: 8, at: 6, from: 'orchestrator', to: 'claude-4', text: 'later', delivery: 'queued' },
    ],
    segments: [],
    selectedId: null,
    error: null,
  }
  return manifestOf(session, 900)
}

beforeEach(() => {
  mocks.spawnPty.mockClear()
  mocks.orchestraWriteTask.mockClear()
  mocks.orchestraResume.mockClear()
  mocks.orchestraPrepare.mockClear()
  mocks.orchestraFolderExists.mockImplementation(() => Promise.resolve(true))
  mocks.exits.clear()
})

afterEach(async () => {
  await store().stopAll()
  useLaunchDefaults.getState().setDefaults({ account: null, model: null, effort: null })
  localStorage.clear()
})

describe('the Claude conversation of each agent', () => {
  it('comes from the hooks: first value kept, a new one replaces it, odd ones ignored', () => {
    const base = agent('claude-1', { claudeSessionId: null, transcriptPath: null })
    expect(conversationPatch(base, {})).toEqual({})
    expect(conversationPatch(base, { session_id: '', transcript_path: '' })).toEqual({})
    // Not a UUID: it would reach `claude --resume` on a command line.
    expect(conversationPatch(base, { session_id: 'a&calc' })).toEqual({})
    expect(
      conversationPatch(base, { session_id: conv('claude-1'), transcript_path: 'C:\\t\\a1.jsonl' }),
    ).toEqual({ claudeSessionId: conv('claude-1'), transcriptPath: 'C:\\t\\a1.jsonl' })
    const known = { ...base, claudeSessionId: conv('claude-1'), transcriptPath: 'C:\\t\\a1.jsonl' }
    expect(conversationPatch(known, { session_id: conv('claude-1') })).toEqual({})
    // `/clear` starts a new conversation: the newest one is the one to resume.
    expect(conversationPatch(known, { session_id: conv('claude-2') })).toEqual({
      claudeSessionId: conv('claude-2'),
    })
  })

  it('is stored on the agent as its hooks arrive', async () => {
    const id = (await store().start('C:/repo', 'goal', true))!
    await vi.waitFor(() => expect(agentIn(id, 'orchestrator').ptyId).not.toBeNull())
    emit({
      kind: 'hook',
      session: id,
      at: 2,
      agent_id: 'orchestrator',
      hook: {
        hook_event_name: 'UserPromptSubmit',
        session_id: conv('claude-9'),
        transcript_path: 'C:\\x\\conv-9.jsonl',
      },
    })
    expect(agentIn(id, 'orchestrator')).toMatchObject({
      claudeSessionId: conv('claude-9'),
      transcriptPath: 'C:\\x\\conv-9.jsonl',
    })
  })
})

describe('the task reaches the agent as a file', () => {
  it('keeps the exact text in the file and points the agent at it', async () => {
    const goal = 'Line one with "quotes" & 100%\nline two'
    const id = (await store().start('C:/repo', goal, true))!
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalled())
    expect(mocks.orchestraWriteTask).toHaveBeenCalledWith(id, 'orchestrator', goal)
    const args = argsOf('orchestrator')
    expect(args.at(-1)).toBe(
      `Read the user's goal in "${taskFile(id, 'orchestrator')}", then plan it and delegate it to workers.`,
    )
    // The goal itself never rides the command line, line breaks least of all.
    expect(args).not.toContain(goal)
    expect(args.some((arg) => /[\r\n]/.test(arg))).toBe(false)

    emit({
      kind: 'spawn',
      session: id,
      at: 3,
      id: 'claude-1',
      area: 'ui',
      task: 'Do X\n- a',
      after: [],
    })
    await vi.waitFor(() => expect(agentIn(id, 'claude-1').ptyId).not.toBeNull())
    expect(mocks.orchestraWriteTask).toHaveBeenCalledWith(id, 'claude-1', 'Do X\n- a')
    expect(argsOf('claude-1').at(-1)).toBe(
      `Read your task in "${taskFile(id, 'claude-1')}" and then do it.`,
    )
  })

  it('goes inline, on one line, when the file cannot be written', async () => {
    mocks.orchestraWriteTask.mockImplementationOnce(() => Promise.reject(new Error('disk full')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = (await store().start('C:/repo', 'first\nsecond', true))!
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalled())
    expect(argsOf('orchestrator').at(-1)).toBe('first second')
    expect(id).toBeTruthy()
    warn.mockRestore()
  })

  it('has no first message when there is no goal', async () => {
    await store().start('C:/repo', '', true)
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalled())
    expect(mocks.orchestraWriteTask).not.toHaveBeenCalled()
    expect(argsOf('orchestrator').at(-1)).toBe('--dangerously-skip-permissions')
  })

  it('tells a resumed agent to continue, or to start over from its file', async () => {
    const resumed = await firstMessage('oabc', 'claude-2', 'task', {
      claudeSessionId: conv('claude-2'),
      prompt: WORKER_RESUMED_PROMPT,
    })
    expect(resumed).toBe(
      `${WORKER_RESUMED_PROMPT} Your task is still in "${taskFile('oabc', 'claude-2')}".`,
    )
    const restarted = await firstMessage('oabc', 'claude-3', 'task', {
      claudeSessionId: null,
      prompt: WORKER_RESTARTED_PROMPT,
    })
    expect(restarted).toBe(
      `${WORKER_RESTARTED_PROMPT} Read your task in "${taskFile('oabc', 'claude-3')}" and then do it.`,
    )
  })

  it('never tells an orchestrator started over to plan its goal again', async () => {
    const restarted = await firstMessage('oabc', 'orchestrator', 'ship it', {
      claudeSessionId: null,
      prompt: '[orchestra] You were restarted.',
    })
    expect(restarted).toBe(
      `[orchestra] You were restarted. The user's goal is in "${taskFile('oabc', 'orchestrator')}".`,
    )
  })
})

describe('resume', () => {
  it('brings the session back under its id and relaunches only the unfinished agents', async () => {
    const id = await store().resume(interrupted())
    expect(id).toBe('oresume1')
    expect(mocks.orchestraResume).toHaveBeenCalledWith('oresume1', 6)
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    expect(['orchestrator', 'claude-2', 'claude-3'].map((a) => launchesOf(a).length)).toEqual([
      1, 1, 1,
    ])
    for (const [args] of mocks.spawnPty.mock.calls) {
      expect(args.env?.ALETHE_ORCHESTRA_SESSION).toBe('oresume1')
    }
    // Every launch is checked against the folder: a folder that is gone fails it.
    expect(mocks.orchestraPrepare).toHaveBeenCalledWith('oresume1', 'claude-2', 'C:/repo')

    const session = store().sessions['oresume1']
    expect(session).toMatchObject({
      cwd: 'C:/repo',
      goal: 'Ship the "reader" & docs',
      autonomous: true,
      startedAt: 100,
      mode: 'timeline',
    })
    expect(store().activeId).toBe('oresume1')
    expect(agentIn('oresume1', 'claude-1')).toMatchObject({ state: 'done', ptyId: null })
    expect(agentIn('oresume1', 'claude-4')).toMatchObject({ state: 'waiting', ptyId: null })
    // The message that never reached claude-4 can be sent again.
    expect(session.messages.find((m) => m.id === 8)).toMatchObject({
      delivery: 'failed',
      failure: 'exited',
    })
  })

  it('never relaunches a worker that had failed: it stays failed, for the user to restart', async () => {
    await store().resume(interrupted())
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    expect(launchesOf('claude-5')).toHaveLength(0)
    expect(agentIn('oresume1', 'claude-5')).toMatchObject({ state: 'exited', exitCode: 1 })
    expect(argsOf('orchestrator').at(-1)).toContain('Failed before the close and not relaunched')
  })

  it('brings a finished worker back without a process: a message to it fails at once', async () => {
    await store().resume(interrupted())
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    expect(agentIn('oresume1', 'claude-1')).toMatchObject({
      state: 'done',
      ptyId: null,
      exitReason: 'exited',
    })
    // Never queued for a terminal that will not come back.
    const sent = await store().send('oresume1', 'claude-1', 'one more thing')
    expect(sent.delivery).toBe('failed')
    expect(store().sessions['oresume1'].messages.find((m) => m.id === sent.id)).toMatchObject({
      delivery: 'failed',
      failure: 'exited',
    })
  })

  it('continues each conversation with claude --resume and tells the orchestrator', async () => {
    await store().resume(interrupted())
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))

    const orchestrator = argsOf('orchestrator')
    expect(flagValue(orchestrator, '--resume')).toBe(conv('orchestrator'))
    const notice = orchestrator.at(-1)!
    expect(notice).toMatch(/^\[orchestra\] Alethe was closed while this orchestration was running/)
    expect(notice).toContain('Resumed in their own conversations: claude-2 (api).')
    expect(notice).toContain('claude-3 (api)')
    expect(notice).toContain(`The goal is still in "${taskFile('oresume1', 'orchestrator')}".`)
    const bus = store().sessions['oresume1'].messages.at(-1)!
    expect(bus).toMatchObject({ id: 9, from: 'you', to: 'orchestrator' })
    expect(notice.startsWith(bus.text)).toBe(true)

    const worker = argsOf('claude-2')
    expect(flagValue(worker, '--resume')).toBe(conv('claude-2'))
    expect(worker.at(-1)).toContain(WORKER_RESUMED_PROMPT)

    const fresh = argsOf('claude-3')
    expect(fresh).not.toContain('--resume')
    expect(fresh.at(-1)).toBe(
      `${WORKER_RESTARTED_PROMPT} Read your task in "${taskFile('oresume1', 'claude-3')}" and then do it.`,
    )
  })

  it('keeps each agent on the account, model and effort it ran with, not today’s defaults', async () => {
    useProjectsStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        claudeAccounts: [
          { id: 'acc-a', name: 'A' },
          { id: 'acc-b', name: 'B' },
        ] as typeof s.preferences.claudeAccounts,
      },
    }))
    // Today the defaults point elsewhere.
    useLaunchDefaults.getState().setDefaults({ account: 'acc-b', model: 'haiku', effort: 'low' })
    await store().resume(
      interrupted([
        agent('orchestrator', { launchedWith: { account: 'acc-a', model: 'opus', effort: 'max' } }),
        // Ran on Claude Code's own config dir: no CLAUDE_CONFIG_DIR on the way back either.
        agent('claude-2', { launchedWith: { account: null, model: 'sonnet', effort: null } }),
      ]),
    )
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(2))
    const orchestrator = launchesOf('orchestrator')[0]
    expect(orchestrator.env?.CLAUDE_CONFIG_DIR).toBe('C:\\data\\claude-accounts\\acc-a')
    expect(flagValue(orchestrator.extraArgs!, '--model')).toBe('opus')
    expect(flagValue(orchestrator.extraArgs!, '--effort')).toBe('max')
    const worker = launchesOf('claude-2')[0]
    expect(worker.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(flagValue(worker.extraArgs!, '--model')).toBe('sonnet')
    expect(worker.extraArgs).not.toContain('--effort')
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, claudeAccounts: [] } }))
  })

  it('refuses to start when its folder is gone, instead of running in the home folder', async () => {
    mocks.orchestraFolderExists.mockImplementation(() => Promise.resolve(false))
    expect(await store().resume(interrupted())).toBeNull()
    expect(mocks.spawnPty).not.toHaveBeenCalled()
    expect(store().sessions['oresume1']).toBeUndefined()
    expect(store().error).toBe('folder not found: C:/repo')
    useOrchestraStore.setState({ error: null })
  })

  it('in a folder the user picked, every agent starts over there', async () => {
    const id = await store().resume(interrupted(), { cwd: 'D:/moved/repo' })
    expect(id).toBe('oresume1')
    expect(mocks.orchestraFolderExists).toHaveBeenCalledWith('D:/moved/repo')
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    expect(store().sessions['oresume1'].cwd).toBe('D:/moved/repo')
    for (const [args] of mocks.spawnPty.mock.calls) expect(args.extraArgs).not.toContain('--resume')
    expect(argsOf('claude-2').at(-1)).toContain(WORKER_MOVED_PROMPT)
    expect(argsOf('orchestrator').at(-1)).toContain('It now runs in another folder')
    expect(mocks.orchestraPrepare).toHaveBeenCalledWith('oresume1', 'claude-2', 'D:/moved/repo')
  })

  it('starts an agent over, once, when claude --resume cannot find its conversation', async () => {
    await store().resume(interrupted())
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    const first = launchesOf('claude-2')[0]
    // Claude Code prints "No conversation found" and exits before any hook.
    mocks.exits.get(first.id)!({ code: 1, reason: 'exited' })
    await vi.waitFor(() => expect(launchesOf('claude-2')).toHaveLength(2))
    const retry = argsOf('claude-2')
    expect(retry).not.toContain('--resume')
    expect(retry.at(-1)).toBe(
      `${WORKER_NOT_RESUMED_PROMPT} Read your task in "${taskFile('oresume1', 'claude-2')}" and then do it.`,
    )
    expect(agentIn('oresume1', 'claude-2').state).toBe('starting')
    const told = store().sessions['oresume1'].messages.find((m) => m.text.startsWith('not resumed'))
    expect(told).toMatchObject({ from: 'claude-2', to: 'orchestrator' })
    // T6: the failed process's mirror is dropped at once, not kept until the session is closed.
    expect(vi.mocked(disposeMirror)).toHaveBeenCalledWith(first.id)
    expect(vi.mocked(disposeMirror)).not.toHaveBeenCalledWith(launchesOf('claude-2')[1].id)

    // That second launch has no --resume: if it dies too, it is an ordinary failure.
    mocks.exits.get(launchesOf('claude-2')[1].id)!({ code: 1, reason: 'exited' })
    await vi.waitFor(() => expect(agentIn('oresume1', 'claude-2').state).toBe('exited'))
    expect(launchesOf('claude-2')).toHaveLength(2)
  })

  it('treats an exit after the conversation came back as an ordinary failure', async () => {
    await store().resume(interrupted())
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    // Its first hook: the conversation resumed and took the prompt.
    emit({
      kind: 'hook',
      session: 'oresume1',
      at: 10,
      agent_id: 'claude-2',
      hook: { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
    })
    mocks.exits.get(launchesOf('claude-2')[0].id)!({ code: 1, reason: 'exited' })
    await vi.waitFor(() => expect(agentIn('oresume1', 'claude-2').state).toBe('exited'))
    expect(launchesOf('claude-2')).toHaveLength(1)
  })

  it('starts the workers that waited once their dependency finishes', async () => {
    await store().resume(interrupted())
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(3))
    emit({
      kind: 'report',
      session: 'oresume1',
      at: 9,
      agent_id: 'claude-2',
      progress: 100,
      status: 'done',
      note: 'ok',
    })
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(4))
    expect(argsOf('claude-4')).not.toContain('--resume')
    expect(argsOf('claude-4').at(-1)).toBe(
      `Read your task in "${taskFile('oresume1', 'claude-4')}" and then do it.`,
    )
  })

  it('refuses a session that is already running or has no folder', async () => {
    expect(await store().resume(interrupted())).toBe('oresume1')
    expect(await store().resume(interrupted())).toBeNull()
    expect(await store().resume({ ...interrupted(), id: 'onofolder', cwd: null })).toBeNull()
  })
})
