import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  mirrors: new Set<string>(),
  alive: new Set<string>(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  open: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))

vi.mock('../../../lib/tauri', () => ({
  ptyExists: vi.fn((id: string) => Promise.resolve(fake.alive.has(id))),
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
  readClipboardPayload: vi.fn(() => Promise.resolve(null)),
  writeClipboardText: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../../../lib/terminalMirror', () => ({
  getMirror: (ptyId: string) =>
    fake.mirrors.has(ptyId) ? { ptyId, cols: 100, rows: 30, onChange: () => () => {} } : null,
  onMirrorRegistry: () => () => {},
  ensureMirror: vi.fn(),
  whenMirrorReady: vi.fn(() => Promise.resolve()),
  disposeMirror: vi.fn(),
}))

// The store installs the scribe on load; it must never reach a real vault.
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../XTermView', () => ({
  XTermView: (props: { ptyId: string }) => (
    <div data-testid={`classic-${props.ptyId}`}>
      <textarea className="xterm-helper-textarea" />
    </div>
  ),
}))

vi.mock('../../LiveTerminal', () => ({
  LiveTerminal: (props: { ptyId: string }) => (
    <div data-testid={`live-${props.ptyId}`} data-live-terminal={props.ptyId}>
      <textarea data-live-terminal-input="" />
    </div>
  ),
}))

import {
  type OrchestraAgent,
  type OrchestraSession,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Composer } from '../Composer'
import { EMPTY_DRAFT } from '../Composer/attachments'
import { OrchestraSessionProvider } from '../sessionContext'
import { SPINNER } from '../shared'
import { useTerminalModeStore } from '../terminalMode'
import { ConstellationView } from '../views/ConstellationView'
import { FlowView } from '../views/FlowView'
import { MissionControlView } from '../views/MissionControlView'
import { TerminalsView } from '../views/TerminalsView'

const ID = 'oa11y001'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'ui',
    task: `task of ${id}`,
    after: [],
    ptyId: `pty-${id}`,
    state: 'thinking',
    progress: 40,
    note: '',
    lines: [],
    files: [],
    toolCalls: 0,
    startedAt: Date.now() - 60_000,
    finishedAt: null,
    history: [],
    account: null,
    model: null,
    effort: null,
    ...patch,
  }
}

function session(
  agents: OrchestraAgent[],
  patch: Partial<OrchestraSession> = {},
): OrchestraSession {
  return {
    id: ID,
    projectId: null,
    cwd: 'C:/repo',
    goal: 'goal',
    autonomous: false,
    startedAt: Date.now() - 60_000,
    mode: 'mission',
    agents,
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
    ...patch,
  }
}

function renderIn(view: JSX.Element, agents: OrchestraAgent[], patch?: Partial<OrchestraSession>) {
  useOrchestraStore.setState({
    sessions: { [ID]: session(agents, patch) },
    order: [ID],
    activeId: ID,
  })
  return render(<OrchestraSessionProvider sessionId={ID}>{view}</OrchestraSessionProvider>)
}

const selectedId = () => useOrchestraStore.getState().sessions[ID]?.selectedId ?? null

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  useTerminalModeStore.setState({ mode: 'live' })
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  fake.alive.clear()
  fake.mirrors.clear()
})

