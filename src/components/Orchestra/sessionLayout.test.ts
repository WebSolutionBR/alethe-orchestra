import { describe, expect, it } from 'vitest'

import type { AgentState, OrchestraAgent, OrchestraSession } from '../../stores/orchestraStore'
import {
  clampSplitRatio,
  cycleId,
  folderName,
  markSeen,
  needsAttention,
  tabCycleStep,
  tabSummary,
} from './sessionLayout'

function agent(id: string, state: AgentState, progress = 0): OrchestraAgent {
  return {
    id,
    area: id,
    task: '',
    after: [],
    ptyId: null,
    state,
    progress,
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
  }
}

function sessionWith(...agents: OrchestraAgent[]): OrchestraSession {
  return {
    id: 'oabc1234',
    projectId: 'p1',
    cwd: 'C:\\work\\shop',
    goal: 'ship it',
    autonomous: true,
    startedAt: 0,
    mode: 'constellation',
    agents: [agent('orchestrator', 'thinking'), ...agents],
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
  }
}

describe('tabSummary', () => {
  it('is working until every worker finished, and blocked wins', () => {
    expect(tabSummary(sessionWith()).status).toBe('working')
    expect(tabSummary(sessionWith(agent('claude-1', 'done', 100))).status).toBe('done')
    // A worker that exited without done failed: the session ended with an error, not done.
    expect(
      tabSummary(sessionWith(agent('claude-1', 'done', 100), agent('claude-2', 'exited', 40))),
    ).toMatchObject({ status: 'error', failed: 1 })
    expect(
      tabSummary(sessionWith(agent('claude-1', 'done', 100), agent('claude-2', 'editing', 20)))
        .status,
    ).toBe('working')
    const blocked = tabSummary(
      sessionWith(
        agent('claude-1', 'blocked', 10),
        agent('claude-2', 'blocked'),
        agent('c', 'done'),
      ),
    )
    expect(blocked).toMatchObject({ status: 'blocked', blocked: 2 })
  })

  it('shows an error when the orchestrator is down or a launch failed, even while others work', () => {
    const down = sessionWith(agent('claude-1', 'editing', 30))
    down.agents[0] = agent('orchestrator', 'exited')
    expect(tabSummary(down)).toMatchObject({ status: 'error', orchestratorDown: true })
    const launch = { ...sessionWith(agent('claude-1', 'editing')), error: 'claude-2: spawn failed' }
    expect(tabSummary(launch).status).toBe('error')
    // One failed worker while the others still work: working, with the failure counted.
    expect(
      tabSummary(sessionWith(agent('claude-1', 'exited', 10), agent('claude-2', 'editing'))),
    ).toMatchObject({ status: 'working', failed: 1 })
  })

  it('averages worker progress and ignores the orchestrator', () => {
    const summary = tabSummary(
      sessionWith(agent('claude-1', 'done', 100), agent('claude-2', 'editing', 50)),
    )
    expect(summary).toMatchObject({ overall: 75, goal: 'ship it', projectId: 'p1', blocked: 0 })
  })

  it('survives a session that is gone', () => {
    expect(tabSummary(undefined)).toMatchObject({ status: 'working', overall: 0, blocked: 0 })
  })
})

describe('folderName', () => {
  it('takes the last folder of Windows and POSIX paths', () => {
    expect(folderName('C:\\work\\shop\\')).toBe('shop')
    expect(folderName('/home/me/repo')).toBe('repo')
    expect(folderName(null)).toBe('')
  })
})

describe('cycleId', () => {
  const order = ['a', 'b', 'c']
  it('wraps around both ways', () => {
    expect(cycleId(order, 'c', 1)).toBe('a')
    expect(cycleId(order, 'a', -1)).toBe('c')
    expect(cycleId(order, 'b', 1)).toBe('c')
  })
  it('starts from an end without a current tab', () => {
    expect(cycleId(order, null, 1)).toBe('a')
    expect(cycleId(order, 'gone', -1)).toBe('c')
    expect(cycleId([], 'a', 1)).toBeNull()
  })
})

describe('tabCycleStep', () => {
  const chord = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }
  it('only reacts to Alt+PageUp and Alt+PageDown', () => {
    expect(tabCycleStep({ ...chord, key: 'PageDown' })).toBe(1)
    expect(tabCycleStep({ ...chord, key: 'PageUp' })).toBe(-1)
    expect(tabCycleStep({ ...chord, key: 'ArrowLeft' })).toBe(0)
    // Ctrl+PageUp/Down belong to the workspace, Ctrl+Alt is AltGr.
    expect(tabCycleStep({ ...chord, ctrlKey: true, key: 'PageDown' })).toBe(0)
    expect(tabCycleStep({ ...chord, altKey: false, key: 'PageDown' })).toBe(0)
  })
})

describe('needsAttention', () => {
  it('flags an off-screen session that got blocked or finished since it was seen', () => {
    markSeen('s1', 'working')
    expect(needsAttention('s1', 'working', false)).toBe(false)
    expect(needsAttention('s1', 'blocked', false)).toBe(true)
    expect(needsAttention('s1', 'blocked', true)).toBe(false)
    markSeen('s1', 'blocked')
    expect(needsAttention('s1', 'blocked', false)).toBe(false)
    expect(needsAttention('s1', 'done', false)).toBe(true)
    expect(needsAttention('never-seen', 'done', false)).toBe(true)
  })
})

describe('clampSplitRatio', () => {
  it('keeps both panes at least the minimum wide', () => {
    expect(clampSplitRatio(0.5, 1200)).toBe(0.5)
    expect(clampSplitRatio(0.1, 1200, 300)).toBe(0.25)
    expect(clampSplitRatio(0.95, 1200, 300)).toBe(0.75)
  })
  it('splits evenly when the view is narrower than two minimums', () => {
    expect(clampSplitRatio(0.8, 500, 300)).toBe(0.5)
  })
  it('falls back to sane bounds before the view is measured', () => {
    expect(clampSplitRatio(Number.NaN, null)).toBe(0.5)
    expect(clampSplitRatio(0.99, null)).toBe(0.8)
  })
})
