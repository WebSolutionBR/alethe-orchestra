import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  open: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../../lib/dialog', () => ({ pickDirectory: vi.fn(() => Promise.resolve(null)) }))

vi.mock('../../../lib/tauri', () => ({
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

// The store installs the scribe on load; it must never reach a real vault.
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))

// Account, model and effort pickers read live account data; not under test here.
vi.mock('../usage/LaunchOptions', () => ({ LaunchOptionsPicker: () => null }))

import { pickDirectory } from '../../../lib/dialog'
import type { Project, Terminal } from '../../../lib/types'
import { ORCHESTRATOR_ID, useOrchestraStore } from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { projectCwdKey } from './folder'
import { OrchestraStart } from './OrchestraStart'
import { goalDraftKey } from './prefs'

const originalStart = useOrchestraStore.getState().start
const originalSelect = useOrchestraStore.getState().select
const start = vi.fn(async () => 'osess001' as string | null)
const select = vi.fn()

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id.toUpperCase(),
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 0,
    ...extra,
  } as Project
}

function withProjects(projects: Project[], activeProjectId: string | null, language = 'en') {
  useProjectsStore.setState((s) => ({
    projects,
    activeProjectId,
    setActiveProjectOnly: vi.fn(),
    preferences: { ...s.preferences, language: language as 'en' | 'pt-BR' },
  }))
}

const startButton = () => screen.getByRole('button', { name: 'Start orchestra' })

beforeEach(() => {
  useOrchestraStore.setState({ start, select, lastAutonomous: true, error: null })
  start.mockClear()
  select.mockClear()
})

afterEach(() => {
  useOrchestraStore.setState({ start: originalStart, select: originalSelect })
  localStorage.clear()
})

describe('OrchestraStart', () => {
  it('always opens autonomous, with an accessible switch and the risk spelled out', () => {
    // A supervised orchestration started earlier in this run does not change the default.
    useOrchestraStore.setState({ lastAutonomous: false })
    withProjects([project('a', { defaultCwd: 'C:/repo/a' })], 'a')
    render(<OrchestraStart />)
    const mode = screen.getByRole('group', { name: 'Mode' })
    const autonomous = within(mode).getByRole('switch', { name: 'Autonomous mode' })
    expect(autonomous).toHaveAttribute('aria-checked', 'true')
    expect(autonomous).toHaveAccessibleDescription(/--dangerously-skip-permissions/)
    expect(within(mode).getByRole('switch', { name: 'Creative agent' })).toBeInTheDocument()
    // Alerts are on by default and remembered when turned off.
    const alerts = within(mode).getByRole('switch', { name: 'Alerts' })
    expect(alerts).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(alerts)
    expect(localStorage.getItem('orchestra.attention.alerts')).toBe('0')
    expect(alerts).toHaveAccessibleDescription(/only the counter/)

    fireEvent.click(autonomous)
    expect(autonomous).toHaveAttribute('aria-checked', 'false')
    expect(autonomous).toHaveAccessibleDescription(/ask before editing/)
  })

  it('offers a new project and explains the disabled start when there are no projects', () => {
    const openModal = vi.fn()
    const restore = useUiStore.getState().openModal_
    useUiStore.setState({ openModal_: openModal })
    withProjects([], null)
    render(<OrchestraStart />)
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(openModal).toHaveBeenCalledWith('newProject')
    expect(startButton()).toBeDisabled()
    expect(startButton()).toHaveAccessibleDescription(/Create a project first/)
    useUiStore.setState({ openModal_: restore })
  })

  it('explains a missing folder and labels folderless projects briefly', () => {
    withProjects([project('a'), project('b', { defaultCwd: 'C:/repo/b' })], 'a')
    render(<OrchestraStart />)
    expect(startButton()).toBeDisabled()
    expect(startButton()).toHaveAccessibleDescription('Choose the folder the agents will work in.')
    expect(screen.getByRole('radio', { name: /^A/ })).toHaveTextContent('no folder yet')
  })

  it('says whose folder a project borrows', () => {
    const lender = project('lender', {
      groupId: 'g',
      terminals: [
        {
          id: 't',
          name: 't',
          cwd: 'C:/lender',
          tabs: [],
          activeTabId: '',
          disabled: false,
          laneVisible: null,
        } as unknown as Terminal,
      ],
    })
    withProjects([project('a', { groupId: 'g' }), lender], 'a')
    render(<OrchestraStart />)
    expect(screen.getByText('borrowed from LENDER')).toBeInTheDocument()
    expect(screen.getByText(/borrows one from another project of its group/)).toBeInTheDocument()
    expect(startButton()).toBeEnabled()
  })

  it('uses a picked folder over the project folder and goes back on request', async () => {
    vi.mocked(pickDirectory).mockResolvedValueOnce('D:/picked')
    withProjects([project('a', { defaultCwd: 'C:/repo/a' })], 'a')
    render(<OrchestraStart />)
    expect(screen.getByText('project folder')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Other folder' }))
    })
    expect(localStorage.getItem(projectCwdKey('a'))).toBe('D:/picked')
    expect(screen.getByText('picked here')).toBeInTheDocument()
    expect(screen.getAllByText('D:/picked').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Back to the project folder' }))
    expect(localStorage.getItem(projectCwdKey('a'))).toBeNull()
    expect(screen.getByText('project folder')).toBeInTheDocument()
  })

  it('keeps the goal draft of each project until it starts', async () => {
    withProjects([project('a', { defaultCwd: 'C:/repo/a' })], 'a')
    const first = render(<OrchestraStart />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), {
      target: { value: 'ship the scribe' },
    })
    expect(localStorage.getItem(goalDraftKey('a'))).toBe('ship the scribe')
    first.unmount()

    render(<OrchestraStart />)
    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue('ship the scribe')
    await act(async () => {
      fireEvent.click(startButton())
    })
    expect(start).toHaveBeenCalledWith('C:/repo/a', 'ship the scribe', true, 'a')
    expect(localStorage.getItem(goalDraftKey('a'))).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('opens the orchestrator terminal when started without a goal', async () => {
    withProjects([project('a', { defaultCwd: 'C:/repo/a' })], 'a')
    render(<OrchestraStart />)
    expect(screen.getByText(/the orchestrator terminal opens/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(startButton())
    })
    expect(start).toHaveBeenCalledWith('C:/repo/a', '', true, 'a')
    expect(select).toHaveBeenCalledWith('osess001', ORCHESTRATOR_ID)
  })

  it('speaks Portuguese', () => {
    withProjects([], null, 'pt-BR')
    render(<OrchestraStart />)
    expect(screen.getByRole('group', { name: 'Modo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Novo projeto' })).toBeInTheDocument()
  })
})
