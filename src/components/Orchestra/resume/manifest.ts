/**
 * Session manifests: what a running orchestration needs to be read again, or resumed, after the
 * app closed under it. Pure: the store builds them, `persist.ts` writes them (debounced, atomic
 * on the backend) and `resumePlan` turns one back into a session plus the launches to make.
 */
import type {
  ActivityLine,
  AgentBlock,
  AgentExitReason,
  AgentState,
  BusMessage,
  DeliveryFailure,
  DeliveryStatus,
  OrchestraAgent,
  OrchestraSession,
  TaskRecord,
} from '../../../stores/orchestraStore'
import type { LaunchOptions } from '../usage/launch'

export const MANIFEST_VERSION = 1
/** Bus lines kept: enough to see what was going on when the app closed. */
export const MANIFEST_MESSAGES = 80
/** Activity lines kept per agent. */
export const MANIFEST_LINES = 30

/** Same id as `ORCHESTRATOR_ID`; repeated so this module never loads the store at runtime. */
const ORCHESTRATOR = 'orchestrator'
const ID = /^[a-z0-9-]{1,32}$/
const WORKER_ID = /^claude-(\d{1,6})$/
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A Claude Code conversation id (a UUID). It is passed as `claude --resume <id>` on a command
 * line, so a value of any other shape is never used.
 */
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value)
}

/** Whether two paths name the same folder (on Windows, case and slashes do not matter). */
export function sameFolder(a: string | null, b: string | null): boolean {
  const normal = (path: string | null) =>
    (path ?? '')
      .trim()
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase()
  return normal(a) === normal(b)
}

export type OrchestraManifest = {
  version: typeof MANIFEST_VERSION
  /** The session id; the backend sets it from the file name. */
  id: string
  savedAt: number
  projectId: string | null
  cwd: string | null
  goal: string
  autonomous: boolean
  startedAt: number
  mode: string
  agents: OrchestraAgent[]
  messages: BusMessage[]
}

/** How a launch continues an interrupted run. */
export type ResumeLaunch = {
  /** `claude --resume <id>`; null starts the agent over from its task file. */
  claudeSessionId: string | null
  /** First message of the relaunched agent. */
  prompt: string
}

export type ResumePlan = {
  agents: OrchestraAgent[]
  messages: BusMessage[]
  launches: { agentId: string; resume: ResumeLaunch }[]
  /** One above the highest `claude-N`, so new spawns never reuse an id. */
  nextWorker: number
  /** What the orchestrator is told (its first message and a bus line). */
  notice: string
}

export type ManifestSummary = {
  workers: number
  done: number
  failed: number
  waiting: number
  /** Workers a resume relaunches. */
  unfinished: number
}

/** The manifest of a running session; `savedAt` 0 gives a stable text to compare. */
export function manifestOf(session: OrchestraSession, savedAt: number): OrchestraManifest {
  return {
    version: MANIFEST_VERSION,
    id: session.id,
    savedAt,
    projectId: session.projectId,
    cwd: session.cwd,
    goal: session.goal,
    autonomous: session.autonomous,
    startedAt: session.startedAt,
    mode: session.mode,
    agents: session.agents.map((agent) => ({
      ...agent,
      lines: agent.lines.slice(-MANIFEST_LINES),
    })),
    messages: session.messages.slice(-MANIFEST_MESSAGES),
  }
}

// Every value of each union, as records so a value added to a type must be added here too.
const AGENT_STATES = Object.keys({
  thinking: 1,
  editing: 1,
  testing: 1,
  blocked: 1,
  done: 1,
  idle: 1,
  starting: 1,
  waiting: 1,
  exited: 1,
} satisfies Record<AgentState, 1>) as AgentState[]
const LINE_TONES = Object.keys({
  tool: 1,
  ok: 1,
  error: 1,
  note: 1,
  prompt: 1,
} satisfies Record<ActivityLine['tone'], 1>) as ActivityLine['tone'][]
const EXIT_REASONS = Object.keys({
  exited: 1,
  killed: 1,
  suspended: 1,
  restarted: 1,
  'launch-failed': 1,
  'launch-timeout': 1,
  stopped: 1,
} satisfies Record<AgentExitReason, 1>) as AgentExitReason[]
const BLOCK_REASONS = Object.keys({
  permission: 1,
  question: 1,
  report: 1,
  dependency: 1,
} satisfies Record<AgentBlock['reason'], 1>) as AgentBlock['reason'][]
const DELIVERIES = Object.keys({
  queued: 1,
  pending: 1,
  delivered: 1,
  failed: 1,
} satisfies Record<DeliveryStatus, 1>) as DeliveryStatus[]
const FAILURES = Object.keys({
  unknown: 1,
  exited: 1,
  cancelled: 1,
  write: 1,
  nobody: 1,
  stopped: 1,
} satisfies Record<DeliveryFailure, 1>) as DeliveryFailure[]

