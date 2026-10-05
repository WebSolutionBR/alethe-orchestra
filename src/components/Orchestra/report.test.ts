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
