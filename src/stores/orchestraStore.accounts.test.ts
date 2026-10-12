import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent, OrchestraLaunch } from '../lib/tauri/orchestra'

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
    listenOrchestra: vi.fn((handler: (event: OrchestraEvent) => void) => {
      bus.handler = handler
      return Promise.resolve(() => {})
    }),
    orchestraAccountPolicy: vi.fn((_sessionId: string, _single: boolean, _label: string | null) =>
      Promise.resolve(),
    ),
    copyConversation: vi.fn(
      (_args: { fromDir: string; toDir: string; cwd: string; sessionId: string }) =>
        Promise.resolve({ copied: true, reason: null as string | null }),
    ),
    orchestraPrepare: vi.fn(() => Promise.resolve(launch)),
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

vi.mock('../lib/tauri/conversation', () => ({ copyConversation: mocks.copyConversation }))

vi.mock('../lib/claudeAccounts', () => ({
  accountConfigDirCached: (id: string) => `C:\\data\\claude-accounts\\${id}`,
}))

vi.mock('../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: mocks.orchestraPrepare,
  orchestraResume: vi.fn(() => Promise.resolve()),
  orchestraFolderExists: vi.fn(() => Promise.resolve(true)),
  orchestraWriteTask: vi.fn((sessionId: string, agentId: string) =>
    Promise.resolve(`C:\\Temp\\task-${sessionId}-${agentId}.md`),
  ),
  orchestraManifestSave: vi.fn(() => Promise.resolve()),
  orchestraManifestRemove: vi.fn(() => Promise.resolve()),
  orchestraAccountPolicy: mocks.orchestraAccountPolicy,
  listenOrchestra: mocks.listenOrchestra,
}))

vi.mock('../lib/terminalMirror', () => ({
  ensureMirror: vi.fn(() => ({})),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
  getMirror: vi.fn(() => null),
}))

import { useLaunchDefaults } from '../components/Orchestra/usage/launchDefaults'
import { useOrchestraStore } from './orchestraStore'
import { useProjectsStore } from './projectsStore'

const store = () => useOrchestraStore.getState()
const emit = (event: OrchestraEvent) => mocks.bus.handler?.(event)
const agentIn = (sessionId: string, agentId: string) =>
  store().sessions[sessionId].agents.find((a) => a.id === agentId)!
const CONVERSATION = '00000000-0000-4000-8000-000000000001'

function launchesOf(agentId: string): SpawnArgs[] {
  return mocks.spawnPty.mock.calls
    .map(([args]) => args)
    .filter((args) => args.id.includes(`-${agentId}-`))
}

const accountDir = (id: string) => `C:\\data\\claude-accounts\\${id}`
const promptOf = (args: string[]) => args[args.indexOf('--append-system-prompt') + 1] ?? ''

async function spawn(sessionId: string, id: string, account: string | null = null) {
  emit({
    kind: 'spawn',
    session: sessionId,
    at: 1,
    id,
    area: 'api',
    task: `task of ${id}`,
    after: [],
    account,
  })
  await vi.waitFor(() => expect(agentIn(sessionId, id).ptyId).not.toBeNull())
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.exits.clear()
  useProjectsStore.setState((s) => ({
    preferences: {
      ...s.preferences,
      claudeAccounts: [
        { id: 'acc-a', name: 'Contábil' },
        { id: 'acc-b', name: 'Compras' },
      ] as typeof s.preferences.claudeAccounts,
    },
  }))
})

afterEach(async () => {
  await store().stopAll()
  useLaunchDefaults
    .getState()
    .setDefaults({ policy: 'single', account: null, model: null, effort: null })
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, claudeAccounts: [] } }))
  localStorage.clear()
})