type Raw = Record<string, unknown>

const isRaw = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback
const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null
const count = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const countOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T | null =>
  typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : null
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function parseLine(raw: unknown): ActivityLine | null {
  if (!isRaw(raw)) return null
  const tone = oneOf(raw.tone, LINE_TONES)
  return tone ? { at: count(raw.at), text: text(raw.text), tone } : null
}

function parseRecord(raw: unknown): TaskRecord | null {
  if (!isRaw(raw)) return null
  return {
    task: text(raw.task),
    note: text(raw.note),
    progress: count(raw.progress),
    startedAt: count(raw.startedAt),
    finishedAt: countOrNull(raw.finishedAt),
  }
}

function parseBlock(raw: unknown): AgentBlock | null {
  if (!isRaw(raw)) return null
  const reason = oneOf(raw.reason, BLOCK_REASONS)
  return reason ? { reason, text: text(raw.text), at: count(raw.at) } : null
}

function parseLaunchedWith(raw: unknown): LaunchOptions | null {
  if (!isRaw(raw)) return null
  return {
    account: textOrNull(raw.account),
    model: textOrNull(raw.model),
    effort: textOrNull(raw.effort),
  }
}

function parseAgent(raw: unknown): OrchestraAgent | null {
  if (!isRaw(raw) || typeof raw.id !== 'string' || !ID.test(raw.id)) return null
  const state = oneOf(raw.state, AGENT_STATES)
  if (!state) return null
  return {
    id: raw.id,
    area: text(raw.area, raw.id),
    task: text(raw.task),
    after: list(raw.after).filter((dep): dep is string => typeof dep === 'string' && ID.test(dep)),
    ptyId: textOrNull(raw.ptyId),
    state,
    progress: Math.min(100, Math.max(0, count(raw.progress))),
    note: text(raw.note),
    lines: list(raw.lines)
      .map(parseLine)
      .filter((line): line is ActivityLine => line !== null)
      .slice(-MANIFEST_LINES),
    files: list(raw.files).filter((file): file is string => typeof file === 'string'),
    toolCalls: count(raw.toolCalls),
    startedAt: count(raw.startedAt),
    finishedAt: countOrNull(raw.finishedAt),
    history: list(raw.history)
      .map(parseRecord)
      .filter((record): record is TaskRecord => record !== null),
    account: textOrNull(raw.account),
    model: textOrNull(raw.model),
    effort: textOrNull(raw.effort),
    exitCode: countOrNull(raw.exitCode),
    exitReason: oneOf(raw.exitReason, EXIT_REASONS),
    blocked: parseBlock(raw.blocked),
    claudeSessionId: isConversationId(raw.claudeSessionId) ? raw.claudeSessionId : null,
    transcriptPath: textOrNull(raw.transcriptPath),
    launchedWith: parseLaunchedWith(raw.launchedWith),
  }
}

function parseMessage(raw: unknown): BusMessage | null {
  if (!isRaw(raw) || typeof raw.id !== 'number' || typeof raw.text !== 'string') return null
  const message: BusMessage = {
    id: raw.id,
    at: count(raw.at),
    from: text(raw.from),
    to: text(raw.to),
    text: raw.text,
  }
  const delivery = oneOf(raw.delivery, DELIVERIES)
  const failure = oneOf(raw.failure, FAILURES)
  if (delivery) message.delivery = delivery
  if (failure) message.failure = failure
  return message
}

/** A manifest read from disk, checked field by field; null when it cannot be used. */
export function parseManifest(raw: unknown): OrchestraManifest | null {
  if (!isRaw(raw) || raw.version !== MANIFEST_VERSION) return null
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return null
  const agents: OrchestraAgent[] = []
  for (const agent of list(raw.agents).map(parseAgent)) {
    if (agent && !agents.some((a) => a.id === agent.id)) agents.push(agent)
  }
  return {
    version: MANIFEST_VERSION,
    id: raw.id,
    savedAt: count(raw.savedAt),
    projectId: textOrNull(raw.projectId),
    cwd: textOrNull(raw.cwd),
    goal: text(raw.goal),
    autonomous: raw.autonomous === true,
    startedAt: count(raw.startedAt),
    mode: text(raw.mode),
    agents,
    messages: list(raw.messages)
      .map(parseMessage)
      .filter((message): message is BusMessage => message !== null)
      .slice(-MANIFEST_MESSAGES),
  }
}

