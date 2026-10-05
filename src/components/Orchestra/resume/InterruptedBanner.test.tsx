import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
vi.mock('../../../lib/terminalMirror', () => ({
  ensureMirror: vi.fn(() => ({})),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
  getMirror: vi.fn(() => null),
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
import { useInterrupted } from './interrupted'
import { InterruptedBanner } from './InterruptedBanner'
import { manifestOf } from './manifest'

const FOLDER = 'C:\\Users\\me\\Opala'
const conv = (id: string) =>
  `00000000-0000-4000-8000-${String(id === 'orchestrator' ? 0 : Number(id.split('-')[1])).padStart(12, '0')}`

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'reader',
    task: `task of ${id}`,
    after: [],
    ptyId: null,
    state: 'thinking',
    progress: 50,
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
    claudeSessionId: conv(id),
    transcriptPath: null,
    ...patch,
  }
}

function saved(id: string, goal: string, agents: OrchestraAgent[], autonomous = true) {
  const session: OrchestraSession = {
    id,
    projectId: null,
    cwd: FOLDER,
    goal,
    autonomous,
    startedAt: Date.UTC(2026, 9, 4, 20, 0),
    mode: 'constellation',
    agents,
    messages: [
      {
        id: 1,
        at: Date.UTC(2026, 9, 4, 20, 5),
        from: 'claude-1',
        to: 'orchestrator',
        text: 'done · parser',
      },
    ],
    segments: [],
    selectedId: null,
    error: null,
  }
  return JSON.parse(JSON.stringify(manifestOf(session, Date.UTC(2026, 9, 4, 21, 40))))
}

const opala = (autonomous = true) =>
  saved(
    'oopala01',
    'Leitor de Markdown',
    [
      agent('orchestrator', { state: 'idle' }),
      agent('claude-1', { state: 'done', progress: 100, note: 'parser pronto' }),
      agent('claude-2', { state: 'editing' }),
      agent('claude-3', { state: 'idle', claudeSessionId: null }),
      agent('claude-4', { state: 'waiting', after: ['claude-2'] }),
      agent('claude-5', { state: 'exited' }),
    ],
    autonomous,
  )

const flags = globalThis as { isTauri?: boolean }

function stubResume(result: string | null) {
  const original = useOrchestraStore.getState().resume
  const resume = vi.fn((_manifest: unknown, _options?: { cwd?: string }) => Promise.resolve(result))
  useOrchestraStore.setState({ resume })
  return { resume, restore: () => useOrchestraStore.setState({ resume: original }) }
}

beforeEach(() => {
  flags.isTauri = true
  mocks.manifests = [opala()]
  mocks.missing.clear()
  useInterrupted.setState({ manifests: [], damaged: [], folders: {}, loaded: false })
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  vi.clearAllMocks()
  mocks.confirm.mockImplementation(() => Promise.resolve(true))
  mocks.pickDirectory.mockImplementation(() => Promise.resolve(null))
})

afterEach(() => {
  delete flags.isTauri
})

describe('interrupted orchestration strip', () => {
  it('offers each orchestration the app was closed on, with its folder and mode', async () => {
    render(<InterruptedBanner />)
    const region = await screen.findByRole('region', { name: 'Interrupted orchestrations' })
    expect(within(region).getByText('Interrupted orchestration')).toBeTruthy()
    const meta = within(region).getByText(/Leitor de Markdown/)
    expect(meta.textContent).toContain('Opala · “Leitor de Markdown”')
    expect(meta.textContent).toContain('5 workers (1 done, 1 failed)')
    expect(within(region).getByText(`Folder: ${FOLDER} · autonomous`)).toBeTruthy()
    expect(mocks.spawnPty).not.toHaveBeenCalled()
  })

  it('shows nothing when there is nothing to resume, or it runs already', async () => {
    mocks.manifests = [opala(), { garbage: true }]
    // Loaded with the sessions this run has: the one running now is no longer interrupted.
    await useInterrupted.getState().load(['oopala01'])
    const { container } = render(<InterruptedBanner />)
    expect(container.innerHTML).toBe('')
    expect(mocks.orchestraManifestList).toHaveBeenCalledTimes(1)
  })

  it('reads the record without starting anything', async () => {
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /View record/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Record of "Opala"' })
    expect(within(dialog).getByText(/Read-only/)).toBeTruthy()
    expect(within(dialog).getByText('Leitor de Markdown')).toBeTruthy()
    expect(within(dialog).getByText('parser pronto')).toBeTruthy()
    expect(within(dialog).getAllByText('Resumes its conversation')).toHaveLength(2)
    expect(within(dialog).getByText('No saved conversation: starts its task again')).toBeTruthy()
    expect(within(dialog).getByText('Waits for claude-2')).toBeTruthy()
    expect(within(dialog).getByText('Finished')).toBeTruthy()
    expect(within(dialog).getByText(/Failed before the close: not relaunched/)).toBeTruthy()
    expect(within(dialog).getByText('done · parser')).toBeTruthy()
    expect(mocks.spawnPty).not.toHaveBeenCalled()
    // The footer's Close (the header has an × with the same name).
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks before resuming an autonomous orchestration, then resumes it in its folder', async () => {
    const { resume, restore } = stubResume('oopala01')
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /^Resume/ }))
    await waitFor(() => expect(resume).toHaveBeenCalled())
    const [message, options] = mocks.confirm.mock.calls[0]
    expect(message).toContain(`will run in ${FOLDER} without asking before acting`)
    expect(options).toMatchObject({ title: 'Resume in autonomous mode?', okLabel: 'Resume' })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id: 'oopala01' }), undefined)
    await waitFor(() => expect(useInterrupted.getState().manifests).toHaveLength(0))
    restore()
  })

  it('does not resume an autonomous orchestration the user declined', async () => {
    mocks.confirm.mockImplementation(() => Promise.resolve(false))
    const { resume, restore } = stubResume('oopala01')
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /^Resume/ }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(resume).not.toHaveBeenCalled()
    expect(useInterrupted.getState().manifests).toHaveLength(1)
    restore()
  })

  it('resumes a supervised orchestration without asking', async () => {
    mocks.manifests = [opala(false)]
    const { resume, restore } = stubResume('oopala01')
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /^Resume/ }))
    await waitFor(() => expect(resume).toHaveBeenCalled())
    expect(mocks.confirm).not.toHaveBeenCalled()
    restore()
  })

  it('keeps the strip when the resume fails', async () => {
    const { resume, restore } = stubResume(null)
    render(<InterruptedBanner />)
    const button = await screen.findByRole('button', { name: /^Resume/ })
    fireEvent.click(button)
    await waitFor(() => expect(resume).toHaveBeenCalled())
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    expect(useInterrupted.getState().manifests).toHaveLength(1)
    expect(screen.getByRole('region')).toBeTruthy()
    restore()
  })

  it('never resumes when its folder is gone: it says so and offers to pick where it is', async () => {
    mocks.missing.add(FOLDER)
    const { resume, restore } = stubResume('oopala01')
    render(<InterruptedBanner />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(`Its folder no longer exists: ${FOLDER}`)
    expect(screen.queryByRole('button', { name: /^Resume/ })).toBeNull()
    // The user picks the folder's new place: it resumes there, after saying what changes.
    mocks.pickDirectory.mockImplementation(() => Promise.resolve('D:\\moved\\Opala'))
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(resume).toHaveBeenCalled())
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id: 'oopala01' }), {
      cwd: 'D:\\moved\\Opala',
    })
    expect(mocks.confirm.mock.calls[0][0]).toContain(
      'Resume "Opala" in D:\\moved\\Opala? Its agents start their tasks over there',
    )
    restore()
  })

  it('does nothing when no folder is picked', async () => {
    mocks.missing.add(FOLDER)
    const { resume, restore } = stubResume('oopala01')
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /Choose folder/ }))
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalled())
    expect(resume).not.toHaveBeenCalled()
    restore()
  })

  it('checks the folder again right before resuming', async () => {
    const { resume, restore } = stubResume('oopala01')
    render(<InterruptedBanner />)
    const button = await screen.findByRole('button', { name: /^Resume/ })
    // Gone after the strip appeared.
    mocks.missing.add(FOLDER)
    fireEvent.click(button)
    await screen.findByRole('alert')
    expect(resume).not.toHaveBeenCalled()
    restore()
  })

  it('discards after confirming: the record and its files go', async () => {
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /Discard/ }))
    await waitFor(() => expect(mocks.orchestraManifestRemove).toHaveBeenCalledWith('oopala01'))
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.stringContaining('"Opala"'),
      expect.objectContaining({ okLabel: 'Discard', cancelLabel: 'Cancel' }),
    )
    expect(mocks.orchestraEnd).toHaveBeenCalledWith('oopala01')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('keeps it when the discard is not confirmed', async () => {
    mocks.confirm.mockImplementation(() => Promise.resolve(false))
    render(<InterruptedBanner />)
    fireEvent.click(await screen.findByRole('button', { name: /Discard/ }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.orchestraManifestRemove).not.toHaveBeenCalled()
    expect(screen.getByRole('region')).toBeTruthy()
  })

  it('shows an unreadable record so it can be discarded instead of lingering', async () => {
    mocks.manifests = [{ id: 'obroken1', damaged: true }]
    render(<InterruptedBanner />)
    const region = await screen.findByRole('region', { name: 'Interrupted orchestrations' })
    expect(within(region).getByText('Unreadable orchestration record')).toBeTruthy()
    expect(within(region).queryByRole('button', { name: /^Resume/ })).toBeNull()
    fireEvent.click(within(region).getByRole('button', { name: /Discard/ }))
    await waitFor(() => expect(mocks.orchestraManifestRemove).toHaveBeenCalledWith('obroken1'))
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
  })
})