describe('one account per orchestration', () => {
  it('is the default: the session runs on the chosen account and the prompt lists no accounts', async () => {
    useLaunchDefaults.getState().setDefaults({ account: 'acc-a' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    expect(store().sessions[sid].launch).toEqual({
      policy: 'single',
      account: 'acc-a',
      model: null,
      effort: null,
    })
    expect(mocks.orchestraAccountPolicy).toHaveBeenCalledWith(sid, true, 'Contábil')
    await vi.waitFor(() => expect(launchesOf('orchestrator')).toHaveLength(1))
    const orchestrator = launchesOf('orchestrator')[0]
    expect(orchestrator.env?.CLAUDE_CONFIG_DIR).toBe(accountDir('acc-a'))
    const prompt = promptOf(orchestrator.extraArgs ?? [])
    expect(prompt).not.toContain('acc-b=')
    expect(prompt).not.toMatch(/spread heavy work/i)
  })

  it('starts a worker spawned with --account on another account on the session account', async () => {
    useLaunchDefaults.getState().setDefaults({ account: 'acc-a', model: 'sonnet' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    await spawn(sid, 'claude-1', 'acc-b')
    const worker = launchesOf('claude-1')[0]
    expect(worker.env?.CLAUDE_CONFIG_DIR).toBe(accountDir('acc-a'))
    expect(worker.extraArgs).toContain('sonnet')
    expect(agentIn(sid, 'claude-1').launchedWith?.account).toBe('acc-a')
  })

  it('in "spread", the spawn flag picks the account and the prompt lists them', async () => {
    useLaunchDefaults.getState().setDefaults({ policy: 'spread', account: 'acc-a' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    expect(mocks.orchestraAccountPolicy).toHaveBeenCalledWith(sid, false, 'Contábil')
    await spawn(sid, 'claude-1', 'acc-b')
    expect(launchesOf('claude-1')[0].env?.CLAUDE_CONFIG_DIR).toBe(accountDir('acc-b'))
    expect(promptOf(launchesOf('orchestrator')[0].extraArgs ?? [])).toContain('acc-b=Compras')
  })

  it('a form change after the start does not touch a running session', async () => {
    useLaunchDefaults.getState().setDefaults({ account: 'acc-a' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    useLaunchDefaults.getState().setDefaults({ account: 'acc-b' })
    await spawn(sid, 'claude-1')
    expect(launchesOf('claude-1')[0].env?.CLAUDE_CONFIG_DIR).toBe(accountDir('acc-a'))
  })
})

describe('switching the session account', () => {
  it('starts new workers on the new account, records the switch and leaves running ones alone', async () => {
    useLaunchDefaults.getState().setDefaults({ account: 'acc-a' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    await spawn(sid, 'claude-1')
    store().setSessionAccount(sid, 'acc-b')
    const session = store().sessions[sid]
    expect(session.launch?.account).toBe('acc-b')
    expect(session.accountSwitches).toEqual([
      { at: expect.any(Number), from: 'acc-a', to: 'acc-b' },
    ])
    expect(mocks.orchestraAccountPolicy).toHaveBeenLastCalledWith(sid, true, 'Compras')
    await spawn(sid, 'claude-2')
    expect(launchesOf('claude-2')[0].env?.CLAUDE_CONFIG_DIR).toBe(accountDir('acc-b'))
    // Never restarted for the user: claude-1 still has its one launch, on the old account.
    expect(launchesOf('claude-1')).toHaveLength(1)
    expect(agentIn(sid, 'claude-1').launchedWith?.account).toBe('acc-a')
  })

  it('restarting on the new account copies the conversation and continues it there', async () => {
    useLaunchDefaults.getState().setDefaults({ account: 'acc-a' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    await spawn(sid, 'claude-1')
    useOrchestraStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [sid]: {
          ...s.sessions[sid],
          agents: s.sessions[sid].agents.map((a) =>
            a.id === 'claude-1' ? { ...a, claudeSessionId: CONVERSATION } : a,
          ),
        },
      },
    }))
    store().setSessionAccount(sid, 'acc-b')
    await store().restartAgent(sid, 'claude-1', { moveAccount: true })
    expect(mocks.copyConversation).toHaveBeenCalledWith({
      fromDir: accountDir('acc-a'),
      toDir: accountDir('acc-b'),
      cwd: 'C:/repo',
      sessionId: CONVERSATION,
    })
    const again = launchesOf('claude-1').at(-1)!
    expect(again.env?.CLAUDE_CONFIG_DIR).toBe(accountDir('acc-b'))
    expect(again.extraArgs?.[again.extraArgs.indexOf('--resume') + 1]).toBe(CONVERSATION)
  })

  it('starts the task over on the new account when the copy finds nothing', async () => {
    mocks.copyConversation.mockResolvedValueOnce({ copied: false, reason: 'not_found' })
    useLaunchDefaults.getState().setDefaults({ account: 'acc-a' })
    const sid = (await store().start('C:/repo', 'goal', true))!
    await spawn(sid, 'claude-1')
    useOrchestraStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [sid]: {
          ...s.sessions[sid],
          agents: s.sessions[sid].agents.map((a) =>
            a.id === 'claude-1' ? { ...a, claudeSessionId: CONVERSATION } : a,
          ),
        },
      },
    }))
    store().setSessionAccount(sid, null)
    await store().restartAgent(sid, 'claude-1', { moveAccount: true })
    expect(mocks.copyConversation.mock.calls[0][0].toDir).toBe('')
    const again = launchesOf('claude-1').at(-1)!
    expect(again.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(again.extraArgs).not.toContain('--resume')
  })
})
