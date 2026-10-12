import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from './lib/types'

// The shell is what this suite exercises; every heavy child is a stub. The workspace
// stub renders panes far wider than the window, the worst case for the old layout.
const tauri = vi.hoisted(() => ({
  projectsFile: null as string | null,
  recordAppEvent: vi.fn(async (_kind: string, _message: string) => {}),
}))

vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.doMock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.doMock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn(async () => {}) }),
}))
vi.doMock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setIcon: vi.fn(async () => {}) }),
}))
vi.doMock('./lib/tauri', () => ({
  listProfiles: vi.fn(async () => ({ active_profile_id: 'default', profiles: [] })),
  loadProjectsFile: vi.fn(async () => tauri.projectsFile),
  saveProjectsFile: vi.fn(async () => {}),
  recordAppEvent: tauri.recordAppEvent,
  recordFrontendError: vi.fn(async () => {}),
  ghosttyKillAll: vi.fn(async () => {}),
  setWindowOpacity: vi.fn(async () => {}),
  getLastCrashReport: vi.fn(async () => null),
}))
vi.doMock('./lib/terminalFactory', () => ({
  getProjectDefaultCwd: () => '',
  getProjectRepoRoot: () => '',
  resolveTerminalCwd: () => '',
  touchTerminalUsage: (t: unknown) => t,
}))
vi.doMock('./lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))
vi.doMock('./lib/claudeAccounts', () => ({ primeAccountBase: vi.fn(async () => {}) }))
vi.doMock('./lib/legacyImport', () => ({
  runLegacyImport: vi.fn(async () => null),
  toastLegacyImport: vi.fn(),
  toastLegacyImportError: vi.fn(),
}))
vi.doMock('./lib/activityTracker', () => ({ startActivityTracker: () => () => {} }))
vi.doMock('./lib/themeIcons', () => ({ loadThemeIconBytes: vi.fn(async () => new Uint8Array()) }))
vi.doMock('./lib/updater', () => ({ checkForUpdate: vi.fn(async () => null) }))
vi.doMock('./lib/spawnQueue', () => ({ setMaxConcurrentSpawns: vi.fn() }))
for (const hook of [
  'useCliOpenRequests',
  'useCloseConfirmation',
  'useDiscordPresence',
  'useKeybindings',
  'useMcpIntroPrompt',
  'useRemoteControlService',
  'useResourceSupervisor',
]) {
  vi.doMock(`./hooks/${hook}`, () => ({ [hook]: () => {} }))
}

const stub = (name: string) => () => ({ [name]: () => null })
vi.doMock('./components/ui/ascii-effect', stub('AsciiEffect'))
vi.doMock('./components/AgentSandbox', stub('AgentSandbox'))
vi.doMock('./components/AgentCanvasPOC', stub('AgentCanvasPOC'))
vi.doMock('./components/HomeView', stub('HomeView'))
vi.doMock('./components/DictationButton', stub('DictationButton'))
vi.doMock('./components/FocusOverlay', stub('FocusOverlay'))
vi.doMock('./components/LinkViewerOverlay', stub('LinkViewerOverlay'))
vi.doMock('./components/MainMenu', stub('MainMenu'))
vi.doMock('./components/TitleBar', stub('TitleBar'))
vi.doMock('./components/TokenHud', stub('TokenHud'))
vi.doMock('./components/ProjectSidebar', stub('ProjectSidebar'))
vi.doMock('./components/icons/AgentIcons', stub('AgentIcon'))
vi.doMock('./components/RightSidebar', () => ({
  RightSidebar: () => <aside data-testid="right-sidebar">monitor</aside>,
}))
vi.doMock('./components/WorkspaceView', () => ({
  WorkspaceView: () => (
    <div data-testid="workspace">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} style={{ minWidth: 900 }} />
      ))}
    </div>
  ),
}))
vi.doMock('./components/Orchestra', () => ({
  OrchestraView: () => <div data-testid="orchestra" />,
}))
for (const modal of [
  'AddBrowserModal',
  'AddContentModal',
  'AiUsageModal',
  'EditGroupModal',
  'EditProjectModal',
  'FindJumpModal',
  'HandoffModal',
  'McpIntroModal',
  'McpManagerModal',
  'NewGroupModal',
  'NewProjectModal',
  'NewSubTabModal',
  'NewTerminalModal',
  'OnboardingModal',
  'PreferencesModal',
  'ClaudeAccountsModal',
  'ProfilesModal',
  'RecentChatsModal',
  'RemoteControlModal',
  'SuspendGroupModal',
  'SyncModal',
  'ThemePickerModal',
  'TodoSettingsModal',
  'TopbarSettingsModal',
  'UpdateModal',
  'WelcomeModal',
  'WhatsNewModal',
  'LayoutDesignerModal',
  'MemoryAnalyticsModal',
]) {
  vi.doMock(`./components/modals/${modal}`, () => ({ [modal]: () => null }))
}

