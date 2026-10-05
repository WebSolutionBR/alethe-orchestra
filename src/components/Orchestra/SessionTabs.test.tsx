import { confirm } from '@tauri-apps/plugin-dialog'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../lib/tauri', () => ({
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() =>
    Promise.resolve({
      endpoint: 'http://127.0.0.1:1',
      token: 't',
      settings_path: 's.json',
      cli_path: 'orch.cmd',
      path_env: '',
    }),
  ),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

import type { Project } from '../../lib/types'
import { useOrchestraStore } from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { SessionTabs } from './SessionTabs'

const orchestra = () => useOrchestraStore.getState()
// The real action also persists projects.json; the sidebar only needs the active project.
const setActiveProjectOnly = vi.fn((id: string | null) =>
  useProjectsStore.setState({ activeProjectId: id }),
)

async function startIn(projectId: string): Promise<string> {
  let id: string | null = null
  await act(async () => {
    id = await orchestra().start(`C:/${projectId}`, `ship ${projectId}`, true, projectId)
  })
  return id!
}

describe('SessionTabs', () => {
  beforeEach(() => {
    useProjectsStore.setState((s) => ({
      projects: [
        { id: 'ia', name: 'IA' },
        { id: 'opala', name: 'Opala' },
      ] as Project[],
      activeProjectId: 'opala',
      setActiveProjectOnly,
      preferences: { ...s.preferences, language: 'en' },
    }))
  })

  afterEach(async () => {
    await act(() => orchestra().stopAll())
    setActiveProjectOnly.mockClear()
    vi.mocked(confirm).mockClear()
  })

  it('shows every orchestration and selects the clicked one with its project', async () => {
    const ia = await startIn('ia')
    const opala = await startIn('opala')
    render(<SessionTabs />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(screen.getByRole('tab', { name: /^Opala/ })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: /^IA/ }))
    expect(orchestra().activeId).toBe(ia)
    expect(setActiveProjectOnly).toHaveBeenLastCalledWith('ia')
    expect(screen.getByRole('tab', { name: /^IA/ })).toHaveAttribute('aria-selected', 'true')

    // Alt+PageDown moves to the next tab, and its project follows too.
    fireEvent.keyDown(window, { key: 'PageDown', altKey: true })
    expect(orchestra().activeId).toBe(opala)
    expect(setActiveProjectOnly).toHaveBeenLastCalledWith('opala')
  })

  it('opens the start screen with + and offers the split only for two orchestrations', async () => {
    await startIn('ia')
    render(<SessionTabs />)
    const split = screen.getByRole('button', { name: /side by side/i })
    expect(split).toBeDisabled()

    const opala = await startIn('opala')
    expect(split).toBeEnabled()
    fireEvent.click(split)
    expect(orchestra().splitId).not.toBeNull()
    expect(split).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /new orchestration/i }))
    expect(orchestra().activeId).toBeNull()
    expect(orchestra().order).toContain(opala)
  })

  it('stops a running orchestration from its tab and closes it only once stopped', async () => {
    const ia = await startIn('ia')
    const opala = await startIn('opala')
    render(<SessionTabs />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop orchestration IA' }))
    // The top bar's question, then the agents end and the session stays, read-only.
    await waitFor(() => expect(orchestra().sessions[ia]?.stoppedAt).toBeTruthy())
    expect(vi.mocked(confirm)).toHaveBeenLastCalledWith(
      expect.stringContaining('Goal: ship ia'),
      expect.objectContaining({
        title: 'Stop the orchestration IA?',
        okLabel: 'Stop orchestration',
        cancelLabel: 'Cancel',
      }),
    )
    expect(orchestra().order).toEqual([ia, opala])
    expect(screen.getAllByRole('tab')).toHaveLength(2)

    fireEvent.click(await screen.findByRole('button', { name: 'Close orchestration IA' }))
    await waitFor(() => expect(orchestra().order).toEqual([opala]))
    expect(vi.mocked(confirm)).toHaveBeenLastCalledWith(
      expect.stringContaining('report and transcripts'),
      expect.objectContaining({
        title: 'Close the orchestration IA?',
        okLabel: 'Close orchestration',
      }),
    )
    expect(orchestra().sessions[ia]).toBeUndefined()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('never removes a running orchestration with Delete or a middle click', async () => {
    const ia = await startIn('ia')
    const opala = await startIn('opala')
    render(<SessionTabs />)
    const iaTab = screen.getByRole('tab', { name: /^IA/ })

    vi.mocked(confirm).mockResolvedValueOnce(false)
    fireEvent.keyDown(iaTab, { key: 'Delete' })
    await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1))
    await act(() => Promise.resolve())
    expect(orchestra().sessions[ia]?.stoppedAt).toBeFalsy()

    fireEvent.keyDown(iaTab, { key: 'Delete' })
    await waitFor(() => expect(orchestra().sessions[ia]?.stoppedAt).toBeTruthy())

    const opalaTab = screen.getByRole('tab', { name: /^Opala/ })
    fireEvent(opalaTab, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    await waitFor(() => expect(orchestra().sessions[opala]?.stoppedAt).toBeTruthy())
    expect(orchestra().order).toEqual([ia, opala])
  })
})