/** Waits for its dependencies (or is held because one failed): `releaseWaiting` decides. */
const waitsForDependencies = (agent: OrchestraAgent) =>
  agent.state === 'waiting' || (agent.state === 'blocked' && agent.blocked?.reason === 'dependency')

/** A worker that had failed before the close; its task may be someone else's by now. */
const failedBefore = (agent: OrchestraAgent) =>
  agent.id !== ORCHESTRATOR && agent.state === 'exited'

/**
 * Relaunched on resume: the orchestrator always; a worker unless it finished, waits for a
 * dependency or had failed (the user restarts that one from its panel, if still wanted).
 */
const relaunches = (agent: OrchestraAgent) =>
  agent.id === ORCHESTRATOR ||
  (agent.state !== 'done' && !failedBefore(agent) && !waitsForDependencies(agent))

/** What resuming does with an agent. */
export type AgentFate = 'resume' | 'restart' | 'wait' | 'finished' | 'failed'

/**
 * `folderChanged`: the session resumes in another folder, where Claude Code cannot find the
 * conversations it kept for the old one.
 */
export type ResumeOptions = { folderChanged?: boolean }

export function agentFate(agent: OrchestraAgent, options: ResumeOptions = {}): AgentFate {
  if (relaunches(agent)) {
    return agent.claudeSessionId && !options.folderChanged ? 'resume' : 'restart'
  }
  if (failedBefore(agent)) return 'failed'
  return agent.state === 'done' ? 'finished' : 'wait'
}

/**
 * The account, model and effort an agent's last process ran with. Manifests written before
 * `launchedWith` existed hold the same values in the agent's own fields once it had run.
 */
function launchedWithOf(agent: OrchestraAgent): LaunchOptions | null {
  if (agent.launchedWith) return agent.launchedWith
  if (!agent.ptyId && !agent.claudeSessionId) return null
  return { account: agent.account, model: agent.model, effort: agent.effort }
}

export function summarizeManifest(manifest: OrchestraManifest): ManifestSummary {
  const workers = manifest.agents.filter((a) => a.id !== ORCHESTRATOR)
  return {
    workers: workers.length,
    done: workers.filter((a) => a.state === 'done').length,
    failed: workers.filter((a) => a.state === 'exited').length,
    waiting: workers.filter(waitsForDependencies).length,
    unfinished: workers.filter(relaunches).length,
  }
}

/** Highest `claude-N` the session used, among its agents and its bus. */
function highestWorker(manifest: OrchestraManifest): number {
  const ids = [
    ...manifest.agents.map((a) => a.id),
    ...manifest.messages.flatMap((m) => [m.from, m.to]),
  ]
  return ids.reduce((max, id) => Math.max(max, Number(WORKER_ID.exec(id)?.[1] ?? 0)), 0)
}

const named = (agents: OrchestraAgent[]) =>
  agents.map((a) => (a.area && a.area !== a.id ? `${a.id} (${a.area})` : a.id)).join(', ')

/** First message of a worker resumed in its own conversation. */
export const WORKER_RESUMED_PROMPT =
  '[orchestra] Alethe was closed while you were working, and the user resumed this orchestration. ' +
  'Continue your task where you left off and keep reporting with orch report; if you were ' +
  'waiting for an answer, ask the orchestrator again.'
/** First message of a worker started over (no conversation to resume); the task file follows. */
export const WORKER_RESTARTED_PROMPT =
  '[orchestra] Alethe was closed before your conversation could be saved, and the user resumed ' +
  'this orchestration, so you start your task again.'
/** First message of a worker resumed in another folder; the task file follows. */
export const WORKER_MOVED_PROMPT =
  '[orchestra] Alethe was closed while you were working, and the user resumed this ' +
  'orchestration in another folder, where your earlier conversation cannot be found, so you ' +
  'start your task again.'
/** First message of a worker whose `claude --resume` failed; the task file follows. */
export const WORKER_NOT_RESUMED_PROMPT =
  '[orchestra] Your earlier conversation could not be resumed, so you start your task again.'

/**
 * First message for a relaunch after `claude --resume` failed (the conversation was not found):
 * a worker starts its task over; the orchestrator keeps what it was told and learns that its
 * own memory of the session is gone.
 */
export function notResumedPrompt(agentId: string, prompt: string): string {
  return agentId === ORCHESTRATOR
    ? `${prompt} Your own earlier conversation could not be resumed, so check on the workers ` +
        'listed above before delegating anything new.'
    : WORKER_NOT_RESUMED_PROMPT
}