afterEach(() => {
  useOrchestraStore.setState({ sessions: {}, order: [], activeId: null })
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Terminals pane shortcuts', () => {
  const team = () => [agent('orchestrator'), agent('claude-1'), agent('claude-2')]
  const input = (id: string) =>
    document.querySelector(`[data-pane-id="${id}"] [data-live-terminal-input]`) as HTMLElement

  beforeEach(() => {
    for (const a of team()) {
      fake.alive.add(a.ptyId!)
      fake.mirrors.add(a.ptyId!)
    }
  })

  it('Ctrl+Shift+N focuses the Nth worker and Ctrl+Shift+0 the orchestrator, even from a terminal', async () => {
    renderIn(<TerminalsView />, team(), { mode: 'terminals' })
    await screen.findByTestId('live-pty-claude-2')

    act(() => {
      fireEvent.keyDown(input('orchestrator'), {
        key: '@',
        code: 'Digit2',
        ctrlKey: true,
        shiftKey: true,
      })
    })
    await waitFor(() => expect(document.activeElement).toBe(input('claude-2')))
    expect(selectedId()).toBe('claude-2')

    act(() => {
      fireEvent.keyDown(input('claude-2'), {
        key: ')',
        code: 'Digit0',
        ctrlKey: true,
        shiftKey: true,
      })
    })
    await waitFor(() => expect(document.activeElement).toBe(input('orchestrator')))
    expect(selectedId()).toBe('orchestrator')
  })

  it('names the shortcut on each pane and ignores digits without a pane', async () => {
    renderIn(<TerminalsView />, team(), { mode: 'terminals' })
    await screen.findByTestId('live-pty-claude-1')
    expect(screen.getByTitle('Ctrl+Shift+1 focuses this terminal')).toHaveTextContent('claude-1')
    expect(screen.getByTitle('Ctrl+Shift+0 focuses this terminal')).toHaveTextContent(
      'orchestrator',
    )

    const event = new KeyboardEvent('keydown', {
      key: '(',
      code: 'Digit9',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('moves the orchestrator split from the keyboard', async () => {
    renderIn(<TerminalsView />, team(), { mode: 'terminals' })
    await screen.findByTestId('live-pty-claude-1')
    const split = screen.getByRole('separator', { name: 'Drag to resize, double-click to reset' })
    expect(split).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(split, { key: 'Home' })
    // jsdom has no layout: the split clamps to its 260 px minimum.
    expect(split).toHaveAttribute('aria-valuenow', '260')
    expect(localStorage.getItem('orchestra.terminals.split')).toBe('260')
  })
})

describe('Mission control cards', () => {
  const team = () => [
    agent('orchestrator'),
    agent('claude-1', { state: 'editing', progress: 40 }),
    agent('claude-2', { state: 'blocked', progress: 70, note: 'need a decision' }),
  ]

  it('opens a card from a real button that reads state and progress', () => {
    renderIn(<MissionControlView />, team())
    const open = screen.getByRole('button', { name: 'Open the terminal of claude-1' })
    expect(open).toHaveTextContent('claude-1')
    expect(open).toHaveAccessibleDescription(/40%/)
    expect(open.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2)
    fireEvent.click(open)
    expect(selectedId()).toBe('claude-1')
    expect(open).toHaveAttribute('aria-pressed', 'true')
  })

  it('never nests a control inside another one', () => {
    const { container } = renderIn(<MissionControlView />, team())
    expect(container.querySelectorAll('[role="button"] button, button button')).toHaveLength(0)
    const worker = screen.getByRole('button', { name: 'Open the terminal of claude-2' })
    expect(worker.closest('article')).not.toHaveAttribute('role')
    const orch = screen.getByRole('button', { name: 'Open the terminal of orchestrator' })
    expect(orch.closest('section')).not.toHaveAttribute('role')
    expect(orch).toHaveAccessibleDescription(/%/)
  })

  it('still opens from a click anywhere on the card', () => {
    renderIn(<MissionControlView />, team())
    const card = screen
      .getByRole('button', { name: 'Open the terminal of claude-1' })
      .closest('article')!
    fireEvent.click(within(card).getByText('task of claude-1'))
    expect(selectedId()).toBe('claude-1')
  })
})

describe('Flow nodes', () => {
  it('describe each node by its state and progress', () => {
    const { container } = renderIn(
      <FlowView />,
      [agent('orchestrator'), agent('claude-1', { state: 'editing', progress: 55 })],
      { mode: 'flow' },
    )
    // The canvas stays visibility:hidden until it measures itself, which jsdom never does, so
    // read the description through its ids instead of the computed accessible description.
    const description = (label: string) => {
      const node = container.querySelector(`[role="button"][aria-label="${label}"]`)
      const ids = node?.getAttribute('aria-describedby')?.split(' ') ?? []
      return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    }
    expect(description('Open the terminal of claude-1')).toMatch(/editing.*55%/)
    expect(description('Open the terminal of orchestrator')).toMatch(/%/)
  })
})

describe('Composer focus trap', () => {
  it('keeps Tab inside the dialog', () => {
    render(
      <Composer
        targets={[
          { id: 'orchestrator', live: true },
          { id: 'claude-1', live: true },
        ]}
        target="orchestrator"
        onTargetChange={() => {}}
        draft={EMPTY_DRAFT}
        onDraftChange={() => {}}
        onSend={() => {}}
        onClose={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog')
    const close = within(dialog).getByRole('button', { name: 'Close composer' })
    const text = within(dialog).getByRole('textbox')
    // Send is disabled while the draft is empty, so the text box is the last stop.
    text.focus()
    fireEvent.keyDown(text, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(text)
  })
})

describe('Constellation spinner', () => {
  const glyphs = () =>
    [...document.querySelectorAll('[data-spin]')].map((el) => el.textContent ?? '')

  it('turns while agents work', () => {
    vi.useFakeTimers()
    renderIn(<ConstellationView />, [agent('orchestrator'), agent('claude-1')], {
      mode: 'constellation',
    })
    expect(glyphs()[0]).toBe(SPINNER[0])
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(glyphs()[0]).not.toBe(SPINNER[0])
  })

  it('stays still when the system asks for reduced motion', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    )
    renderIn(<ConstellationView />, [agent('orchestrator'), agent('claude-1')], {
      mode: 'constellation',
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(glyphs().length).toBeGreaterThan(0)
    expect(new Set(glyphs())).toEqual(new Set([SPINNER[0]]))
  })
})
