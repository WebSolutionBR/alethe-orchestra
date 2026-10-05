import { describe, expect, it, vi } from 'vitest'

// The store is loaded only to compare the orchestrator id; keep it away from Tauri and Obsidian.
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))
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
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))

import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import { type OrchestraAgent, ORCHESTRATOR_ID } from '../../../stores/orchestraStore'
import {
  attentionEvents,
  isOrchestratorActive,
  isOrchestratorIdleNotice,
  needsYou,
  ORCHESTRATOR,
} from './rules'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === ORCHESTRATOR ? 'orchestrator' : 'ui',
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

const session = (...agents: OrchestraAgent[]) => ({ agents })

function hook(agentId: string, hookData: Record<string, unknown>): OrchestraEvent {
  return { kind: 'hook', session: 's1', at: 1, agent_id: agentId, hook: hookData }
}

describe('needsYou', () => {
  it('counts questions, permissions, reports and agents that stopped early', () => {
    const ask = { reason: 'permission' as const, text: 'Allow Bash?', at: 1 }
    expect(needsYou(agent('c1', { state: 'blocked', blocked: ask }))).toBe(true)
    expect(needsYou(agent('c1', { state: 'exited' }))).toBe(true)
    const dep = { reason: 'dependency' as const, text: 'claude-2', at: 1 }
    expect(needsYou(agent('c1', { state: 'blocked', blocked: dep }))).toBe(false)
    expect(needsYou(agent('c1', { state: 'thinking' }))).toBe(false)
    expect(needsYou(agent('c1', { state: 'done' }))).toBe(false)
  })

  it('keeps the orchestrator id in sync with the store', () => {
    expect(ORCHESTRATOR).toBe(ORCHESTRATOR_ID)
  })
})

describe('attentionEvents', () => {
  it('reports a new question, and again when another one replaces it', () => {
    const before = { s1: session(agent('orchestrator'), agent('claude-1')) }
    const ask = (at: number) => ({ reason: 'question' as const, text: 'Which DB?', at })
    const blocked = {
      s1: session(agent('orchestrator'), agent('claude-1', { state: 'blocked', blocked: ask(5) })),
    }
    expect(attentionEvents(before, blocked, 10)).toEqual([
      {
        kind: 'blocked',
        sessionId: 's1',
        agentId: 'claude-1',
        text: 'Which DB?',
        key: 's1:claude-1:blocked:5',
        at: 10,
      },
    ])
    // Same question, still pending: nothing new.
    expect(attentionEvents(blocked, blocked, 11)).toEqual([])
    const next = {
      s1: session(agent('orchestrator'), agent('claude-1', { state: 'blocked', blocked: ask(9) })),
    }
    expect(attentionEvents(blocked, next, 12)[0]?.key).toBe('s1:claude-1:blocked:9')
  })

  it('reports an agent that stopped before done, once', () => {
    const before = { s1: session(agent('orchestrator'), agent('claude-1')) }
    const after = {
      s1: session(
        agent('orchestrator'),
        agent('claude-1', { state: 'exited', note: 'cargo failed', finishedAt: 7 }),
      ),
    }
    const events = attentionEvents(before, after, 8)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'failed', agentId: 'claude-1', text: 'cargo failed' })
    expect(attentionEvents(after, after, 9)).toEqual([])
  })

  it('reports a session whose workers all just finished', () => {
    const before = {
      s1: session(agent('orchestrator'), agent('claude-1', { state: 'done' }), agent('claude-2')),
    }
    const after = {
      s1: session(
        agent('orchestrator'),
        agent('claude-1', { state: 'done' }),
        agent('claude-2', { state: 'done' }),
      ),
    }
    expect(attentionEvents(before, after, 3)).toEqual([
      { kind: 'allDone', sessionId: 's1', agentId: null, text: '', key: 's1:allDone:2', at: 3 },
    ])
  })

  it('only sets a baseline for a session seen for the first time', () => {
    const after = { s1: session(agent('claude-1', { state: 'exited' })) }
    expect(attentionEvents({}, after, 1)).toEqual([])
  })
})

describe('orchestrator waiting', () => {
  const idle = hook('orchestrator', {
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
  })

  it('reads an idle orchestrator as waiting only when no worker is busy', () => {
    expect(isOrchestratorIdleNotice(idle, [agent('orchestrator'), agent('claude-1')])).toBe(false)
    expect(
      isOrchestratorIdleNotice(idle, [
        agent('orchestrator'),
        agent('claude-1', { state: 'done' }),
        agent('claude-2', { state: 'waiting' }),
      ]),
    ).toBe(true)
  })

  it('ignores workers going idle and other notices', () => {
    const workerIdle = hook('claude-1', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    })
    expect(isOrchestratorIdleNotice(workerIdle, [agent('claude-1', { state: 'done' })])).toBe(false)
    const permission = hook('orchestrator', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
    })
    expect(isOrchestratorIdleNotice(permission, [agent('orchestrator')])).toBe(false)
  })

  it('ends the wait when the orchestrator acts again', () => {
    expect(
      isOrchestratorActive(hook('orchestrator', { hook_event_name: 'UserPromptSubmit' })),
    ).toBe(true)
    expect(isOrchestratorActive(hook('orchestrator', { hook_event_name: 'PreToolUse' }))).toBe(true)
    expect(isOrchestratorActive(hook('claude-1', { hook_event_name: 'UserPromptSubmit' }))).toBe(
      false,
    )
  })
})
