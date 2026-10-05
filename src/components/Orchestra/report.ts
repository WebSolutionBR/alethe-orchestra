/**
 * The report of one orchestration: goal, duration and, per worker, its area, task, final state,
 * note, files and failure. Pure, so it can be tested and exported as Markdown or JSON.
 */
import type { AgentExitReason, OrchestraAgent, OrchestraSession } from '../../stores/orchestraStore'
import { isFailed, isOrchestrator, workersOf } from './shared'

/** Where an agent ended up, as the report states it. */
export type FinalState = 'done' | 'failed' | 'stopped' | 'blocked' | 'waiting' | 'working'

export type AgentReport = {
  id: string
  area: string
  task: string
  state: FinalState
  progress: number
  note: string
  files: string[]
  toolCalls: number
  /** Tasks it took on: earlier ones plus the current one. */
  tasks: number
  startedAt: number
  finishedAt: number | null
  durationMs: number
  exitCode: number | null
  exitReason: AgentExitReason | null
}

export type SessionReport = {
  version: 1
  project: string | null
  cwd: string | null
  goal: string
  autonomous: boolean
  startedAt: number
  /** When its agents were stopped; null while it still runs (the report is a snapshot). */
  stoppedAt: number | null
  generatedAt: number
  durationMs: number
  orchestrator: AgentReport | null
  workers: AgentReport[]
  totals: {
    workers: number
    done: number
    failed: number
    stopped: number
    open: number
    files: number
    toolCalls: number
    messages: number
  }
}

export function finalState(agent: OrchestraAgent): FinalState {
  if (agent.state === 'done') return 'done'
  if (isFailed(agent)) return 'failed'
  if (agent.exitReason === 'stopped') return 'stopped'
  if (agent.state === 'blocked') return 'blocked'
  if (agent.state === 'waiting') return 'waiting'
  return 'working'
}

function agentReport(agent: OrchestraAgent, end: number): AgentReport {
  const finishedAt = agent.finishedAt
  return {
    id: agent.id,
    area: agent.area,
    task: agent.task,
    state: finalState(agent),
    progress: agent.progress,
    note: agent.note,
    files: [...agent.files],
    toolCalls: agent.toolCalls,
    tasks: agent.history.length + 1,
    startedAt: agent.startedAt,
    finishedAt,
    durationMs: Math.max(0, (finishedAt ?? end) - agent.startedAt),
    exitCode: agent.exitCode ?? null,
    exitReason: agent.exitReason ?? null,
  }
}

export function buildReport(
  session: OrchestraSession,
  opts: { project?: string | null; now?: number } = {},
): SessionReport {
  const now = opts.now ?? Date.now()
  const end = session.stoppedAt ?? now
  const workers = workersOf(session.agents).map((agent) => agentReport(agent, end))
  const orchestrator = session.agents.find(isOrchestrator)
  const count = (state: FinalState) => workers.filter((w) => w.state === state).length
  return {
    version: 1,
    project: opts.project ?? null,
    cwd: session.cwd,
    goal: session.goal,
    autonomous: session.autonomous,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt ?? null,
    generatedAt: now,
    durationMs: Math.max(0, end - session.startedAt),
    orchestrator: orchestrator ? agentReport(orchestrator, end) : null,
    workers,
    totals: {
      workers: workers.length,
      done: count('done'),
      failed: count('failed'),
      stopped: count('stopped'),
      open: workers.length - count('done') - count('failed') - count('stopped'),
      files: new Set(session.agents.flatMap((a) => a.files)).size,
      toolCalls: session.agents.reduce((sum, a) => sum + a.toolCalls, 0),
      messages: session.messages.length,
    },
  }
}

export function reportJson(report: SessionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** Words of the Markdown report, in the user's language (filled from i18n by the caller). */
export type ReportLabels = {
  title: string
  goal: string
  noGoal: string
  folder: string
  mode: string
  autonomous: string
  supervised: string
  summary: string
  worker: string
  area: string
  state: string
  duration: string
  files: string
  note: string
  failures: string
  filesByWorker: string
  noWorkers: string
  states: Record<FinalState, string>
  /** How a failed agent ended (exit code, launch failure), per worker id. */
  failure: (worker: AgentReport) => string
}

export type ReportFormat = {
  /** Date and time of the session start, e.g. "04/10/2026 21:12". */
  dateTime: (ms: number) => string
  time: (ms: number) => string
  duration: (ms: number) => string
}

const STATE_GLYPH: Record<FinalState, string> = {
  done: '✓',
  failed: '✕',
  stopped: '■',
  blocked: '!',
  waiting: '◌',
  working: '…',
}

/** A table cell: one line, pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

export function reportMarkdown(
  report: SessionReport,
  labels: ReportLabels,
  format: ReportFormat,
): string {
  const end = report.stoppedAt ?? report.generatedAt
  const heading = [labels.title, report.project ?? '', format.dateTime(report.startedAt)]
    .filter(Boolean)
    .join(' · ')
  const lines: string[] = [
    `# ${heading}–${format.time(end)} (${format.duration(report.durationMs)})`,
    '',
    `**${labels.goal}:** ${report.goal.trim() || labels.noGoal}`,
  ]
  if (report.cwd) lines.push(`**${labels.folder}:** \`${report.cwd}\``)
  lines.push(
    `**${labels.mode}:** ${report.autonomous ? labels.autonomous : labels.supervised}`,
    `**${labels.summary}:** ${report.totals.workers} ${labels.worker.toLowerCase()} · ` +
      `${STATE_GLYPH.done} ${report.totals.done} · ${STATE_GLYPH.failed} ${report.totals.failed} · ` +
      `${STATE_GLYPH.stopped} ${report.totals.stopped} · ${report.totals.files} ${labels.files.toLowerCase()}`,
    '',
  )
  if (report.workers.length === 0) {
    lines.push(labels.noWorkers, '')
  } else {
    lines.push(
      `| ${labels.worker} | ${labels.area} | ${labels.state} | ${labels.duration} | ${labels.files} | ${labels.note} |`,
      '|---|---|---|---|---|---|',
    )
    for (const w of report.workers) {
      lines.push(
        `| ${cell(w.id)} | ${cell(w.area)} | ${STATE_GLYPH[w.state]} ${cell(labels.states[w.state])} | ` +
          `${format.duration(w.durationMs)} | ${w.files.length} | ${cell(w.note)} |`,
      )
    }
    lines.push('')
  }
  const failed = report.workers.filter((w) => w.state === 'failed')
  if (failed.length > 0) {
    lines.push(`## ${labels.failures}`, '')
    for (const w of failed) {
      const note = w.note ? ` — ${cell(w.note)}` : ''
      lines.push(`- **${w.id}** (${cell(w.area)}): ${labels.failure(w)}${note}`)
    }
    lines.push('')
  }
  const withFiles = report.workers.filter((w) => w.files.length > 0)
  if (withFiles.length > 0) {
    lines.push(`## ${labels.filesByWorker}`, '')
    for (const w of withFiles) {
      lines.push(`- **${w.id}**: ${w.files.map((f) => `\`${f}\``).join(', ')}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** "45 s", "52 min", "1h28". */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}
