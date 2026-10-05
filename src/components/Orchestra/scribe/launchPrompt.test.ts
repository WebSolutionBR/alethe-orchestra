import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent, OrchestraLaunch } from '../../../lib/tauri/orchestra'

type SpawnArgs = { id: string; extraArgs?: string[] }

const mocks = vi.hoisted(() => {
  const bus = { handler: null as ((event: OrchestraEvent) => void) | null }
  const launch: OrchestraLaunch = {
    endpoint: 'http://127.0.0.1:1',
    token: 't',
    settings_path: 's.json',
    cli_path: 'orch.cmd',
    path_env: '',
  }
  return {
    bus,
    listenOrchestra: vi.fn((handler: (event: OrchestraEvent) => void) => {
      bus.handler = handler
      return Promise.resolve(() => {})
    }),
    orchestraPrepare: vi.fn(() => Promise.resolve(launch)),
    spawnPty: vi.fn((_args: SpawnArgs) => Promise.resolve({ id: '' })),
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../../lib/tauri', () => ({
  spawnPty: mocks.spawnPty,
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: mocks.orchestraPrepare,
  listenOrchestra: mocks.listenOrchestra,
}))

vi.mock('../../../lib/terminalMirror', () => ({
  ensureMirror: vi.fn(() => ({})),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
}))

// Never talks to a real vault: every Obsidian call is a mock.
vi.mock('./api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
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
  obsidianSearch: vi.fn(),
  obsidianRead: vi.fn(),
  obsidianList: vi.fn(),
  obsidianWriteContext: vi.fn(),
  obsidianRemoveContext: vi.fn(() => Promise.resolve()),
  obsidianPut: vi.fn(() => Promise.resolve()),
  obsidianPatchHeading: vi.fn(() => Promise.resolve({ applied: true, preexisting: false })),
  scribeAuthorRun: vi.fn(() => Promise.reject(new Error('not in tests'))),
  scribeAuthorCancel: vi.fn(() => Promise.resolve(false)),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
  scribeMaterialRead: vi.fn(() => Promise.resolve('')),
  scribeMaterialRemove: vi.fn(() => Promise.resolve()),
  scribeReadSources: vi.fn(() => Promise.resolve([])),
  scribeVaultIndex: vi.fn(() => Promise.resolve([])),
}))

import { useOrchestraStore } from '../../../stores/orchestraStore'
import { writeCreativeEnabled } from '../creative/role'
import {
  obsidianAppend,
  obsidianList,
  obsidianRead,
  obsidianRemoveContext,
  obsidianSearch,
  obsidianWriteContext,
  scribeMaterialAppend,
} from './api'
import { DEFAULT_SCRIBE_CONFIG, useScribeConfig } from './config'
import { sessionContextOf } from './contextStore'

const store = () => useOrchestraStore.getState()
const contextFile = (id: string) => `C:\\Temp\\alethe-orchestra\\context-${id}.md`

/** The `--append-system-prompt` value of the n-th spawned agent. */
function promptOf(call: number): string {
  const args = mocks.spawnPty.mock.calls[call][0].extraArgs ?? []
  return args[args.indexOf('--append-system-prompt') + 1]
}

function vaultAnswers() {
  vi.mocked(obsidianSearch).mockResolvedValue({
    total: 1,
    hits: [
      {
        filename: 'Ferramentas/Interface embaralhando no Alethe.md',
        score: -9,
        match_count: 3,
        contexts: [],
      },
    ],
  })
  vi.mocked(obsidianRead).mockImplementation(async (_target, path) => ({
    path,
    content: '## Causas\n- O terminal desenha numa largura e o xterm exibe noutra.',
    size: 70,
    truncated: false,
  }))
  vi.mocked(obsidianList).mockResolvedValue([])
  vi.mocked(obsidianWriteContext).mockImplementation(async (id) => contextFile(id))
}

function vaultClosed() {
  const down = () => Promise.reject('Obsidian is not reachable (is the app open?)')
  vi.mocked(obsidianSearch).mockImplementation(down)
  vi.mocked(obsidianRead).mockImplementation(down)
  vi.mocked(obsidianList).mockImplementation(down)
}