// jsdom has no ResizeObserver; react-resizable-panels needs one to register the group.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const { default: App } = await import('./App')
const { useProjectsStore } = await import('./stores/projectsStore')
const { useUiStore } = await import('./stores/uiStore')

function persisted(preferences: Partial<Preferences>): string {
  return JSON.stringify({
    version: 1,
    groups: [],
    ungroupedOrder: [],
    projects: [],
    preferences,
  })
}

async function renderShell(preferences: Partial<Preferences> = {}) {
  tauri.projectsFile = persisted({
    rightSidebarVisible: true,
    rightSidebarWidth: 300,
    leftSidebarVisible: true,
    leftSidebarWidth: 286,
    ...preferences,
  })
  render(<App />)
  await screen.findByTestId('right-sidebar')
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
}

function expectSidebarOnScreen() {
  const sidebar = screen.getByTestId('right-sidebar')
  expect(sidebar).toBeInTheDocument()
  const panel = sidebar.closest('[data-panel]')
  expect(panel).not.toBeNull()
  expect(panel?.querySelector('[data-hidden="true"]')).toBeNull()
  expect(useProjectsStore.getState().preferences.rightSidebarVisible).toBe(true)
}

describe('right sidebar never disappears on its own', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    tauri.recordAppEvent.mockClear()
    useProjectsStore.setState({ hydrated: false })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('stays mounted after hydrate', async () => {
    await renderShell()
    await settle()
    expectSidebarOnScreen()
  })

  it('stays mounted when every optional feature (todo, MCP, Git on the right) is off', async () => {
    await renderShell({
      enabledFeatures: { todos: false, git: false, mcp: false } as Preferences['enabledFeatures'],
    })
    await settle()
    expectSidebarOnScreen()
  })

  it('stays mounted after a second hydrate and a legacy re-sync', async () => {
    await renderShell()
    await act(async () => {
      await useProjectsStore.getState().hydrate()
    })
    await act(async () => {
      const state = useProjectsStore.getState()
      useProjectsStore.setState({
        projects: [...state.projects],
        preferences: { ...state.preferences, claudeAccounts: [] },
      })
    })
    await settle()
    expectSidebarOnScreen()
  })

  it('stays mounted with N wide panes and side-by-side workspace tabs', async () => {
    await renderShell()
    await act(async () => {
      useUiStore.getState().setActiveView('workspace')
    })
    await settle()
    expect(screen.getByTestId('workspace').children).toHaveLength(6)
    expectSidebarOnScreen()
  })

  it('stays mounted in the orchestra view and after leaving it', async () => {
    await renderShell()
    await act(async () => {
      useUiStore.getState().setActiveView('orchestra')
    })
    await screen.findByTestId('orchestra')
    await settle()
    expectSidebarOnScreen()
    await act(async () => {
      useUiStore.getState().setActiveView('workspace')
    })
    await settle()
    expectSidebarOnScreen()
  })

  it('survives a window resize below the room for both sidebars', async () => {
    await renderShell()
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 })
      window.dispatchEvent(new Event('resize'))
    })
    await settle()
    expectSidebarOnScreen()
  })

  it('hides only through the close action, and logs why', async () => {
    await renderShell()
    await act(async () => {
      useProjectsStore.getState().hideRightSidebar('user.close-button')
    })
    expect(screen.queryByTestId('right-sidebar')).toBeNull()
    expect(tauri.recordAppEvent).toHaveBeenCalledWith(
      'sidebar.right.hidden',
      'reason=user.close-button',
    )
    await act(async () => {
      useProjectsStore.getState().setPreferences({ rightSidebarVisible: true })
    })
    await screen.findByTestId('right-sidebar')
  })

  it('logs a hide that bypasses hideRightSidebar as reason=preferences', async () => {
    await renderShell()
    await act(async () => {
      useProjectsStore.getState().setPreferences({ rightSidebarVisible: false })
    })
    expect(tauri.recordAppEvent).toHaveBeenCalledWith('sidebar.right.hidden', 'reason=preferences')
  })
})
