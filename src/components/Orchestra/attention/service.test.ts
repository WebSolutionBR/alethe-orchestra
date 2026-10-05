import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import type { OrchestraAgent, OrchestraSession } from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { BATCH_MS, COOLDOWN_MS, installAttention } from './service'
import { useAttentionStore } from './store'

type Sessions = Record<string, OrchestraSession>

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'backend',
    task: '',
    after: [],
    ptyId: 'p',
    state: 'thinking',
    progress: 0,
    note: '',
    lines: [],
    files: [],
    toolCalls: 0,
    startedAt: 0,
    finishedAt: null,
    history: [],
    account: null,
    model: null,
    effort: null,
    exitCode: null,
    exitReason: null,
    blocked: null,
    ...patch,
  }
}

function sessionOf(id: string, agents: OrchestraAgent[], cwd = `C:/work/${id}`): OrchestraSession {
  return {
    id,
    projectId: null,
    cwd,
    goal: 'goal',
    autonomous: false,
    startedAt: 0,
    mode: 'constellation',
    agents,
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
  } as OrchestraSession
}

function harness(initial: Sessions) {
  let state = { sessions: initial }
  const listeners = new Set<(s: typeof state, p: typeof state) => void>()
  const taps = new Set<(e: OrchestraEvent) => void>()
  return {
    source: {
      getState: () => state,
      subscribe: (l: (s: typeof state, p: typeof state) => void) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      listen: (h: (e: OrchestraEvent) => void) => {
        taps.add(h)
        return () => void taps.delete(h)
      },
      shown: () => [] as string[],
    },
    set(sessions: Sessions) {
      const prev = state
      state = { sessions }
      for (const l of listeners) l(state, prev)
    },
    emit(agentId: string, hook: Record<string, unknown>, session = 's1') {
      const event: OrchestraEvent = {
        kind: 'hook',
        session,
        at: Date.now(),
        agent_id: agentId,
        hook,
      }
      for (const t of taps) t(event)
    },
  }
}

const ask = (text: string, at: number) => ({ reason: 'permission' as const, text, at })

let uninstall: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
  useAttentionStore.setState({ waiting: {}, last: {} })
})

afterEach(() => {
  uninstall?.()
  uninstall = null
  vi.useRealTimers()
})

function install(h: ReturnType<typeof harness>, deps: Record<string, unknown> = {}) {
  const notify = vi.fn()
  uninstall = installAttention(h.source, {
    notify,
    watching: () => false,
    alerts: () => true,
    isMainWindow: () => true,
    ...deps,
  })
  return notify
}

