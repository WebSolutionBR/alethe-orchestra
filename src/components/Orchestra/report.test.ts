import { describe, expect, it } from 'vitest'

import type { OrchestraAgent, OrchestraSession } from '../../stores/orchestraStore'
import {
  type AgentReport,
  buildReport,
  type ReportFormat,
  reportJson,
  type ReportLabels,
  reportMarkdown,
} from './report'

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'api',
    task: `task of ${id}`,
    after: [],
    ptyId: null,
    state: 'thinking',
    progress: 0,
    note: '',
    lines: [],
    files: [],
    toolCalls: 0,
    startedAt: 1_000,
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
    id: 'oreport1',
    projectId: 'p1',
    cwd: 'C:\\work\\shop',
    goal: 'ship the release',
    autonomous: true,
    startedAt: 1_000,
    mode: 'mission',
    agents,
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
    ...patch,
  }
}

const labels: ReportLabels = {
  title: 'Report',
  goal: 'Goal',
  noGoal: 'none',
  folder: 'Folder',
  mode: 'Mode',
  autonomous: 'autonomous',
  supervised: 'supervised',
  summary: 'Summary',
  worker: 'Worker',
  area: 'Area',
  state: 'State',
  duration: 'Duration',
  files: 'Files',
  note: 'Last note',
  failures: 'Failures',
  filesByWorker: 'Files by worker',
  noWorkers: 'No workers.',
  blocked: 'Time blocked',
  accounts: 'Accounts',
  defaultAccount: 'default account',
  accountSwitch: (from, to) => `switched from ${from} to ${to}`,
  states: {
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
    blocked: 'blocked',
    waiting: 'waiting',
    working: 'working',
  },
  failure: (w: AgentReport) => `exited with code ${w.exitCode}`,
}

const format: ReportFormat = {
  dateTime: (ms) => `T${ms}`,
  time: (ms) => `t${ms}`,
  duration: (ms) => `${ms / 1000}s`,
}

const finished = session(
  [
    agent('orchestrator', { state: 'idle' }),
    agent('claude-1', {
      state: 'done',
      progress: 100,
      note: 'shipped | tested',
      files: ['src/a.ts', 'src/b.ts'],
      toolCalls: 12,
      finishedAt: 61_000,
    }),
    agent('claude-2', {
      state: 'exited',
      progress: 35,
      note: 'running cargo test',
      files: ['src/a.ts'],
      exitCode: 1,
      exitReason: 'exited',
      finishedAt: 31_000,
    }),
    agent('claude-3', { state: 'idle', exitReason: 'stopped', finishedAt: 91_000 }),
  ],
  { stoppedAt: 91_000, messages: [{ id: 1, at: 2, from: 'you', to: 'orchestrator', text: 'go' }] },
)

describe('buildReport', () => {
  it('states where every worker ended and totals the session', () => {
    const report = buildReport(finished, { project: 'Shop', now: 500_000 })
    expect(report.workers.map((w) => [w.id, w.state])).toEqual([
      ['claude-1', 'done'],
      ['claude-2', 'failed'],
      ['claude-3', 'stopped'],
    ])
    expect(report).toMatchObject({
      project: 'Shop',
      stoppedAt: 91_000,
      durationMs: 90_000,
      totals: { workers: 3, done: 1, failed: 1, stopped: 1, open: 0, files: 2, toolCalls: 12 },
    })
    expect(report.totals.messages).toBe(1)
    expect(report.workers[1]).toMatchObject({ exitCode: 1, durationMs: 30_000 })
    expect(report.orchestrator?.id).toBe('orchestrator')
  })

  it('reports a running session as a snapshot up to now', () => {
    const running = session([agent('orchestrator'), agent('claude-1', { state: 'editing' })])
    const report = buildReport(running, { now: 11_000 })
    expect(report).toMatchObject({ stoppedAt: null, durationMs: 10_000 })
    expect(report.workers[0].state).toBe('working')
    expect(report.totals.open).toBe(1)
  })
})

describe('report outputs', () => {
  it('writes Markdown with a table, the failures and the files', () => {
    const md = reportMarkdown(buildReport(finished, { project: 'Shop' }), labels, format)
    expect(md).toContain('# Report · Shop · T1000–t91000 (90s)')
    expect(md).toContain('**Goal:** ship the release')
    expect(md).toContain('| claude-1 | api | ✓ done | 60s | 2 | shipped \\| tested |')
    expect(md).toContain('## Failures')
    expect(md).toContain('- **claude-2** (api): exited with code 1 — running cargo test')
    expect(md).toContain('- **claude-1**: `src/a.ts`, `src/b.ts`')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('says so when there were no workers, and exports valid JSON', () => {
    const empty = buildReport(session([agent('orchestrator')]), { now: 2_000 })
    expect(reportMarkdown(empty, labels, format)).toContain('No workers.')
    expect(JSON.parse(reportJson(empty))).toMatchObject({ version: 1, totals: { workers: 0 } })
  })
})

describe('blocked time and accounts', () => {
  const blockedSession = session(
    [
      agent('orchestrator', {
        state: 'idle',
        launchedWith: { account: 'acc-a', model: null, effort: null },
      }),
      agent('claude-1', {
        state: 'blocked',
        blocked: { reason: 'login', text: 'login_expired', at: 50_000 },
        launchedWith: { account: 'acc-b', model: null, effort: null },
      }),
    ],
    {
      segments: [
        { agentId: 'claude-1', kind: 'thinking', start: 1_000, end: 10_000 },
        { agentId: 'claude-1', kind: 'blocked', start: 10_000, end: 40_000 },
        { agentId: 'claude-1', kind: 'thinking', start: 40_000, end: 50_000 },
        { agentId: 'claude-1', kind: 'blocked', start: 50_000, end: null },
        { agentId: 'orchestrator', kind: 'blocked', start: 2_000, end: 3_000 },
      ],
      accountSwitches: [{ at: 45_000, from: 'acc-a', to: null }],
    },
  )
  const names = (id: string | null) =>
    id === 'acc-a' ? 'Compras' : id === 'acc-b' ? 'Pricing' : null

  it('sums closed and open blocked segments up to the report time', () => {
    const report = buildReport(blockedSession, { now: 70_000, accountName: names })
    expect(report.workers[0].blockedMs).toBe(30_000 + 20_000)
    expect(report.orchestrator?.blockedMs).toBe(1_000)
    expect(report.totals.blockedMs).toBe(51_000)
    expect(report.workers[0]).toMatchObject({ account: 'acc-b', accountName: 'Pricing' })
    expect(report.accountSwitches).toEqual([
      { at: 45_000, from: 'acc-a', to: null, fromName: 'Compras', toName: null },
    ])
  })

  it('lists blocked time, each agent account and the switches in the Markdown', () => {
    const md = reportMarkdown(
      buildReport(blockedSession, { now: 70_000, accountName: names }),
      labels,
      format,
    )
    expect(md).toContain('## Time blocked')
    expect(md).toContain('- **claude-1**: 50s')
    expect(md).toContain('- **orchestrator**: 1s')
    expect(md).toContain('## Accounts')
    expect(md).toContain('- **claude-1**: Pricing')
    expect(md).toContain('- t45000: switched from Compras to default account')
  })

  it('leaves both sections out of a session that never blocked on the default account', () => {
    const md = reportMarkdown(
      buildReport(session([agent('orchestrator')]), { now: 5_000 }),
      labels,
      format,
    )
    expect(md).not.toContain('## Time blocked')
    expect(md).not.toContain('## Accounts')
  })
})