describe('agent prompts and the Obsidian context', () => {
  beforeEach(() => {
    mocks.spawnPty.mockClear()
    vi.mocked(obsidianSearch).mockReset()
    vi.mocked(obsidianRead).mockReset()
    vi.mocked(obsidianList).mockReset()
    vi.mocked(obsidianAppend).mockClear()
    vi.mocked(obsidianWriteContext).mockClear()
    vi.mocked(obsidianRemoveContext).mockClear()
    useScribeConfig.getState().update({ enabled: true, vaultPath: 'G:\\Vault' })
  })

  afterEach(async () => {
    await store().stopAll()
    useScribeConfig.getState().update({ ...DEFAULT_SCRIBE_CONFIG })
    localStorage.clear()
  })

  it('tells the orchestrator to read the context file before splitting the work', async () => {
    vaultAnswers()
    writeCreativeEnabled(true)
    const id = (await store().start('C:/repo/alethe', 'Corrigir o terminal', true))!

    const prompt = promptOf(0)
    expect(prompt).toContain(
      `saved a summary to "C:/Temp/alethe-orchestra/context-${id}.md". Read that file before you split the work`,
    )
    expect(prompt).toContain('before you start, consult Obsidian')
    expect(prompt).toContain('Creative agent, on for this session')
    expect(prompt).toContain('Session goal: Corrigir o terminal.')
    // The file exists before the orchestrator starts.
    expect(vi.mocked(obsidianWriteContext).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawnPty.mock.invocationCallOrder[0],
    )
    expect(sessionContextOf(id)).toMatchObject({ status: 'ready', file: contextFile(id) })
  })

  it('leaves the creative agent out when it is off', async () => {
    vaultAnswers()
    writeCreativeEnabled(false)
    await store().start('C:/repo/alethe', 'Corrigir o terminal', true)
    expect(promptOf(0)).toContain('Read that file before you split the work')
    expect(promptOf(0)).not.toContain('Creative agent')
  })

  it('gives workers the context file too', async () => {
    vaultAnswers()
    const id = (await store().start('C:/repo/alethe', 'Corrigir o terminal', true))!
    mocks.bus.handler?.({
      kind: 'spawn',
      session: id,
      at: 1,
      id: 'claude-1',
      area: 'terminal',
      task: 'fix it',
      after: [],
    })
    await vi.waitFor(() => expect(mocks.spawnPty).toHaveBeenCalledTimes(2))
    expect(promptOf(1)).toContain(
      `The Obsidian context of this session (the session note and related notes, gathered when it started) is in "C:/Temp/alethe-orchestra/context-${id}.md": read it before you start.`,
    )
  })

  it('keeps the consulted notes as session material, writes nothing raw, removes the file on stop', async () => {
    vaultAnswers()
    const id = (await store().start('C:/repo/alethe', 'Corrigir o terminal', true))!
    await vi.waitFor(
      () =>
        expect(
          vi
            .mocked(scribeMaterialAppend)
            .mock.calls.flatMap((call) => call[1])
            .join('\n'),
        ).toContain('Notas consultadas no início: [['),
      { timeout: 4_000 },
    )
    const material = vi
      .mocked(scribeMaterialAppend)
      .mock.calls.flatMap((call) => call[1])
      .join('\n')
    expect(material).toContain('[[Interface embaralhando no Alethe]]')
    // The old start block is gone: nothing is appended to the vault when a session starts.
    expect(obsidianAppend).not.toHaveBeenCalled()
    await store().stop(id)
    expect(obsidianRemoveContext).toHaveBeenCalledWith(id)
    expect(sessionContextOf(id)).toBeNull()
  })

  it('starts normally without Obsidian and asks the orchestrator to consult it itself', async () => {
    vaultClosed()
    const id = await store().start('C:/repo/alethe', 'Corrigir o terminal', true)
    expect(id).toMatch(/^o[a-z0-9]{7}$/)
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1)
    expect(promptOf(0)).toContain(
      'Alethe Orchestra could not consult Obsidian when this session started',
    )
    expect(sessionContextOf(id!)).toMatchObject({ status: 'failed', failure: 'unreachable' })
    expect(obsidianWriteContext).not.toHaveBeenCalled()
  })

  it('says nothing about a context file when consulting is off', async () => {
    vaultAnswers()
    useScribeConfig.getState().update({ consultContext: false })
    await store().start('C:/repo/alethe', 'Corrigir o terminal', true)
    expect(promptOf(0)).not.toContain('Obsidian context')
    expect(promptOf(0)).not.toContain('consult Obsidian')
    expect(obsidianSearch).not.toHaveBeenCalled()
  })
})