/**
 * How a manifest comes back as a running session: which agents are relaunched (with
 * `claude --resume` when their conversation is known), what the orchestrator is told, where
 * worker numbering continues, and the bus as it was. Workers that had finished, failed or wait
 * for a dependency are not relaunched. Messages that were still on their way when the app
 * closed are marked failed, so they can be sent again.
 */
export function resumePlan(manifest: OrchestraManifest, options: ResumeOptions = {}): ResumePlan {
  const moved = options.folderChanged === true
  const launches: ResumePlan['launches'] = []
  const resumed: OrchestraAgent[] = []
  const restarted: OrchestraAgent[] = []
  const agents = manifest.agents.map((agent): OrchestraAgent => {
    if (!relaunches(agent)) {
      // A finished worker comes back without a process: its process ended (as after `done`),
      // so messages to it fail at once instead of waiting for a terminal that never starts.
      return agent.state === 'done'
        ? { ...agent, ptyId: null, exitReason: agent.exitReason ?? 'exited' }
        : { ...agent, ptyId: null }
    }
    // Claude Code keeps conversations per folder: elsewhere `--resume` cannot find them.
    const claudeSessionId = moved ? null : (agent.claudeSessionId ?? null)
    if (agent.id !== ORCHESTRATOR) {
      const group = claudeSessionId ? resumed : restarted
      group.push(agent)
      launches.push({
        agentId: agent.id,
        resume: {
          claudeSessionId,
          prompt: claudeSessionId
            ? WORKER_RESUMED_PROMPT
            : moved
              ? WORKER_MOVED_PROMPT
              : WORKER_RESTARTED_PROMPT,
        },
      })
    }
    return {
      ...agent,
      ptyId: null,
      state: 'starting',
      finishedAt: null,
      exitCode: null,
      exitReason: null,
      blocked: null,
      // It comes back on the account, model and effort it ran with, not today's defaults.
      launchedWith: launchedWithOf(agent),
    }
  })
  if (!agents.some((a) => a.id === ORCHESTRATOR)) {
    agents.unshift({
      id: ORCHESTRATOR,
      area: ORCHESTRATOR,
      task: manifest.goal,
      after: [],
      ptyId: null,
      state: 'starting',
      progress: 0,
      note: '',
      lines: [],
      files: [],
      toolCalls: 0,
      startedAt: manifest.startedAt,
      finishedAt: null,
      history: [],
      account: null,
      model: null,
      effort: null,
      exitCode: null,
      exitReason: null,
      blocked: null,
      claudeSessionId: null,
      transcriptPath: null,
    })
  }

  let undelivered = 0
  const messages = manifest.messages.map((message): BusMessage => {
    if (message.delivery !== 'pending' && message.delivery !== 'queued') return message
    undelivered += 1
    return { ...message, delivery: 'failed', failure: 'exited' }
  })

  const nextWorker = highestWorker(manifest) + 1
  const workers = manifest.agents.filter((a) => a.id !== ORCHESTRATOR)
  const done = workers.filter((a) => a.state === 'done')
  const failed = workers.filter(failedBefore)
  const waiting = workers.filter(waitsForDependencies)
  const notice = [
    '[orchestra] Alethe was closed while this orchestration was running, and the user resumed it.',
    moved
      ? 'It now runs in another folder, where the earlier conversations cannot be found, so every agent starts its task over.'
      : '',
    resumed.length ? `Resumed in their own conversations: ${named(resumed)}.` : '',
    restarted.length && !moved
      ? `Started again from their task files (no conversation to resume): ${named(restarted)}.`
      : '',
    restarted.length && moved ? `Started again from their task files: ${named(restarted)}.` : '',
    failed.length
      ? `Failed before the close and not relaunched (the user can restart them from their panels): ${named(failed)}.`
      : '',
    done.length ? `Already finished before the close: ${named(done)}.` : '',
    waiting.length ? `Still waiting for their dependencies: ${named(waiting)}.` : '',
    undelivered
      ? `${undelivered} bus message(s) had not been delivered when the app closed; send again what still matters.`
      : '',
    `Check on the resumed workers before delegating more; new workers are numbered from claude-${nextWorker}.`,
  ]
    .filter(Boolean)
    .join(' ')

  const orchestrator = agents.find((a) => a.id === ORCHESTRATOR)
  launches.unshift({
    agentId: ORCHESTRATOR,
    resume: {
      claudeSessionId: moved ? null : (orchestrator?.claudeSessionId ?? null),
      prompt: notice,
    },
  })
  return { agents, messages, launches, nextWorker, notice }
}