describe('installAttention', () => {
  it('announces an agent asking for permission, with the real question', () => {
    const h = harness({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    const notify = install(h)
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'blocked', blocked: ask('Allow Bash: cargo test?', 1) }),
      ]),
    })
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('claude-1 (backend) needs you', 'Allow Bash: cargo test?')
    expect(useAttentionStore.getState().last.s1?.text).toContain('Allow Bash: cargo test?')
  })

  it('groups what happens together into one notice', () => {
    const h = harness({
      s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1'), agent('claude-2')]),
    })
    const notify = install(h)
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'blocked', blocked: ask('Allow Edit?', 1) }),
        agent('claude-2', { state: 'exited', exitCode: 1, note: 'tests failed' }),
      ]),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledTimes(1)
    const [title, body] = notify.mock.calls[0]
    expect(title).toBe('2 things need you in the Orchestra')
    expect(body).toContain('claude-1 (backend) needs you')
    expect(body).toContain('claude-2 (backend) stopped before finishing')
  })

  it('says why an agent stopped', () => {
    const h = harness({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-2')]) })
    const notify = install(h)
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-2', { state: 'exited', exitCode: 1, note: 'tests failed' }),
      ]),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledWith(
      'claude-2 (backend) stopped before finishing',
      'Exited without reporting done (code 1) · tests failed',
    )
  })

  it('does not repeat the same agent within the cooldown', () => {
    const h = harness({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    const notify = install(h)
    const blockedWith = (text: string, at: number) =>
      sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'blocked', blocked: ask(text, at) }),
      ])
    h.set({ s1: blockedWith('Allow Edit?', 1) })
    vi.advanceTimersByTime(BATCH_MS)
    h.set({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    h.set({ s1: blockedWith('Allow Bash?', 2) })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(COOLDOWN_MS)
    h.set({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    h.set({ s1: blockedWith('Allow Write?', 3) })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenLastCalledWith('claude-1 (backend) needs you', 'Allow Write?')
  })

  it('stays silent with alerts off, but still announces to the live region', () => {
    const h = harness({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    const notify = install(h, { alerts: () => false })
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'blocked', blocked: ask('Allow Edit?', 1) }),
      ]),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().last.s1?.text).toContain('Allow Edit?')
  })

  it('does not notify what the user is already looking at', () => {
    const h = harness({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    const notify = install(h, { watching: (id: string) => id === 's1' })
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'blocked', blocked: ask('Allow Edit?', 1) }),
      ]),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).not.toHaveBeenCalled()
  })

  it('announces a finished orchestration', () => {
    const h = harness({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'done' }),
        agent('claude-2'),
      ]),
    })
    const notify = install(h)
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'done' }),
        agent('claude-2', { state: 'done' }),
      ]),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledWith('Orchestration finished', 'All 2 workers are done.')
  })

  it('tells when the orchestrator waits for the user, with its last answer', () => {
    const h = harness({
      s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1', { state: 'done' })]),
    })
    const notify = install(h)
    h.emit('orchestrator', { hook_event_name: 'Stop', last_assistant_message: 'Deploy now?' })
    h.emit('orchestrator', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(useAttentionStore.getState().waiting.s1?.text).toBe('Deploy now?')
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledWith('The orchestrator is waiting for you', 'Deploy now?')

    h.emit('orchestrator', { hook_event_name: 'UserPromptSubmit', prompt: 'yes' })
    expect(useAttentionStore.getState().waiting.s1).toBeUndefined()
  })

  it('names the orchestration when several run', () => {
    const h = harness({
      s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')], 'C:/work/Opala'),
      s2: sessionOf('s2', [agent('orchestrator')], 'C:/work/IA'),
    })
    const notify = install(h)
    h.set({
      ...h.source.getState().sessions,
      s1: sessionOf(
        's1',
        [agent('orchestrator'), agent('claude-1', { state: 'blocked', blocked: ask('Allow?', 1) })],
        'C:/work/Opala',
      ),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).toHaveBeenCalledWith('claude-1 (backend) needs you', 'Opala · Allow?')
  })

  it('forgets a stopped session: no wait left and nothing more to announce', () => {
    const h = harness({
      s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1', { state: 'done' })]),
    })
    const notify = install(h)
    h.emit('orchestrator', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(useAttentionStore.getState().waiting.s1).toBeDefined()
    vi.advanceTimersByTime(BATCH_MS)
    notify.mockClear()

    const stopped = {
      ...sessionOf('s1', [agent('orchestrator'), agent('claude-1', { state: 'done' })]),
      stoppedAt: Date.now(),
    }
    h.set({ s1: stopped })
    expect(useAttentionStore.getState().waiting.s1).toBeUndefined()

    // Later changes in the read-only session raise no notice.
    h.set({
      s1: { ...stopped, agents: [agent('orchestrator'), agent('claude-1', { state: 'exited' })] },
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).not.toHaveBeenCalled()
  })

  it('installs nothing outside the main window', () => {
    const h = harness({ s1: sessionOf('s1', [agent('orchestrator'), agent('claude-1')]) })
    const notify = install(h, { isMainWindow: () => false })
    h.set({
      s1: sessionOf('s1', [
        agent('orchestrator'),
        agent('claude-1', { state: 'blocked', blocked: ask('Allow?', 1) }),
      ]),
    })
    vi.advanceTimersByTime(BATCH_MS)
    expect(notify).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().last.s1).toBeUndefined()
  })
})
