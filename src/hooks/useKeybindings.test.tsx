import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  focusWorkspaceTerminal,
  navigateWorkspaceHistory,
  projectsState,
  requestPaneFocus,
  setActiveTerminal,
  setActiveView,
  uiState,
} = vi.hoisted(() => {
  const activateWorkspaceTab = vi.fn()
  const closePane = vi.fn()
  const focusWorkspaceTerminal = vi.fn()
  const navigateWorkspaceHistory = vi.fn()
  const openModal_ = vi.fn()
  const requestPaneFocus = vi.fn()
  const setActiveTerminal = vi.fn()
  const setActiveView = vi.fn()
  const setFullscreenContainer = vi.fn()
  const setPreferences = vi.fn()
  const setUiZoom = vi.fn()
  return {
    activateWorkspaceTab,
    closePane,
    focusWorkspaceTerminal,
    navigateWorkspaceHistory,
    openModal_,
    requestPaneFocus,
    setActiveTerminal,
    setActiveView,
    setFullscreenContainer,
    setPreferences,
    setUiZoom,
    projectsState: {
      activeProjectId: 'project-1',
      groups: [] as unknown[],
      preferences: {
        fullscreenContainerId: null as string | null,
        resourcePolicy: 'balanced',
        uiZoom: 1,
      },
      projects: [
        {
          id: 'project-1',
          terminals: [
            { disabled: false, id: 'pane-a', kind: 'terminal' },
            { disabled: false, id: 'pane-b', kind: 'terminal' },
          ],
        },
      ],
      workspace: {
        activeGroupId: null as string | null,
        activeTabId: null as string | null,
        containers: [] as unknown[],
        focusedTerminalId: 'pane-a' as string | null,
        tabs: [] as unknown[],
      },
      activateWorkspaceTab,
      closePane,
      focusWorkspaceTerminal,
      navigateWorkspaceHistory,
      setFullscreenContainer,
      setPreferences,
      setUiZoom,
    },
    uiState: {
      activeTerminal: null as { projectId: string; terminalId: string } | null,
      openModal: null as string | null,
      closeModal: vi.fn(),
      openModal_,
      pushToast: vi.fn(),
      requestPaneFocus,
      setActiveTerminal,
      setActiveView,
      toggleHome: vi.fn(),
    },
  }
})

vi.mock('../stores/projectsStore', () => ({
  MAX_RECENT_PROJECT_TABS: 10,
  UI_ZOOM_LIMITS: { max: 2, min: 0.5, step: 0.1 },
  selectActiveContainer: () => null,
  selectActiveProject: () => projectsState.projects[0],
  selectFirstWorkspaceTerminal: () => null,
  useProjectsStore: Object.assign(() => projectsState, { getState: () => projectsState }),
}))

vi.mock('../stores/uiStore', () => ({
  useUiStore: Object.assign(() => uiState, { getState: () => uiState }),
}))

import { useKeybindings } from './useKeybindings'

/** jsdom returns an all-zero box, which readPaneRects discards as unmounted. */
function stubRect(node: HTMLElement, left: number, right: number) {
  node.getBoundingClientRect = () =>
    ({
      bottom: 600,
      height: 600,
      left,
      right,
      toJSON: () => ({}),
      top: 0,
      width: right - left,
      x: left,
      y: 0,
    }) as DOMRect
}

function mountPanes() {
  const paneA = document.createElement('div')
  paneA.dataset.paneId = 'pane-a'
  paneA.dataset.paneProjectId = 'project-1'
  stubRect(paneA, 0, 400)

  const paneB = document.createElement('div')
  paneB.dataset.paneId = 'pane-b'
  paneB.dataset.paneProjectId = 'project-1'
  stubRect(paneB, 400, 800)

  document.body.append(paneA, paneB)
  return { paneA, paneB }
}

function dispatchKey(
  target: HTMLElement,
  init: KeyboardEventInit,
): { event: KeyboardEvent; stopPropagation: ReturnType<typeof vi.spyOn> } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  const stopPropagation = vi.spyOn(event, 'stopPropagation')
  target.dispatchEvent(event)
  return { event, stopPropagation }
}

describe('useKeybindings — Alt navigation from inside a terminal', () => {
  let editable: HTMLTextAreaElement

  beforeEach(() => {
    mountPanes()
    // xterm parks the focus on this helper textarea, so every pane move made
    // from a terminal arrives with a <textarea> as the event target.
    editable = document.createElement('textarea')
    editable.className = 'xterm-helper-textarea'
    document.body.append(editable)
    uiState.activeTerminal = null
    projectsState.workspace.focusedTerminalId = 'pane-a'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('moves the focus to the pane on the right even with the xterm textarea focused', () => {
    const { unmount } = renderHook(() => useKeybindings())

    dispatchKey(editable, { altKey: true, key: 'ArrowRight' })

    expect(focusWorkspaceTerminal).toHaveBeenCalledWith('project-1', 'pane-b')
    expect(setActiveTerminal).toHaveBeenCalledWith('project-1', 'pane-b')
    expect(requestPaneFocus).toHaveBeenCalledWith('pane-b')
    expect(setActiveView).toHaveBeenCalledWith('workspace')
    unmount()
  })

  it('stops propagation when there is a neighbour, so xterm does not write the escape sequence', () => {
    const { unmount } = renderHook(() => useKeybindings())

    const { stopPropagation } = dispatchKey(editable, { altKey: true, key: 'ArrowRight' })

    expect(stopPropagation).toHaveBeenCalled()
    unmount()
  })

  it('leaves the key alone when no pane sits that way', () => {
    const { unmount } = renderHook(() => useKeybindings())

    const { stopPropagation } = dispatchKey(editable, { altKey: true, key: 'ArrowLeft' })

    expect(focusWorkspaceTerminal).not.toHaveBeenCalled()
    expect(setActiveTerminal).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    unmount()
  })

  it('walks the workspace history on Alt+Shift+ArrowLeft from the xterm textarea', () => {
    const { unmount } = renderHook(() => useKeybindings())

    dispatchKey(editable, { altKey: true, key: 'ArrowLeft', shiftKey: true })

    expect(navigateWorkspaceHistory).toHaveBeenCalledWith(-1)
    expect(setActiveView).toHaveBeenCalledWith('workspace')
    unmount()
  })

  it('still ignores plain typing inside an editable field', () => {
    uiState.activeTerminal = { projectId: 'project-1', terminalId: 'pane-a' }
    const onRestart = vi.fn()
    window.addEventListener('alethe:terminal-restart-request', onRestart)
    const input = document.createElement('input')
    document.body.append(input)
    const { unmount } = renderHook(() => useKeybindings())

    dispatchKey(input, { key: 'r' })

    expect(onRestart).not.toHaveBeenCalled()
    window.removeEventListener('alethe:terminal-restart-request', onRestart)
    unmount()
  })
})
