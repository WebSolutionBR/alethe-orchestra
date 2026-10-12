import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachPty: vi.fn((_id: string, _max?: number) => Promise.resolve('')),
  manifests: [] as unknown[],
  missing: new Set<string>(),
  confirm: vi.fn((_message: string, _options?: unknown) => Promise.resolve(true)),
  pickDirectory: vi.fn(() => Promise.resolve(null as string | null)),
  orchestraManifestList: vi.fn(() => Promise.resolve(mocks.manifests)),
  orchestraManifestRemove: vi.fn((_id: string) => Promise.resolve()),
  orchestraFolderExists: vi.fn((path: string) => Promise.resolve(!mocks.missing.has(path))),
  orchestraEnd: vi.fn((_id: string) => Promise.resolve()),
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.confirm }))
vi.mock('../../../lib/dialog', () => ({ pickDirectory: mocks.pickDirectory }))
vi.mock('../../../lib/tauri', () => ({
  spawnPty: mocks.spawnPty,
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  listenPtyData: vi.fn(() => Promise.resolve(() => {})),
  listenPtyActivity: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
}))
vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: mocks.orchestraEnd,
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  orchestraResume: vi.fn(() => Promise.resolve()),
  orchestraFolderExists: mocks.orchestraFolderExists,
  orchestraWriteTask: vi.fn(() => Promise.reject(new Error('not in tests'))),
  orchestraManifestList: mocks.orchestraManifestList,
  orchestraManifestRemove: mocks.orchestraManifestRemove,
  orchestraManifestSave: vi.fn(() => Promise.resolve()),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('../../../lib/tauri/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/tauri/pty')>()),
  attachPty: mocks.attachPty,
}))
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))

vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

import type { OrchestraAgent } from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { InterruptedRecord } from './InterruptedRecord'
import { type OrchestraManifest, parseManifest } from './manifest'

function worker(patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id: 'claude-1',
    area: 'api',
    task: 'task',
    after: [],
    ptyId: 'orchestra-orec0001-claude-1-1',
    state: 'thinking',
    progress: 10,
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

function record(raw: Record<string, unknown>): OrchestraManifest {
  const parsed = parseManifest({
    version: 1,
    id: 'orec0001',
    savedAt: 2,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: false,
    startedAt: 1,
    mode: 'flow',
    agents: [worker()],
    messages: [],
    ...raw,
  })
  expect(parsed).not.toBeNull()
  return parsed!
}

const show = (manifest: OrchestraManifest) =>
  render(
    <InterruptedRecord
      manifest={manifest}
      missing={false}
      resuming={false}
      onResume={() => {}}
      onChooseFolder={() => {}}
      onClose={() => {}}
    />,
  )

// Drawn for 40 columns: "world" placed at column 30 of the first row.
const DRAWN_AT_40 = '\x1b[?1049h\x1b[2J\x1b[1;1Hhello\x1b[1;30Hworld\x1b[2;1Hsecond row'

describe('View record: the saved terminal of each agent', () => {
  beforeEach(() => {
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
    mocks.attachPty.mockImplementation(() => Promise.resolve(DRAWN_AT_40))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('replays the recorded output at the PTY size kept in the manifest', async () => {
    show(record({ ptySizes: { 'claude-1': { cols: 40, rows: 5 } } }))
    const summary = screen.getByText('Terminal transcript (40×5)')
    expect(mocks.attachPty).not.toHaveBeenCalled()
    const details = summary.closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() =>
      expect(mocks.attachPty).toHaveBeenCalledWith(
        'orchestra-orec0001-claude-1-1',
        expect.any(Number),
      ),
    )
    const text = await waitFor(() => {
      const pre = details.querySelector('pre')
      expect(pre).not.toBeNull()
      return pre!.textContent!
    })
    // At the width it was drawn, the row reads as it did on screen.
    expect(text.split('\n')).toEqual([`hello${' '.repeat(24)}world`, 'second row'])
  })

  it('says when the size was not recorded and which one it used', async () => {
    show(record({}))
    expect(
      screen.getByText('Terminal transcript (size not recorded, shown at 100×30)'),
    ).toBeInTheDocument()
  })

  it('says so when nothing was saved', async () => {
    mocks.attachPty.mockImplementation(() => Promise.resolve(''))
    show(record({ ptySizes: { 'claude-1': { cols: 40, rows: 5 } } }))
    const details = screen.getByText('Terminal transcript (40×5)').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(await screen.findByText('Nothing was saved from this terminal.')).toBeInTheDocument()
  })
})
