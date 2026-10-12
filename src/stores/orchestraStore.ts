import { isTauri } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { confirm } from '@tauri-apps/plugin-dialog'
import { customAlphabet } from 'nanoid'
import { create } from 'zustand'

import {
  isScreenBlock,
  runPreflight,
  type ScreenBlockReason,
  screenNotice,
} from '../components/Orchestra/attention/blocking'
import { installScreenWatch } from '../components/Orchestra/attention/screenWatch'
import { installAttention } from '../components/Orchestra/attention/service'
import { creativePromptHint } from '../components/Orchestra/creative/role'
import { chooseOption, dialogOnScreen, type DialogOption } from '../components/Orchestra/dialog'
import { clearSessionDrafts } from '../components/Orchestra/drafts'
import { latestSessionOf } from '../components/Orchestra/projectFlow'
import {
  chunkByCodePoint,
  clipLine,
  deliveredUpTo,
  deliveryProbe,
  notificationKind,
  PASTE_END,
  PASTE_START,
  sanitizeRelay,
} from '../components/Orchestra/relay'
import {
  isConversationId,
  notResumedPrompt,
  type OrchestraManifest,
  type ResumeLaunch,
  resumePlan,
  sameFolder,
} from '../components/Orchestra/resume/manifest'
import { installManifests } from '../components/Orchestra/resume/persist'
import { forgetRetired, MAX_RETIRED, retirePty } from '../components/Orchestra/retiredTerminals'
import { sessionContextOf } from '../components/Orchestra/scribe/contextStore'
import { SCRIBE_ID } from '../components/Orchestra/scribe/identity'
import {
  contextHint,
  type ContextHintInput,
  withObsidianRule,
} from '../components/Orchestra/scribe/rule'
import { installScribe, prepareSessionContext } from '../components/Orchestra/scribe/service'
import { spawnTerminalSize } from '../components/Orchestra/terminalGeometry'
import {
  accountsPromptHint,
  type AccountSwitch,
  agentLaunch,
  ignoredAccount,
  launchArgs,
  type LaunchOptions,
  moveOutcome,
  restoredLaunch,
  type SessionLaunch,
} from '../components/Orchestra/usage/launch'
import {
  sessionLaunchDefaults,
  sessionLaunchOf,
} from '../components/Orchestra/usage/launchDefaults'
import { accountConfigDirCached } from '../lib/claudeAccounts'
import {
  killPty,
  listenPtyActivity,
  listenPtyData,
  listenPtyExit,
  type PtyExitPayload,
  spawnPty,
  writePty,
} from '../lib/tauri'
import { syncAccountMcpServers } from '../lib/tauri/accountMcp'
import { copyConversation } from '../lib/tauri/conversation'
import {
  listenOrchestra,
  orchestraAccountPolicy,
  orchestraEnd,
  type OrchestraEvent,
  orchestraFolderExists,
  type OrchestraHookSummary,
  orchestraManifestRemove,
  orchestraManifestSave,
  orchestraPrepare,
  orchestraReset,
  orchestraResume,
  type OrchestraStatus,
  orchestraWriteTask,
} from '../lib/tauri/orchestra'
import { disposeMirror, ensureMirror, getMirror, whenMirrorReady } from '../lib/terminalMirror'
import { useProjectsStore } from './projectsStore'

export const ORCHESTRATOR_ID = 'orchestrator'

export type OrchestraViewMode =
  'constellation' | 'mission' | 'flow' | 'terminals' | 'timeline' | 'hive'
export const ORCHESTRA_VIEW_MODES: OrchestraViewMode[] = [
  'constellation',
  'mission',
  'flow',
  'terminals',
  'timeline',
  'hive',
]

export type AgentState = OrchestraStatus | 'starting' | 'waiting' | 'exited'

/** What an agent is doing over time; drives the timeline lanes. */
export type ActivityKind =
  'thinking' | 'reading' | 'editing' | 'testing' | 'running' | 'blocked' | 'idle'

export type ActivityLine = {
  at: number
  text: string
  tone: 'tool' | 'ok' | 'error' | 'note' | 'prompt'
}
export type Segment = { agentId: string; kind: ActivityKind; start: number; end: number | null }

/**
 * Where a message routed to an agent's terminal stands: `queued` while the target has no
 * terminal yet (`--after`), `pending` once written and until the target's next prompt shows it,
 * `delivered` when it did, `failed` when it could not get there (it can be sent again).
 */
export type DeliveryStatus = 'queued' | 'pending' | 'delivered' | 'failed'
/** Why a message did not reach its target. */
export type DeliveryFailure = 'unknown' | 'exited' | 'cancelled' | 'write' | 'nobody' | 'stopped'

export type BusMessage = {
  id: number
  at: number
  from: string
  to: string
  text: string
  /** Only on messages routed to terminals; notices and scribe lines have none. */
  delivery?: DeliveryStatus
  failure?: DeliveryFailure
}

/**
 * Why an agent's process is gone: the PTY exit reason, why its launch never got that far, or
 * `stopped` when the user stopped the orchestration while it worked (not a failure).
 */
export type AgentExitReason =
  | 'exited'
  | 'killed'
  | 'suspended'
  | 'restarted'
  | 'launch-failed'
  | 'launch-timeout'
  | 'stopped'
  /** The user cancelled it while it waited for a dependency: kept in the session as cancelled. */
  | 'cancelled'

/**
 * What a blocked agent waits on: Claude Code asking for a permission or answer, its own
 * `orch report blocked`, or a dependency (`--after`) that failed or was cancelled. The rest are
 * `ScreenBlockReason`s: a stuck screen the screen watcher read, or a launch the account
 * preflight held back (`login`, `account`).
 */
export type BlockReason = 'permission' | 'question' | 'report' | 'dependency' | ScreenBlockReason
export type AgentBlock = {
  reason: BlockReason
  /** The question or permission asked, the reported note, or the ids of the failed dependencies. */
  text: string
  at: number
  /** `usage-limit` only: when the limit resets (epoch ms); null when the screen does not say. */
  resetAt?: number | null
}

/** A task the agent already finished; `done` is per task, so new work starts a fresh record. */
export type TaskRecord = {
  task: string
  note: string
  progress: number
  startedAt: number
  finishedAt: number | null
}

export type OrchestraAgent = {
  id: string
  area: string
  task: string
  after: string[]
  ptyId: string | null
  state: AgentState
  progress: number
  note: string
  lines: ActivityLine[]
  files: string[]
  toolCalls: number
  startedAt: number
  finishedAt: number | null
  /** Earlier tasks, oldest first. */
  history: TaskRecord[]
  /** Optional `orch spawn --account/--model/--effort` settings. */
  account: string | null
  model: string | null
  effort: string | null
  /** Process exit code once its terminal is gone; null when unknown or still running. */
  exitCode?: number | null
  exitReason?: AgentExitReason | null
  /** Set while the agent is `blocked`: why, and the question it waits on. */
  blocked?: AgentBlock | null
  /**
   * Busy, but no terminal output and no `orch report` since this moment for longer than the
   * stall limit: shown amber as "stalled?". Null while it shows signs of life.
   */
  stalledSince?: number | null
  /** The agent's Claude conversation, from its hooks; `claude --resume` continues it. */
  claudeSessionId?: string | null
  /** That conversation's JSONL transcript on disk, from its hooks. */
  transcriptPath?: string | null
  /**
   * The account, model and effort its last process ran with (`account` null: Claude Code's own
   * config dir; `model`/`effort` null: the CLI defaults). A resume reuses them, since the
   * conversation lives in that account; null until it first launched.
   */
  launchedWith?: LaunchOptions | null
}

/** One orchestration: its own orchestrator, workers numbered from `claude-1`, bus and view. */
export type OrchestraSession = {
  id: string
  /** Project the session belongs to; its folder is the session cwd. */
  projectId: string | null
  cwd: string | null
  goal: string
  autonomous: boolean
  startedAt: number
  /** Per session, so two visible sessions can show different views. */
  mode: OrchestraViewMode
  agents: OrchestraAgent[]
  messages: BusMessage[]
  segments: Segment[]
  selectedId: string | null
  error: string | null
  /**
   * Set once its agents were stopped: the session stays on screen read-only (views, bus and
   * transcripts) until it is closed.
   */
  stoppedAt?: number | null
  /**
   * Account policy, account, model and effort its agents launch with, copied from the start
   * form; the accounts panel changes the account. Absent only on older sessions: read it with
   * `sessionLaunchOf`.
   */
  launch?: SessionLaunch
  /** Account changes made from the accounts panel, oldest first. */
  accountSwitches?: AccountSwitch[]
  /**
   * The pending "wait for the limit reset" (src/lib/limitResetWatch.ts); kept in the session so
   * a reload or a Resume does not lose it.
   */
  limitWait?: LimitWait | null
}

/**
 * A "wait for the reset" of the session account (`null`: the default one), epoch ms. `auto`:
 * armed by itself when an agent hit the limit (the "wait and continue" preference), not by
 * the owner's "Wait".
 */
export type LimitWait = {
  account: string | null
  resetsAt: number
  auto?: boolean
  /** When the staggered resume of this wait started; the wait stays until nobody is limited. */
  resumedAt?: number
  /** Times the limit came back right after a resume and the wait was armed again (1..3). */
  rearms?: number
}

export type OrchestraState = {
  sessions: Record<string, OrchestraSession>
  /** Tab order, oldest first. */
  order: string[]
  /** Focused session; null shows the start screen. */
  activeId: string | null
  lastAutonomous: boolean
  lastMode: OrchestraViewMode
  /** Start failures not tied to a session. */
  error: string | null
  /** Session shown beside the active one (side-by-side view); null shows one session. */
  splitId: string | null
  /** Pane of the split session; the active session takes the other one. */
  splitSide: 'left' | 'right'
  /** Sessions from the most to the least recently focused; the start screen keeps the order. */
  recent: string[]
  /** Starts a session next to the running ones; resolves to its id, or null on failure. */
  start: (
    cwd: string,
    goal: string,
    autonomous: boolean,
    projectId?: string | null,
  ) => Promise<string | null>
  /**
   * Ends one session and never throws. If it was the active one, the other side-by-side session
   * takes over, else the same project's most recent one, else that project's start screen.
   */
  stop: (sessionId: string) => Promise<void>
  stopAll: () => Promise<void>
  /**
   * Stops every agent of a session but keeps it on screen read-only: views, bus, report and
   * every transcript stay readable and copyable until `stop` closes it. Never throws.
   */
  stopAgents: (sessionId: string) => Promise<void>
  /**
   * Starts an agent again in a new terminal: after a failure, or to start over. With
   * `resume`, Claude Code continues the agent's own conversation when its id is known.
   * `notice` is what the orchestrator is told, in the user's words.
   */
  restartAgent: (
    sessionId: string,
    agentId: string,
    opts?: { resume?: boolean; notice?: string; moveAccount?: boolean },
  ) => Promise<void>
  /**
   * Changes the account a session's agents launch with (`null`: the default account) and
   * records the switch. Workers spawned from now on start there; running agents keep theirs
   * until `restartAgent` with `moveAccount` moves them.
   */
  setSessionAccount: (sessionId: string, account: string | null) => void
  /** Sets or clears the session's pending "wait for the limit reset" (see `LimitWait`). */
  setLimitWait: (sessionId: string, wait: LimitWait | null) => void
  /**
   * A notice from the app to an agent: a bus line, and `[orchestra] <text>` pasted into its
   * terminal through the same queue as messages (it waits for a ready prompt and for any
   * dialog or stuck screen to close). An agent whose process ended just misses it.
   */
  tellAgent: (sessionId: string, agentId: string, text: string) => void
  /**
   * Sends Esc to an agent's terminal: Claude Code stops what it is doing and waits. `notice`
   * is the bus line that records it.
   */
  interruptAgent: (sessionId: string, agentId: string, notice?: string) => Promise<void>
  /**
   * Answers the permission request on an agent's screen with the option the user picked, only
   * if it is still offered as they saw it (see `chooseOption`). Resolves to whether it was
   * answered; `notice` is the bus line that records it.
   */
  answerDialog: (
    sessionId: string,
    agentId: string,
    choice: DialogOption,
    notice?: string,
  ) => Promise<boolean>
  /**
   * A stuck screen the screen watcher read (attention/screenWatch.ts), or null once the screen
   * moved on. Never replaces a block that hooks or the agent itself reported.
   */
  screenBlock: (sessionId: string, agentId: string, block: AgentBlock | null) => void
  /** Marks a busy agent "stalled?" since `since` (no output, no report), or clears it. */
  setStalled: (sessionId: string, agentId: string, since: number | null) => void
  /**
   * Focuses a session (null shows the start screen). In the side-by-side view it replaces the
   * session of the focused pane; the split session's own pane takes the focus instead.
   */
  setActive: (sessionId: string | null) => void
  /** Shows the active session side by side with the previous one, or alone again. */
  toggleSplit: () => void
  setMode: (sessionId: string, mode: OrchestraViewMode) => void
  select: (sessionId: string, agentId: string | null) => void
  /** Sends a message typed by the user (or relayed) into an agent's terminal. */
  sendTo: (sessionId: string, to: string, text: string, from?: string) => Promise<void>
  /**
   * `sendTo` that resolves to where the message stands right after routing it: `queued` for an
   * agent that has not started yet, `pending` once written, `failed` when it cannot get there.
   */
  send: (
    sessionId: string,
    to: string,
    text: string,
    from?: string,
  ) => Promise<{ id: number | null; delivery: DeliveryStatus }>
  /** Routes a failed message again, on the same bus line. */
  resend: (sessionId: string, messageId: number) => Promise<void>
  /**
   * Starts a worker that waits for its dependencies (or is held because one failed) right now.
   * `notice` is what the orchestrator is told, in the user's words.
   */
  startNow: (sessionId: string, agentId: string, notice?: string) => void
  /** Drops a worker that has not started; messages queued for it fail and the orchestrator is told. */
  cancelWaiting: (sessionId: string, agentId: string, notice?: string) => void
  /** Hides the session's error strip. */
  dismissError: (sessionId: string) => void
  /** New input reached the agent (e.g. typed in its PTY): a finished agent starts a new task. */
  reopen: (sessionId: string, agentId: string, task?: string) => void
  /** The Obsidian scribe wrote a block about this session: a bus line, never sent to a PTY. */
  scribeWrote: (sessionId: string, note: string, text: string, at?: number) => void
  /**
   * Brings back an orchestration the app was closed on, under its own id: every unfinished
   * agent is relaunched in its folder, account and model (`claude --resume` when its
   * conversation is known) and the orchestrator is told what came back. Its folder must still
   * exist; `cwd` resumes it in the folder the user picked instead (agents start over there).
   * Resolves to the session id, or null when it could not start.
   */
  resume: (manifest: OrchestraManifest, options?: { cwd?: string }) => Promise<string | null>
}

const MODE_KEY = 'orchestra.viewMode'
const MAX_LINES = 60
const MAX_MESSAGES = 400
const MAX_SEGMENTS = 2000
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'])

type PaneState = Pick<OrchestraState, 'sessions' | 'activeId' | 'splitId' | 'splitSide'>

/** The split session while the side-by-side view is on screen: both sessions alive and distinct. */
export function splitPartnerId(state: PaneState): string | null {
  const { sessions, activeId, splitId } = state
  return activeId && splitId && splitId !== activeId && sessions[activeId] && sessions[splitId]
    ? splitId
    : null
}

/** Sessions on screen from left to right: none (start screen), the active one, or a split pair. */
export function shownSessionIds(state: PaneState): string[] {
  const { sessions, activeId, splitSide } = state
  if (!activeId || !sessions[activeId]) return []
  const partner = splitPartnerId(state)
  if (!partner) return [activeId]
  return splitSide === 'left' ? [partner, activeId] : [activeId, partner]
}

/** `recent` with `id` moved to the front. */
const touch = (recent: string[], id: string) => [id, ...recent.filter((r) => r !== id)]

/** `o` + 7 of [a-z0-9]: a valid backend id (1-32 of [a-z0-9-]) that can never be `default`. */
const sessionSuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 7)
const newSessionId = () => `o${sessionSuffix()}`

function loadMode(): OrchestraViewMode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved && (ORCHESTRA_VIEW_MODES as string[]).includes(saved))
      return saved as OrchestraViewMode
  } catch {
    // Storage can be unavailable; fall back to the default view.
  }
  return 'constellation'
}

function singleLine(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * How agents run the `orch` bridge. `orch` is the sh shim in bash and `orch.ps1` in PowerShell
 * (in-process, so arguments arrive as typed); only `orch.cmd` goes through cmd.exe. Free text a
 * shell could mangle travels in a file. `cli` is the path of `orch.cmd`; the others sit beside it.
 * The symbols are spelled out: this text itself crosses a command line.
 */
function orchUsage(cli: string): string {
  const dir = cli.replace(/\\/g, '/').replace(/\/[^/]*$/, '')
  return singleLine(`Run the orch commands in your shell: "orch" works in bash and in PowerShell, "orch.cmd" in
  cmd (they are in "${dir}"; if PowerShell refuses to run scripts, use orch.cmd). Long text, or text with
  quotes, ampersands, pipes, angle brackets, percent signs or line breaks, goes in a UTF-8 file passed with
  --file <path> instead of on the command line (or piped in with --stdin), e.g. "orch send orchestrator --file
  msg.md".`)
}

/** `context` is the session's Obsidian context: the prompt points to the file it was saved to. */
export function orchestratorPrompt(cli: string, context?: ContextHintInput): string {
  return withObsidianRule(
    [
      singleLine(`You are the ORCHESTRATOR inside Alethe Orchestra. The user gives you a goal; break it into
  independent tasks and delegate each one to a worker Claude session instead of doing the work yourself.
  ${orchUsage(cli)} "orch spawn <area> [--after claude-N] <task>" (or "orch spawn <area> --file task.md")
  starts a worker and prints its id (use --after when a task depends on another worker finishing); write
  long tasks to a file. "orch send <claude-N|all> <message>" messages workers;
  "orch report <0-100> [thinking|editing|testing|blocked|done] <note>" reports overall progress.
  Workers share this directory: give each one a disjoint set of files and a self-contained task with clear
  acceptance criteria. Worker messages and completion notices arrive in your terminal prefixed with [orchestra].
  Keep between 2 and 6 workers, review their results, resolve conflicts, and ask the user only when truly blocked.`),
      contextHint('orchestrator', context),
    ]
      .filter(Boolean)
      .join(' '),
  )
}

export function workerPrompt(
  id: string,
  area: string,
  cli: string,
  context?: ContextHintInput,
): string {
  return withObsidianRule(
    [
      singleLine(`You are ${id}, a worker inside Alethe Orchestra focused on "${area}". Do only your task and
  only touch files in your scope; other workers edit this directory in parallel. Report progress often with
  "orch report <0-100> <thinking|editing|testing|blocked|done> <short note>": at start, at each milestone,
  and finish with "orch report 100 done <one-line summary>". Use "orch send orchestrator <message>" (or send
  to another claude-N) to coordinate; when blocked, report blocked and ask the orchestrator instead of
  guessing. ${orchUsage(cli)} Messages to you arrive prefixed with [orchestra].`),
      contextHint('worker', context),
    ]
      .filter(Boolean)
      .join(' '),
  )
}

/** Saves an agent's task (or the goal) to the file it is told to read; null when it cannot. */
async function writeTaskFile(
  sessionId: string,
  agentId: string,
  text: string,
): Promise<string | null> {
  try {
    return await orchestraWriteTask(sessionId, agentId, text)
  } catch (error) {
    console.warn('[orchestra] task file not written; the task goes on the command line', error)
    return null
  }
}

/**
 * First message of a launch. The task (the goal, for the orchestrator) is saved to a file the
 * agent is told to read, so its text never crosses a command line, where PowerShell 5.1 and
 * cmd.exe mangle quotes, `%`, `&` and line breaks; without the file it goes inline, on one line.
 * A resumed agent gets its resume prompt instead, since its conversation already has the task.
 */
export async function firstMessage(
  sessionId: string,
  agentId: string,
  text: string,
  resume?: ResumeLaunch,
): Promise<string> {
  const task = text.trim()
  const file = task ? await writeTaskFile(sessionId, agentId, task) : null
  const isOrchestrator = agentId === ORCHESTRATOR_ID
  const pointer = !file
    ? singleLine(task)
    : isOrchestrator
      ? `Read the user's goal in "${file}", then plan it and delegate it to workers.`
      : `Read your task in "${file}" and then do it.`
  if (!resume) return pointer
  if (!resume.claudeSessionId) {
    // Started over, not from scratch: an orchestrator planning its goal again duplicates workers.
    const start = isOrchestrator && file ? `The user's goal is in "${file}".` : pointer
    return [singleLine(resume.prompt), start].filter(Boolean).join(' ')
  }
  const reminder = !file
    ? ''
    : isOrchestrator
      ? ` The goal is still in "${file}".`
      : ` Your task is still in "${file}".`
  return `${singleLine(resume.prompt)}${reminder}`
}

/** Longest an agent launch waits for its mirror to listen; a slow IPC never blocks the spawn. */
const MIRROR_READY_TIMEOUT_MS = 1500

/**
 * Creates the PTY's mirror before the process exists, so it parses every byte at the PTY's own
 * size, and waits until it listens. A mirror failure must never keep an agent from starting.
 */
async function startMirror(ptyId: string, size: { cols: number; rows: number }): Promise<void> {
  try {
    ensureMirror(ptyId, size)
  } catch (error) {
    console.warn('[orchestra] terminal mirror unavailable', error)
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MIRROR_READY_TIMEOUT_MS)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    whenMirrorReady(ptyId).then(done, done)
  })
}

/** The tail of the writes queued for each PTY; two pastes into one terminal never interleave. */
const writeQueues = new Map<string, Promise<unknown>>()

function queueWrite<T>(ptyId: string, job: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(ptyId) ?? Promise.resolve()
  const next = previous.then(job, job)
  const tail = next.catch(() => undefined)
  writeQueues.set(ptyId, tail)
  void tail.then(() => {
    if (writeQueues.get(ptyId) === tail) writeQueues.delete(ptyId)
  })
  return next
}

/** A paste that found a dialog on its terminal: it waits instead of answering the dialog. */
class HeldByDialog extends Error {}

/**
 * Bracketed paste followed by Enter, after every earlier write to the same PTY. Control
 * characters are stripped, chunks never split a code point, and the paste is always closed,
 * even when a write fails halfway (the terminal would stay in paste mode); only a complete
 * text is submitted. `promptIsClear` is asked right before the first byte: Enter must never
 * reach a dialog (it would pick the option under its cursor, "Yes" on a permission request).
 */
async function pasteInto(
  ptyId: string,
  text: string,
  promptIsClear?: () => boolean,
): Promise<void> {
  const body = sanitizeRelay(text)
  await queueWrite(ptyId, async () => {
    if (promptIsClear && !promptIsClear()) throw new HeldByDialog()
    try {
      await writePty(ptyId, PASTE_START)
      for (const part of chunkByCodePoint(body)) await writePty(ptyId, part)
    } catch (error) {
      await writePty(ptyId, PASTE_END).catch(() => {})
      throw error
    }
    await writePty(ptyId, PASTE_END)
    await writePty(ptyId, '\r')
  })
}

function activityFromHook(hook: OrchestraHookSummary): ActivityKind | null {
  switch (hook.hook_event_name) {
    case 'UserPromptSubmit':
      return 'thinking'
    case 'Stop':
      return 'idle'
    case 'Notification': {
      const kind = notificationKind(hook)
      return kind === 'idle' ? 'idle' : kind === 'info' ? null : 'blocked'
    }
    case 'PreToolUse': {
      const tool = hook.tool_name ?? ''
      if (READ_TOOLS.has(tool)) return 'reading'
      if (FILE_TOOLS.has(tool)) return 'editing'
      if (tool === 'Bash' || tool === 'PowerShell') {
        return /test|jest|vitest|pytest|cargo t/i.test(hook.target ?? '') ? 'testing' : 'running'
      }
      return 'thinking'
    }
    default:
      return null
  }
}

function lineFromHook(hook: OrchestraHookSummary): string | null {
  switch (hook.hook_event_name) {
    case 'PreToolUse':
      return `● ${hook.tool_name ?? 'tool'}(${hook.target ?? ''})`
    case 'PostToolUse':
      return hook.failed ? `✗ ${hook.tool_name ?? 'tool'} failed` : null
    case 'UserPromptSubmit':
      return hook.prompt ? `> ${hook.prompt}` : null
    case 'Notification':
      return hook.message ? `! ${hook.message}` : null
    case 'Stop':
      return hook.last_assistant_message ? `✓ ${hook.last_assistant_message}` : '✓ turn finished'
    default:
      return null
  }
}

function newAgent(
  id: string,
  area: string,
  task: string,
  after: string[],
  at: number,
  state: AgentState,
  settings: { account?: string | null; model?: string | null; effort?: string | null } = {},
): OrchestraAgent {
  return {
    id,
    area,
    task,
    after,
    ptyId: null,
    state,
    progress: 0,
    note: '',
    lines: task ? [{ at, text: `> ${task}`, tone: 'prompt' }] : [],
    files: [],
    toolCalls: 0,
    startedAt: at,
    finishedAt: null,
    history: [],
    account: settings.account ?? null,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    exitCode: null,
    exitReason: null,
    blocked: null,
    claudeSessionId: null,
    transcriptPath: null,
  }
}

/** The Claude conversation a hook names, where the agent did not have it yet; `{}` when none. */
export function conversationPatch(
  agent: OrchestraAgent,
  hook: OrchestraHookSummary,
): Partial<OrchestraAgent> {
  const patch: Partial<OrchestraAgent> = {}
  // Only a UUID: it ends up as `claude --resume <id>` on a command line.
  if (isConversationId(hook.session_id) && hook.session_id !== agent.claudeSessionId)
    patch.claudeSessionId = hook.session_id
  if (hook.transcript_path && hook.transcript_path !== agent.transcriptPath)
    patch.transcriptPath = hook.transcript_path
  return patch
}

/**
 * New input for an agent. A `done` agent archives its finished task in `history` and starts
 * over (thinking, 0%); an agent that is still working only keeps going. Returns the patch.
 */
export function reopenAgent(
  agent: OrchestraAgent,
  at: number,
  task?: string,
): Partial<OrchestraAgent> {
  if (agent.state !== 'done') return {}
  const record: TaskRecord = {
    task: agent.task,
    note: agent.note,
    progress: agent.progress,
    startedAt: agent.startedAt,
    finishedAt: agent.finishedAt,
  }
  const next = task ? singleLine(task) : ''
  return {
    history: [...agent.history, record],
    task: next || agent.task,
    state: 'thinking',
    progress: 0,
    note: '',
    files: [],
    toolCalls: 0,
    startedAt: at,
    finishedAt: null,
  }
}

const RELAY_PREFIX = /^\[orchestra · from [^\]]*\]\s*/

/**
 * The task text implied by input that reached an agent: relay prefixes are dropped, and
 * notices (`finished: ...`, `failed: ...`, `not delivered: ...`, `not resumed: ...`) are
 * bookkeeping, so they keep the current task.
 */
export function taskFromInput(text: string | undefined): string | undefined {
  const clean = singleLine((text ?? '').replace(RELAY_PREFIX, ''))
  if (!clean || /^(finished|turn finished|failed|not delivered|not resumed): /.test(clean)) {
    return undefined
  }
  return clean
}

type ReportEvent = Extract<OrchestraEvent, { kind: 'report' }>

/**
 * How an `orch report` changes an agent; a non-final report after `done` means a new task.
 * Reporting `blocked` records the note as what it waits on; any other report ends the block.
 */
export function applyReport(agent: OrchestraAgent, event: ReportEvent): Partial<OrchestraAgent> {
  const finishing = event.status === 'done' || event.progress === 100
  if (finishing) {
    return {
      progress: 100,
      state: 'done',
      note: event.note || agent.note,
      finishedAt: event.at,
      blocked: null,
    }
  }
  const reopened = reopenAgent(agent, event.at)
  const base = { ...agent, ...reopened }
  const state = event.status ?? base.state
  return {
    ...reopened,
    progress: event.progress ?? base.progress,
    state,
    note: event.note || base.note,
    blocked:
      state !== 'blocked'
        ? null
        : event.status === 'blocked'
          ? { reason: 'report', text: event.note || base.note, at: event.at }
          : (base.blocked ?? null),
  }
}

/**
 * Asks before ending the session. Uses the dialog plugin (the webview's `window.confirm` is
 * routed through it and rejects when the ACL lacks `dialog:allow-confirm`), falling back to
 * a plain synchronous confirm. A rejection must never escape: it used to surface as an
 * unhandled error while the stop went ahead without asking. With no working dialog at all
 * the explicit click wins, so the session can still be ended.
 */
export async function confirmStop(
  message: string,
  opts: { title?: string; okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  try {
    return await confirm(message, { kind: 'warning', ...opts })
  } catch {
    try {
      const answer: unknown = window.confirm(message)
      if (typeof answer === 'boolean') return answer
      if (answer instanceof Promise) {
        const settled: unknown = await answer.catch(() => undefined)
        if (typeof settled === 'boolean') return settled
      }
    } catch {
      // No dialog available at all.
    }
    return true
  }
}

/**
 * Bookkeeping of a running session that stays out of React state. Session ids are never
 * reused, so the record's identity is the session's generation: async work started before a
 * stop compares it and drops its result.
 */
type SessionRuntime = {
  exitUnlisteners: Map<string, UnlistenFn>
  messageSeq: number
}

const runtimes = new Map<string, SessionRuntime>()

/** A message written to an agent's terminal, waiting for the agent's next prompt to show it. */
type AwaitedPrompt = { messageId: number; probe: string }
/**
 * A message for an agent whose prompt does not take input now (not up yet, or a dialog is
 * open); `messageId` is null for a notice, which is not tracked on the bus.
 */
type QueuedMessage = { messageId: number | null; pasted: string; task: string | undefined }

/** Per-session delivery and launch bookkeeping, created on first use. */
type SessionTracking = {
  /** Written messages per target agent, oldest first. */
  awaiting: Map<string, AwaitedPrompt[]>
  /** Messages per target agent that has no terminal taking input yet, oldest first. */
  queued: Map<string, QueuedMessage[]>
  /** Targets of each routed message still owed a delivery, and how many got it. */
  tally: Map<number, { remaining: number; delivered: number; failure: DeliveryFailure | null }>
  /** Agents whose terminal has shown a sign of life (output or a hook). */
  alive: Set<string>
  /** Agents whose prompt takes input: queued messages can be written. */
  ready: Set<string>
  /**
   * Agents whose current process sent a hook: Claude Code runs it (a `--resume` found its
   * conversation). Unlike `ready`, a dialog or a held message never clears it.
   */
  hooked: Set<string>
  /**
   * Agents Claude Code reported idle at their prompt (Stop, idle notification) with nothing
   * since: no dialog is open, whatever the screen reader makes of their screen.
   */
  atPrompt: Set<string>
  /** Agents the user cancelled while they waited for a dependency. */
  cancelled: Set<string>
  /** Current launch of each agent; a superseded or timed-out launch drops its result. */
  launches: Map<string, symbol>
  timers: Set<ReturnType<typeof setTimeout>>
  cleanups: Set<() => void>
}

const trackingByRuntime = new WeakMap<SessionRuntime, SessionTracking>()

/** Sessions whose Stop is still ending their processes. */
const stopping = new Set<string>()
/** Agents being restarted, as `session agent`. */
const restarting = new Set<string>()

/**
 * Every PTY a session ever launched (restarts included), so closing it frees every mirror even
 * after its runtime is gone (a stopped session is read-only, without one).
 */
const sessionPtys = new Map<string, Set<string>>()

function rememberPty(sessionId: string, ptyId: string): void {
  const ptys = sessionPtys.get(sessionId) ?? new Set<string>()
  ptys.add(ptyId)
  sessionPtys.set(sessionId, ptys)
}

function tracking(runtime: SessionRuntime): SessionTracking {
  let value = trackingByRuntime.get(runtime)
  if (!value) {
    value = {
      awaiting: new Map(),
      queued: new Map(),
      tally: new Map(),
      alive: new Set(),
      ready: new Set(),
      hooked: new Set(),
      atPrompt: new Set(),
      cancelled: new Set(),
      launches: new Map(),
      timers: new Set(),
      cleanups: new Set(),
    }
    trackingByRuntime.set(runtime, value)
  }
  return value
}

/** Longest an agent may take from its launch to a first output or hook before it counts as failed. */
export const LAUNCH_WATCHDOG_MS = 30_000
/** After the first output, how long a terminal gets to show its prompt before queued messages go in. */
const INPUT_READY_MS = 4000
const NOTE_PREVIEW = 160
/** Longest goal taken from the orchestrator's first prompt when the session started without one. */
const GOAL_FROM_PROMPT_MAX = 500
/** First message of an agent the user resumed in its own conversation after it went down. */
export const RESTARTED_IN_PLACE_PROMPT =
  '[orchestra] Your terminal ended before you reported done, and the user restarted you in this ' +
  'same conversation. Continue your task where you left off and keep reporting with orch report.'

/** Longest note or question of a worker quoted to a restarted orchestrator. */
const RESTART_NOTE_MAX = 120

/** Where a worker stands, in the words a restarted orchestrator reads. */
function workerStanding(agent: OrchestraAgent): string {
  if (agent.state === 'done') return 'done'
  if (agent.state === 'exited') {
    return agent.exitCode == null ? 'failed' : `failed (exit code ${agent.exitCode})`
  }
  if (agent.exitReason === 'stopped') return 'stopped'
  if (agent.state === 'waiting') return `waiting for ${agent.after.join(', ')}`
  if (agent.state === 'blocked') {
    const asked = agent.blocked?.text ? `: ${clipLine(agent.blocked.text, RESTART_NOTE_MAX)}` : ''
    return `blocked${asked}`
  }
  if (agent.state === 'starting') return 'starting'
  return `${agent.state === 'idle' ? 'idle' : 'working'} at ${agent.progress}%`
}

/**
 * Worker-written text (notes, questions, areas) in a prompt that goes on the command line:
 * double quotes become single ones, so a `.cmd` launcher run through cmd.exe never sees `&`,
 * `|`, `<` or `>` outside the argument's quotes.
 */
function commandLineText(text: string): string {
  return text.replace(/"/g, "'")
}

/**
 * First message of an orchestrator the user restarted: where every worker stands, so it keeps
 * coordinating them instead of planning the goal again (which would spawn duplicates). Back in
 * its own conversation it only needs the news; in a new one it also learns its history is gone.
 * It goes on the command line, so the workers' own words lose their double quotes.
 */
export function orchestratorRestartPrompt(
  agents: readonly OrchestraAgent[],
  inPlace: boolean,
): string {
  const standing = agents
    .filter((a) => a.id !== ORCHESTRATOR_ID)
    .map((w) => {
      const note =
        w.note && w.state !== 'blocked' ? ` (last note: ${clipLine(w.note, RESTART_NOTE_MAX)})` : ''
      return `${w.id} [${w.area}] ${workerStanding(w)}${note}`
    })
  return commandLineText(
    [
      inPlace
        ? '[orchestra] Your terminal ended and the user restarted you in this same conversation.'
        : '[orchestra] Your terminal ended and the user restarted you in a new conversation: your ' +
          'earlier messages are gone, your workers are not.',
      standing.length ? `Your workers now: ${standing.join('; ')}.` : 'No worker was spawned yet.',
      standing.length
        ? 'Do not plan the goal again and do not spawn workers for what is running or done: ' +
          'check on them with orch and keep coordinating from where they are.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  )
}

/** A block only its own agent ends: its `orch report blocked`, or a failed dependency. */
function heldBlock(agent: OrchestraAgent): boolean {
  return (
    agent.state === 'blocked' &&
    (agent.blocked?.reason === 'report' || agent.blocked?.reason === 'dependency')
  )
}

/**
 * Its process is gone: it failed, it ended after reporting done, or the user stopped it. Its
 * transcript stays; nothing can be written to it, and no view may start it again.
 */
export function processEnded(agent: Pick<OrchestraAgent, 'state' | 'exitReason'>): boolean {
  return agent.state === 'exited' || agent.exitReason != null
}

/** Hooks reported a permission request or a question on screen: its prompt takes no input. */
function inDialog(agent: OrchestraAgent | undefined): boolean {
  return (
    agent?.state === 'blocked' &&
    (agent.blocked?.reason === 'permission' ||
      agent.blocked?.reason === 'question' ||
      // A stuck screen (trust dialog, login, a menu) would take a paste as its answer.
      isScreenBlock(agent.blocked))
  )
}
/** The app's single bus subscription: open while any session runs, events carry their session. */
let unlistenBus: UnlistenFn | null = null
let busOpening: Promise<void> | null = null
/** Other followers of the bus (the scribe); they only see events of running sessions. */
const busTaps = new Set<(event: OrchestraEvent) => void>()

/** Ending a session must never throw, so a failing cleanup step is only logged. */
function safely(step: () => void): void {
  try {
    step()
  } catch (error) {
    console.warn('[orchestra] cleanup step failed', error)
  }
}

/** The name of an account id for messages; null is the default account. */
export function accountLabel(account: string | null): string | null {
  if (!account) return null
  const accounts = useProjectsStore.getState().preferences.claudeAccounts ?? []
  return accounts.find((a) => a.id === account)?.name ?? account
}

/** Tells the backend how the session uses accounts; a failure only loses the spawn notice. */
async function shareAccountPolicy(sessionId: string, launch: SessionLaunch): Promise<void> {
  await settle(() =>
    orchestraAccountPolicy(sessionId, launch.policy === 'single', accountLabel(launch.account)),
  )
}

/** `CLAUDE_CONFIG_DIR` of an account for `copyConversation`; '' is the default account. */
function accountDirOf(account: string | null): string | null {
  return account ? accountConfigDirCached(account) : ''
}

async function settle(step: () => Promise<unknown>): Promise<void> {
  try {
    await step()
  } catch (error) {
    console.warn('[orchestra] cleanup step failed', error)
  }
}

function releaseBusWhenIdle(): void {
  if (runtimes.size > 0 || !unlistenBus) return
  const unlisten = unlistenBus
  unlistenBus = null
  safely(unlisten)
}

export const useOrchestraStore = create<OrchestraState>((set, get) => {
  /** Patches one session; a missing session or a null patch leaves the state untouched. */
  const patchSession = (
    sessionId: string,
    patch: (session: OrchestraSession) => Partial<OrchestraSession> | null,
  ) =>
    set((state) => {
      const session = state.sessions[sessionId]
      const changes = session ? patch(session) : null
      if (!session || !changes) return state
      return { sessions: { ...state.sessions, [sessionId]: { ...session, ...changes } } }
    })

  const patchAgent = (
    sessionId: string,
    agentId: string,
    patch: (agent: OrchestraAgent) => Partial<OrchestraAgent>,
  ) =>
    patchSession(sessionId, (s) => {
      let changed = false
      const agents = s.agents.map((a) => {
        if (a.id !== agentId) return a
        const next = patch(a)
        if (Object.keys(next).length === 0) return a
        changed = true
        return { ...a, ...next }
      })
      return changed ? { agents } : null
    })

  const agentOf = (sessionId: string, agentId: string) =>
    get().sessions[sessionId]?.agents.find((a) => a.id === agentId)

  const pushLine = (sessionId: string, agentId: string, line: ActivityLine) =>
    patchAgent(sessionId, agentId, (a) => ({ lines: [...a.lines, line].slice(-MAX_LINES) }))

  const setActivity = (sessionId: string, agentId: string, kind: ActivityKind, at: number) =>
    patchSession(sessionId, (s) => {
      const segments = s.segments.slice()
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].agentId === agentId && segments[i].end === null) {
          if (segments[i].kind === kind) return null
          segments[i] = { ...segments[i], end: at }
          break
        }
      }
      segments.push({ agentId, kind, start: at, end: null })
      return { segments: segments.slice(-MAX_SEGMENTS) }
    })

  /** New input reached an agent; a finished one starts a new task (see `reopenAgent`). */
  const reopen = (sessionId: string, agentId: string, at: number, task?: string) => {
    if (agentOf(sessionId, agentId)?.state !== 'done') return
    patchAgent(sessionId, agentId, (a) => reopenAgent(a, at, task))
    setActivity(sessionId, agentId, 'thinking', at)
  }

  /** Adds a bus line; `delivery` marks a message that is routed to terminals. Returns its id. */
  const recordMessage = (
    sessionId: string,
    from: string,
    to: string,
    text: string,
    at = Date.now(),
    delivery?: DeliveryStatus,
  ): number | null => {
    const runtime = runtimes.get(sessionId)
    if (!runtime) return null
    const message: BusMessage = { id: ++runtime.messageSeq, at, from, to, text }
    if (delivery) message.delivery = delivery
    patchSession(sessionId, (s) => ({ messages: [...s.messages, message].slice(-MAX_MESSAGES) }))
    return message.id
  }

  const patchMessage = (sessionId: string, messageId: number, patch: Partial<BusMessage>) =>
    patchSession(sessionId, (s) => {
      const index = s.messages.findIndex((m) => m.id === messageId)
      if (index === -1) return null
      const messages = s.messages.slice()
      messages[index] = { ...messages[index], ...patch }
      return { messages }
    })

  const runtimeOf = (sessionId: string) => {
    const runtime = runtimes.get(sessionId)
    return runtime ? { runtime, track: tracking(runtime) } : null
  }

  /**
   * One target of a routed message is settled. The message is delivered once every target got
   * it (at least one did), and failed when none could.
   */
  const settleTarget = (
    sessionId: string,
    messageId: number,
    outcome: 'delivered' | DeliveryFailure,
  ) => {
    const ctx = runtimeOf(sessionId)
    const entry = ctx?.track.tally.get(messageId)
    if (!ctx || !entry) return
    entry.remaining = Math.max(0, entry.remaining - 1)
    if (outcome === 'delivered') entry.delivered += 1
    else entry.failure = outcome
    if (entry.remaining > 0) return
    ctx.track.tally.delete(messageId)
    patchMessage(
      sessionId,
      messageId,
      entry.delivered > 0
        ? { delivery: 'delivered', failure: undefined }
        : { delivery: 'failed', failure: entry.failure ?? 'write' },
    )
  }

  /** Text as the target's terminal gets it; a relay from another agent says who sent it. */
  const pastedText = (from: string, text: string) =>
    from === 'you' ? text : `[orchestra · from ${from}] ${text}`

  /**
   * Whether a paste may go into an agent's terminal right now: Claude Code said it idles at its
   * prompt, or no dialog is on its screen (Claude Code tells hooks about a permission request
   * only seconds after showing it).
   */
  const promptIsClear = (sessionId: string, agentId: string, ptyId: string) => () =>
    Boolean(runtimeOf(sessionId)?.track.atPrompt.has(agentId)) || !dialogOnScreen(ptyId)

  /** Keeps a message (or notice) until the agent's prompt takes input again, oldest first. */
  const hold = (sessionId: string, agentId: string, entry: QueuedMessage) => {
    const ctx = runtimeOf(sessionId)
    if (!ctx) return
    ctx.track.ready.delete(agentId)
    const queue = ctx.track.queued.get(agentId) ?? []
    queue.push(entry)
    ctx.track.queued.set(agentId, queue)
    if (entry.messageId !== null) patchMessage(sessionId, entry.messageId, { delivery: 'queued' })
  }

  /** Writes a routed message into a terminal that takes input and waits for its prompt. */
  const writeMessage = async (
    sessionId: string,
    target: OrchestraAgent,
    messageId: number,
    pasted: string,
    task: string | undefined,
  ) => {
    const ctx = runtimeOf(sessionId)
    const ptyId = target.ptyId
    if (!ctx || !ptyId) return
    // Registered before the write: the prompt can arrive before the write call returns.
    const awaited: AwaitedPrompt = { messageId, probe: deliveryProbe(pasted) }
    const list = ctx.track.awaiting.get(target.id) ?? []
    list.push(awaited)
    ctx.track.awaiting.set(target.id, list)
    patchMessage(sessionId, messageId, { delivery: 'pending' })
    try {
      await pasteInto(ptyId, pasted, promptIsClear(sessionId, target.id, ptyId))
      reopen(sessionId, target.id, Date.now(), task)
    } catch (error) {
      const current = ctx.track.awaiting.get(target.id)
      const index = current?.indexOf(awaited) ?? -1
      if (current && index !== -1) {
        current.splice(index, 1)
        if (error instanceof HeldByDialog) hold(sessionId, target.id, { messageId, pasted, task })
        else settleTarget(sessionId, messageId, 'write')
      }
    }
  }

  /** Sends one routed message to its targets: written, queued for a later start, or failed. */
  const route = async (
    sessionId: string,
    messageId: number,
    from: string,
    to: string,
    text: string,
  ) => {
    const ctx = runtimeOf(sessionId)
    if (!ctx) return
    const agents = get().sessions[sessionId]?.agents ?? []
    const targets =
      to === 'all'
        ? agents.filter((a) => a.id !== from && a.id !== ORCHESTRATOR_ID && !processEnded(a))
        : agents.filter((a) => a.id === to)
    if (targets.length === 0) {
      const failure: DeliveryFailure =
        to === 'all' ? 'nobody' : ctx.track.cancelled.has(to) ? 'cancelled' : 'unknown'
      patchMessage(sessionId, messageId, { delivery: 'failed', failure })
      tellSender(sessionId, from, to, failure)
      return
    }
    ctx.track.tally.set(messageId, { remaining: targets.length, delivered: 0, failure: null })
    const pasted = pastedText(from, text)
    const task = taskFromInput(text)
    for (const target of targets) {
      // Also a worker whose process ended after reporting done: it would never read it.
      if (processEnded(target)) {
        settleTarget(sessionId, messageId, 'exited')
        tellSender(sessionId, from, target.id, 'exited')
      } else if (!target.ptyId || !ctx.track.ready.has(target.id) || inDialog(target)) {
        hold(sessionId, target.id, { messageId, pasted, task })
      } else {
        await writeMessage(sessionId, target, messageId, pasted, task)
      }
    }
  }

  /** Records a message on the bus and routes it to the terminals of its target. */
  const post = async (
    sessionId: string,
    from: string,
    to: string,
    text: string,
    at = Date.now(),
  ): Promise<{ id: number | null; delivery: DeliveryStatus }> => {
    const id = recordMessage(sessionId, from, to, text, at, 'pending')
    if (id === null) return { id, delivery: 'failed' }
    await route(sessionId, id, from, to, text)
    const message = get().sessions[sessionId]?.messages.find((m) => m.id === id)
    return { id, delivery: message?.delivery ?? 'pending' }
  }

  /**
   * Writes a notice into an agent's terminal (`[orchestra · from X] ...`); not tracked on the
   * bus. It waits like a message while the prompt takes no input: a terminal still starting (an
   * orchestrator being restarted has none for a while) or a dialog open. An agent whose process
   * ended just misses it.
   */
  const notifyAgent = (sessionId: string, from: string, to: string, text: string) =>
    pasteNotice(sessionId, to, `[orchestra · from ${from}] ${text}`, text)

  /** `notifyAgent` with the whole pasted line given (`[orchestra] ...` for app notices). */
  const pasteNotice = async (sessionId: string, to: string, pasted: string, text: string) => {
    const ctx = runtimeOf(sessionId)
    const target = agentOf(sessionId, to)
    if (!ctx || !target || processEnded(target)) return
    const entry: QueuedMessage = { messageId: null, pasted, task: taskFromInput(text) }
    if (!target.ptyId || !ctx.track.ready.has(to) || inDialog(target)) hold(sessionId, to, entry)
    else await writeNotice(sessionId, target, entry)
  }

  const writeNotice = async (sessionId: string, target: OrchestraAgent, entry: QueuedMessage) => {
    const ptyId = target.ptyId
    if (!ptyId) return
    try {
      await pasteInto(ptyId, entry.pasted, promptIsClear(sessionId, target.id, ptyId))
      reopen(sessionId, target.id, Date.now(), entry.task)
    } catch (error) {
      if (error instanceof HeldByDialog) hold(sessionId, target.id, entry)
    }
  }

  /** An agent's message could not be delivered: tell the agent that sent it. */
  const tellSender = (sessionId: string, from: string, to: string, failure: DeliveryFailure) => {
    if (from === 'you' || from === to || !agentOf(sessionId, from)) return
    const why =
      failure === 'unknown'
        ? 'no such agent in this orchestration'
        : failure === 'cancelled'
          ? 'it was cancelled'
          : failure === 'nobody'
            ? 'no worker can receive it'
            : 'its terminal has exited'
    void notifyAgent(sessionId, 'orchestra', from, `not delivered: message to ${to}, ${why}`)
  }

  /** The target's prompt shows the messages written to it: they are delivered. */
  const confirmDelivery = (sessionId: string, agentId: string, prompt: string | undefined) => {
    const ctx = runtimeOf(sessionId)
    const list = ctx?.track.awaiting.get(agentId)
    if (!ctx || !list?.length) return
    const upTo = deliveredUpTo(
      list.map((entry) => entry.probe),
      prompt,
    )
    if (upTo < 0) return
    for (const entry of list.splice(0, upTo + 1))
      settleTarget(sessionId, entry.messageId, 'delivered')
  }

  /** Everything written or queued for an agent that will never read it fails. */
  const failDeliveriesTo = (sessionId: string, agentId: string, failure: DeliveryFailure) => {
    const ctx = runtimeOf(sessionId)
    if (!ctx) return
    const pending = [
      ...(ctx.track.awaiting.get(agentId) ?? []),
      ...(ctx.track.queued.get(agentId) ?? []),
    ]
    ctx.track.awaiting.delete(agentId)
    ctx.track.queued.delete(agentId)
    for (const { messageId } of pending) {
      if (messageId !== null) settleTarget(sessionId, messageId, failure)
    }
  }

  /**
   * The agent's prompt takes input: queued messages and notices go in, oldest first. Not while
   * hooks report a dialog; one that shows up meanwhile holds the rest again.
   */
  const becomeReady = async (sessionId: string, agentId: string) => {
    const ctx = runtimeOf(sessionId)
    if (!ctx || ctx.track.ready.has(agentId) || inDialog(agentOf(sessionId, agentId))) return
    ctx.track.ready.add(agentId)
    const queue = ctx.track.queued.get(agentId) ?? []
    ctx.track.queued.delete(agentId)
    for (const [index, entry] of queue.entries()) {
      const target = agentOf(sessionId, agentId)
      if (!target?.ptyId || processEnded(target)) {
        if (entry.messageId !== null) settleTarget(sessionId, entry.messageId, 'exited')
        continue
      }
      if (!ctx.track.ready.has(agentId) || inDialog(target)) {
        for (const rest of queue.slice(index)) hold(sessionId, agentId, rest)
        return
      }
      if (entry.messageId === null) await writeNotice(sessionId, target, entry)
      else await writeMessage(sessionId, target, entry.messageId, entry.pasted, entry.task)
    }
  }

  /**
   * First output or hook of an agent's terminal: it runs. `starting` becomes thinking when it
   * got a prompt at launch, else idle; hooks then set the real state. A first hook means the
   * prompt takes input; after a first output the terminal gets a moment to show its prompt.
   */
  const markAlive = (
    sessionId: string,
    agentId: string,
    via: 'output' | 'hook',
    at = Date.now(),
  ) => {
    const ctx = runtimeOf(sessionId)
    if (!ctx) return
    if (!ctx.track.alive.has(agentId)) {
      ctx.track.alive.add(agentId)
      const agent = agentOf(sessionId, agentId)
      if (agent?.state === 'starting') {
        const prompted =
          agentId === ORCHESTRATOR_ID
            ? Boolean(get().sessions[sessionId]?.goal)
            : Boolean(agent.task)
        patchAgent(sessionId, agentId, () => ({ state: prompted ? 'thinking' : 'idle' }))
        setActivity(sessionId, agentId, prompted ? 'thinking' : 'idle', at)
      }
      if (via === 'output') {
        const timer = setTimeout(() => {
          ctx.track.timers.delete(timer)
          if (runtimes.get(sessionId) === ctx.runtime) void becomeReady(sessionId, agentId)
        }, INPUT_READY_MS)
        ctx.track.timers.add(timer)
      }
    }
    if (via === 'hook') {
      ctx.track.hooked.add(agentId)
      void becomeReady(sessionId, agentId)
    }
  }

  /**
   * Listens once for the first bytes of a terminal (whichever channel the backend uses).
   * Resolves once listening, to the function that stops it.
   */
  const watchFirstOutput = async (
    sessionId: string,
    agentId: string,
    ptyId: string,
  ): Promise<() => void> => {
    const ctx = runtimeOf(sessionId)
    if (!ctx) return () => {}
    let done = false
    const offs: Array<() => void> = []
    const stop = () => {
      if (done) return
      done = true
      for (const off of offs) safely(off)
      ctx.track.cleanups.delete(stop)
    }
    ctx.track.cleanups.add(stop)
    const onOutput = () => {
      if (done) return
      stop()
      if (runtimes.get(sessionId) === ctx.runtime) markAlive(sessionId, agentId, 'output')
    }
    // Opened lazily: a missing channel (or a failing listen) only costs the early signal; the
    // watchdog still looks at the mirror before calling the launch stuck.
    const channels = [
      () => listenPtyData(ptyId, onOutput),
      () => listenPtyActivity(ptyId, onOutput),
    ]
    await Promise.all(
      channels.map((open) =>
        Promise.resolve()
          .then(open)
          .then((off) => {
            if (done) safely(off)
            else offs.push(off)
          })
          .catch(() => {}),
      ),
    )
    return stop
  }

  /** Short description of how an agent ended, for notices and bus lines. */
  const exitSummary = (code: number | null, reason: AgentExitReason) =>
    reason === 'launch-failed'
      ? 'could not be launched'
      : reason === 'launch-timeout'
        ? `showed no sign of life in ${LAUNCH_WATCHDOG_MS / 1000} s`
        : reason === 'killed'
          ? 'was killed'
          : `exited${code === null ? '' : ` with code ${code}`}`

  /**
   * An agent's terminal is gone. After `done` that is the normal end; before it, the agent
   * failed: the bus and the orchestrator are told, messages for it fail, and the workers
   * waiting for it are held with the reason instead of waiting forever.
   */
  const failAgent = (
    sessionId: string,
    agentId: string,
    exit: { code: number | null; reason: AgentExitReason; note?: string },
  ) => {
    const ctx = runtimeOf(sessionId)
    const before = agentOf(sessionId, agentId)
    if (!ctx || !before) return
    const at = Date.now()
    patchAgent(sessionId, agentId, (a) => ({
      state: a.state === 'done' ? 'done' : 'exited',
      finishedAt: a.finishedAt ?? at,
      exitCode: exit.code,
      exitReason: exit.reason,
      blocked: null,
      ...(exit.note && a.state !== 'done' ? { note: exit.note } : {}),
    }))
    setActivity(sessionId, agentId, 'idle', at)
    ctx.track.ready.delete(agentId)
    ctx.track.launches.delete(agentId)
    failDeliveriesTo(sessionId, agentId, 'exited')
    // Exiting after `done` is the normal end, and a failure is announced once.
    if (before.state === 'done' || before.state === 'exited') return
    const summary = exitSummary(exit.code, exit.reason)
    pushLine(sessionId, agentId, { at, text: `✗ ${summary}`, tone: 'error' })
    if (agentId !== ORCHESTRATOR_ID) {
      const note = clipLine(exit.note || before.note || '', NOTE_PREVIEW)
      const waiting = (get().sessions[sessionId]?.agents ?? [])
        .filter(
          (a) => a.after.includes(agentId) && (a.state === 'waiting' || a.state === 'blocked'),
        )
        .map((a) => a.id)
      recordMessage(
        sessionId,
        agentId,
        ORCHESTRATOR_ID,
        `failed · ${summary} without reporting done${note ? ` · last note: ${note}` : ''}`,
        at,
      )
      void notifyAgent(
        sessionId,
        agentId,
        ORCHESTRATOR_ID,
        `failed: ${agentId} ${summary} without reporting done; last note: ${note || 'none'}` +
          (waiting.length ? `; waiting for it: ${waiting.join(', ')}` : ''),
      )
    }
    releaseWaiting(sessionId)
  }

  /**
   * Holds an agent on a block it cannot clear itself: a stuck screen the screen watcher read,
   * or an account the preflight refused (then no PTY was opened). The orchestrator is told, so
   * it neither waits on it forever nor spawns a duplicate.
   */
  const holdOnScreen = (sessionId: string, agentId: string, block: AgentBlock) => {
    const agent = agentOf(sessionId, agentId)
    if (!agent || processEnded(agent)) return
    // Hooks know better: a permission, a question, a reported or dependency block stands.
    if (agent.state === 'blocked' && !isScreenBlock(agent.blocked)) return
    if (agent.state === 'blocked' && agent.blocked?.reason === block.reason) return
    patchAgent(sessionId, agentId, () => ({ state: 'blocked', blocked: block, stalledSince: null }))
    setActivity(sessionId, agentId, 'blocked', block.at)
    const notice = screenNotice(block)
    pushLine(sessionId, agentId, { at: block.at, text: `! ${notice}`, tone: 'error' })
    if (agentId === ORCHESTRATOR_ID) return
    recordMessage(sessionId, agentId, ORCHESTRATOR_ID, `blocked · ${notice}`, block.at)
    void notifyAgent(
      sessionId,
      agentId,
      ORCHESTRATOR_ID,
      `blocked: ${agentId} ${notice}. The user was asked to clear it; do not spawn a replacement.`,
    )
  }

  const holdForAccount = (sessionId: string, agentId: string, block: AgentBlock) => {
    patchAgent(sessionId, agentId, () => ({ ptyId: null }))
    holdOnScreen(sessionId, agentId, block)
  }

  /**
   * Starts an agent's process. `resume` continues an earlier run: `claude --resume` when the
   * agent's conversation is known, else a fresh start told why (see `firstMessage`).
   */
  const launch = async (sessionId: string, agent: OrchestraAgent, wanted?: ResumeLaunch) => {
    const runtime = runtimes.get(sessionId)
    const session = get().sessions[sessionId]
    const cwd = session?.cwd
    if (!runtime || !session || !cwd) return
    // `--resume` only ever gets a real conversation id (a UUID); anything else starts over.
    const resume: ResumeLaunch | undefined = wanted && {
      ...wanted,
      claudeSessionId: isConversationId(wanted.claudeSessionId) ? wanted.claudeSessionId : null,
    }
    const track = tracking(runtime)
    const token = Symbol(agent.id)
    track.launches.set(agent.id, token)
    // A new process: it has to show a sign of life again before it counts as running, and
    // what the old one said about its prompt says nothing about the new screen.
    track.alive.delete(agent.id)
    track.ready.delete(agent.id)
    track.hooked.delete(agent.id)
    track.atPrompt.delete(agent.id)
    // A stop, a newer launch of this agent or the watchdog drops what this launch still does.
    const live = () => runtimes.get(sessionId) === runtime && track.launches.get(agent.id) === token
    const ptyId = `orchestra-${sessionId}-${agent.id}-${Date.now()}`
    // No output and no hook this long after the launch began: it is stuck, not starting.
    const watchdog = setTimeout(() => {
      track.timers.delete(watchdog)
      if (!live() || track.alive.has(agent.id)) return
      const current = agentOf(sessionId, agent.id)
      if (current?.ptyId && mirrorShowsOutput(current.ptyId)) {
        markAlive(sessionId, agent.id, 'output')
        return
      }
      failAgent(sessionId, agent.id, { code: null, reason: 'launch-timeout' })
      if (current?.ptyId) void killPty(current.ptyId).catch(() => {})
    }, LAUNCH_WATCHDOG_MS)
    track.timers.add(watchdog)
    try {
      // The backend refuses a folder that is gone: the PTY would fall back to the home folder.
      const env = await orchestraPrepare(sessionId, agent.id, cwd)
      const isOrchestrator = agent.id === ORCHESTRATOR_ID
      // Account / model / effort: the agent's own spawn flags win over the session's launch
      // settings, except the account of a one-account session (see `agentLaunch`).
      // An unknown account id falls back to the default account rather than an empty config dir.
      // A resume runs where the conversation lives: the settings of its last run, not today's.
      const accounts = useProjectsStore.getState().preferences.claudeAccounts ?? []
      const sessionLaunch = sessionLaunchOf(session)
      const options =
        resume && agent.launchedWith ? { ...agent.launchedWith } : agentLaunch(agent, sessionLaunch)
      if (options.account && !accounts.some((a) => a.id === options.account)) options.account = null
      const configDir = options.account ? accountConfigDirCached(options.account) : null
      if (options.account && configDir) {
        // Accounts start without the default MCP servers (obsidian etc.); copy the missing ones.
        await syncAccountMcpServers([{ id: options.account, config_dir: configDir }]).catch(
          () => [],
        )
      }
      if (!live()) return
      const launchedWith = {
        account: configDir ? options.account : null,
        model: options.model,
        effort: options.effort,
      }
      patchAgent(sessionId, agent.id, () => ({ ...launchedWith, launchedWith }))
      // Before any PTY: the folder is trusted in this account and the orchestrator's, the
      // sign-in is valid (an expired token is renewed) and still the expected account. A
      // failed check holds the agent as blocked with a way to sign in, instead of a terminal
      // sitting on "Login expired".
      const orchestratorAccount = isOrchestrator
        ? undefined
        : session.agents.find((a) => a.id === ORCHESTRATOR_ID)?.launchedWith?.account
      const held = await runPreflight({
        configDir,
        expectedEmail: accounts.find((a) => a.id === launchedWith.account)?.email ?? null,
        cwd,
        alsoSeed:
          orchestratorAccount === undefined
            ? []
            : [orchestratorAccount ? (accountConfigDirCached(orchestratorAccount) ?? '') : ''],
      })
      if (!live()) return
      if (held) {
        clearTimeout(watchdog)
        track.timers.delete(watchdog)
        holdForAccount(sessionId, agent.id, held)
        return
      }
      // The Obsidian context consulted when the session started (see start()).
      const context = sessionContextOf(sessionId)
      const args = [
        '--settings',
        env.settings_path,
        '--append-system-prompt',
        isOrchestrator
          ? [
              orchestratorPrompt(env.cli_path, context),
              accountsPromptHint(accounts, sessionLaunch.policy),
              creativePromptHint({ goal: session.goal }),
            ]
              .filter(Boolean)
              .join(' ')
          : workerPrompt(agent.id, agent.area, env.cli_path, context),
        ...launchArgs(options),
        ...(session.autonomous ? ['--dangerously-skip-permissions'] : []),
      ]
      // The task (or goal) reaches the agent as a file it is told to read.
      const initial = await firstMessage(
        sessionId,
        agent.id,
        isOrchestrator ? session.goal : agent.task,
        resume,
      )
      if (!live()) return
      if (resume?.claudeSessionId) args.push('--resume', resume.claudeSessionId)
      if (initial) args.push(initial)
      // Born at the size an Orchestra view last showed this role at, with the mirror listening
      // from the first byte: no view ever replays output drawn for another width.
      const size = spawnTerminalSize(isOrchestrator ? 'orchestrator' : 'worker')
      rememberPty(sessionId, ptyId)
      await startMirror(ptyId, size)
      // First output and exit are heard before the process exists: a launch that prints its
      // screen at once, or dies at once, is never missed.
      const stopWatching = await watchFirstOutput(sessionId, agent.id, ptyId)
      const unlistenExit = await listenPtyExit(ptyId, (payload: PtyExitPayload) => {
        if (!live()) return
        // `claude --resume` gone before its first hook: the conversation was not found.
        if (resume?.claudeSessionId && !track.hooked.has(agent.id)) {
          notResumed(sessionId, agent.id, resume, payload?.code ?? null)
          return
        }
        failAgent(sessionId, agent.id, {
          code: payload?.code ?? null,
          reason: payload?.reason ?? 'exited',
        })
      })
      runtime.exitUnlisteners.set(ptyId, unlistenExit)
      const release = () => {
        stopWatching()
        runtime.exitUnlisteners.delete(ptyId)
        safely(unlistenExit)
      }
      // Stopped while the mirror got ready: stop() never saw this PTY, its mirror is ours.
      if (!live()) {
        release()
        disposeMirror(ptyId)
        return
      }
      await spawnPty({
        id: ptyId,
        cols: size.cols,
        rows: size.rows,
        cwd,
        command: 'claude',
        extraArgs: args,
        env: {
          ALETHE_ORCHESTRA_ENDPOINT: env.endpoint,
          ALETHE_ORCHESTRA_TOKEN: env.token,
          ALETHE_ORCHESTRA_AGENT_ID: agent.id,
          ALETHE_ORCHESTRA_SESSION: sessionId,
          PATH: env.path_env,
          ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
        },
      }).catch((error: unknown) => {
        // No process will ever feed this mirror.
        release()
        disposeMirror(ptyId)
        throw error
      })
      if (!live()) {
        release()
        await killPty(ptyId).catch(() => {})
        disposeMirror(ptyId)
        return
      }
      // Still `starting`: it counts as thinking only from its first output or hook.
      patchAgent(sessionId, agent.id, () => ({ ptyId, startedAt: Date.now() }))
    } catch (error) {
      if (!live()) return
      const message = String(error)
      patchSession(sessionId, () => ({ error: `${agent.id}: ${message}` }))
      failAgent(sessionId, agent.id, { code: null, reason: 'launch-failed', note: message })
    }
  }

  /**
   * `claude --resume` ended before the agent's first hook: Claude Code did not find the
   * conversation (another account, a moved folder, a deleted transcript). The agent starts its
   * task over, once (that launch has no `--resume`, so a second failure is an ordinary one),
   * and the orchestrator is told.
   */
  const notResumed = (
    sessionId: string,
    agentId: string,
    resume: ResumeLaunch,
    code: number | null,
  ) => {
    const agent = agentOf(sessionId, agentId)
    if (!agent) return
    const at = Date.now()
    // The failed process's transcript only says the conversation was not found: drop its mirror
    // now instead of keeping it until the session is closed.
    const failedPty = agent.ptyId
    if (failedPty) {
      safely(() => disposeMirror(failedPty))
      sessionPtys.get(sessionId)?.delete(failedPty)
    }
    const why = `could not resume its conversation${code === null ? '' : ` (exit code ${code})`}`
    pushLine(sessionId, agentId, { at, text: `✗ ${why}; starting its task over`, tone: 'error' })
    if (agentId !== ORCHESTRATOR_ID) {
      void post(
        sessionId,
        agentId,
        ORCHESTRATOR_ID,
        `not resumed: ${agentId} ${why} and starts its task over`,
        at,
      )
    }
    patchAgent(sessionId, agentId, () => ({ state: 'starting', ptyId: null, startedAt: at }))
    const fresh = agentOf(sessionId, agentId)
    if (fresh) {
      void launch(sessionId, fresh, {
        claudeSessionId: null,
        prompt: notResumedPrompt(agentId, resume.prompt),
      })
    }
  }

  /** Whether a terminal printed anything, for output that came before its listener. */
  const mirrorShowsOutput = (ptyId: string) => {
    try {
      const mirror = getMirror(ptyId)
      return Boolean(mirror && mirror.length > 0 && mirror.getText(0, mirror.length).trim())
    } catch {
      return false
    }
  }

  /**
   * Starts workers whose `after` dependencies have all finished. One whose dependency failed
   * (or was cancelled) is held as blocked with that reason instead of waiting forever, and goes
   * back to waiting if the dependency runs again.
   */
  const releaseWaiting = (sessionId: string) => {
    const cancelled = runtimeOf(sessionId)?.track.cancelled ?? new Set<string>()
    const agents = get().sessions[sessionId]?.agents ?? []
    const byId = new Map(agents.map((a) => [a.id, a]))
    const at = Date.now()
    for (const agent of agents) {
      const held = agent.state === 'blocked' && agent.blocked?.reason === 'dependency'
      if (agent.state !== 'waiting' && !held) continue
      const broken = agent.after.filter(
        (dep) => byId.get(dep)?.state === 'exited' || cancelled.has(dep),
      )
      if (broken.length > 0) {
        const text = broken.join(', ')
        if (!held || agent.blocked?.text !== text) {
          patchAgent(sessionId, agent.id, () => ({
            state: 'blocked',
            blocked: { reason: 'dependency', text, at },
          }))
        }
        continue
      }
      // A dependency nobody knows of (a typo, a worker never spawned) does not hold it forever.
      if (agent.after.every((dep) => byId.get(dep)?.state === 'done' || !byId.has(dep))) {
        patchAgent(sessionId, agent.id, () => ({ state: 'starting', blocked: null }))
        void launch(sessionId, agent)
      } else if (held) {
        patchAgent(sessionId, agent.id, () => ({ state: 'waiting', blocked: null }))
      }
    }
  }

  const onEvent = (sessionId: string, event: OrchestraEvent) => {
    switch (event.kind) {
      case 'spawn': {
        if (agentOf(sessionId, event.id)) return
        const session = get().sessions[sessionId]
        // The backend already dropped it and told the orchestrator; launch() enforces it anyway.
        const dropped =
          event.account_ignored ?? (session && ignoredAccount(event, sessionLaunchOf(session)))
        if (dropped)
          console.info(`[orchestra] ${sessionId} ${event.id}: --account ignored`, dropped)
        const agent = newAgent(
          event.id,
          event.area || event.id,
          event.task,
          event.after,
          event.at,
          'waiting',
          { account: event.account, model: event.model, effort: event.effort },
        )
        patchSession(sessionId, (s) => ({ agents: [...s.agents, agent] }))
        recordMessage(sessionId, ORCHESTRATOR_ID, event.id, event.task, event.at)
        releaseWaiting(sessionId)
        return
      }
      case 'report': {
        const id = event.agent_id
        const finishing = event.status === 'done' || event.progress === 100
        const before = agentOf(sessionId, id)
        patchAgent(sessionId, id, (a) => applyReport(a, event))
        if (!finishing && before?.state === 'done') setActivity(sessionId, id, 'thinking', event.at)
        if (event.note)
          pushLine(sessionId, id, {
            at: event.at,
            text: `◆ ${event.progress ?? ''}% ${event.note}`,
            tone: 'note',
          })
        if (event.status === 'blocked') setActivity(sessionId, id, 'blocked', event.at)
        if (finishing) {
          setActivity(sessionId, id, 'idle', event.at)
          if (id !== ORCHESTRATOR_ID) {
            const summary = event.note || 'task complete'
            recordMessage(sessionId, id, ORCHESTRATOR_ID, `done · ${summary}`, event.at)
            void notifyAgent(sessionId, id, ORCHESTRATOR_ID, `finished: ${summary}`)
          }
          releaseWaiting(sessionId)
        }
        return
      }
      case 'message': {
        void post(sessionId, event.from, event.to, event.text, event.at)
        return
      }
      case 'hook': {
        const { agent_id: id, hook, at } = event
        const name = hook.hook_event_name
        // A gone process sends nothing new; a late hook must not bring it back to life.
        if (agentOf(sessionId, id)?.state === 'exited') return
        // Any activity may bring up a dialog; only Stop and the idle notification say none is.
        runtimeOf(sessionId)?.track.atPrompt.delete(id)
        markAlive(sessionId, id, 'hook', at)
        // Its Claude conversation: `claude --resume` continues it, the scribe reads its transcript.
        patchAgent(sessionId, id, (a) => conversationPatch(a, hook))
        const kind = activityFromHook(hook)
        if (kind) setActivity(sessionId, id, kind, at)
        const text = lineFromHook(hook)
        if (text) {
          pushLine(sessionId, id, {
            at,
            text,
            tone: hook.failed ? 'error' : name === 'Stop' ? 'ok' : 'tool',
          })
        }
        if (name === 'PreToolUse') {
          const target = hook.target ?? ''
          // A tool running again means a permission prompt or question was answered; a
          // block the agent reported itself stands until its next report or prompt.
          patchAgent(sessionId, id, (a) => ({
            toolCalls: a.toolCalls + 1,
            files:
              FILE_TOOLS.has(hook.tool_name ?? '') && target && !a.files.includes(target)
                ? [...a.files, target]
                : a.files,
            ...(a.state === 'done' || heldBlock(a)
              ? {}
              : {
                  state: kind === 'editing' || kind === 'testing' ? kind : 'thinking',
                  blocked: null,
                }),
          }))
        }
        if (name === 'PostToolUse') {
          patchAgent(sessionId, id, (a) =>
            a.state === 'blocked' && !heldBlock(a) ? { state: 'thinking', blocked: null } : {},
          )
        }
        if (name === 'UserPromptSubmit') {
          confirmDelivery(sessionId, id, hook.prompt)
          // Started without a goal: the orchestrator's first own prompt becomes the goal.
          const typed = taskFromInput(hook.prompt)
          if (
            id === ORCHESTRATOR_ID &&
            typed &&
            !get().sessions[sessionId]?.goal &&
            !(hook.prompt ?? '').trimStart().startsWith('[orchestra')
          ) {
            const goal = typed.slice(0, GOAL_FROM_PROMPT_MAX)
            patchSession(sessionId, () => ({ goal }))
            patchAgent(sessionId, id, (a) => (a.task ? {} : { task: goal }))
          }
          // A new prompt (orch send, the composer or typing in the PTY) is a new task for
          // an agent that had finished; otherwise it just keeps working.
          reopen(sessionId, id, at, typed)
          patchAgent(sessionId, id, (a) =>
            a.state === 'done' ? {} : { state: 'thinking', blocked: null },
          )
        }
        if (name === 'Notification') {
          const need = notificationKind(hook)
          if (need === 'permission' || need === 'question') {
            // Its prompt takes no input until the dialog closes: messages wait for it.
            runtimeOf(sessionId)?.track.ready.delete(id)
            patchAgent(sessionId, id, (a) =>
              a.state === 'done'
                ? {}
                : { state: 'blocked', blocked: { reason: need, text: hook.message ?? '', at } },
            )
          } else if (need === 'idle') {
            // Waiting at its prompt is not blocked: the orchestrator idles while workers run.
            // Claude Code sends this only with no dialog open, so a dialog block is over too.
            runtimeOf(sessionId)?.track.atPrompt.add(id)
            patchAgent(sessionId, id, (a) =>
              a.state === 'done' || heldBlock(a) ? {} : { state: 'idle', blocked: null },
            )
          }
        }
        if (name === 'Stop') {
          runtimeOf(sessionId)?.track.atPrompt.add(id)
          patchAgent(sessionId, id, (a) =>
            a.state === 'done' || heldBlock(a) ? {} : { state: 'idle', blocked: null },
          )
          const agent = agentOf(sessionId, id)
          if (id !== ORCHESTRATOR_ID && agent?.state !== 'done' && hook.last_assistant_message) {
            void notifyAgent(
              sessionId,
              id,
              ORCHESTRATOR_ID,
              `turn finished: ${hook.last_assistant_message}`,
            )
          }
        }
        // After the state above: a dialog that closed lets what waited for the prompt go in.
        void becomeReady(sessionId, id)
        return
      }
    }
  }

  /** Routes a bus event to its session; events of stopped or unknown sessions are dropped. */
  const dispatch = (event: OrchestraEvent) => {
    const sessionId = event.session
    if (!sessionId || !runtimes.has(sessionId) || !get().sessions[sessionId]) return
    try {
      onEvent(sessionId, event)
    } catch (error) {
      console.error('[orchestra] event handler failed', error)
    }
    for (const tap of busTaps) {
      try {
        tap(event)
      } catch (error) {
        console.error('[orchestra] bus follower failed', error)
      }
    }
  }

  /**
   * Ends what still runs for a session: bus routing, listeners, watchdogs and its PTYs, and
   * tells the backend. The session itself stays; callers remove it or keep it read-only.
   */
  const endProcesses = async (sessionId: string) => {
    const runtime = runtimes.get(sessionId)
    runtimes.delete(sessionId)
    releaseBusWhenIdle()
    // A stopped session has nothing left running.
    if (!runtime && get().sessions[sessionId]?.stoppedAt) return
    if (runtime) {
      for (const unlisten of runtime.exitUnlisteners.values()) safely(unlisten)
      runtime.exitUnlisteners.clear()
      // Watchdogs, input-ready timers and first-output listeners die with the processes.
      const track = tracking(runtime)
      for (const timer of track.timers) clearTimeout(timer)
      track.timers.clear()
      for (const cleanup of [...track.cleanups]) safely(cleanup)
      track.cleanups.clear()
      track.launches.clear()
    }
    const ptys = (get().sessions[sessionId]?.agents ?? [])
      .map((a) => a.ptyId)
      .filter((id): id is string => Boolean(id))
    await Promise.all(ptys.map((id) => settle(() => killPty(id))))
    await settle(() => orchestraEnd(sessionId))
  }

  const openBus = (): Promise<void> => {
    if (unlistenBus) return Promise.resolve()
    if (!busOpening) {
      busOpening = listenOrchestra(dispatch)
        .then((unlisten) => {
          unlistenBus = unlisten
          // Every session may have stopped while the subscription was opening.
          releaseBusWhenIdle()
        })
        .finally(() => {
          busOpening = null
        })
    }
    return busOpening
  }

  return {
    sessions: {},
    order: [],
    activeId: null,
    lastAutonomous: true,
    lastMode: loadMode(),
    error: null,
    splitId: null,
    splitSide: 'right',
    recent: [],

    start: async (cwd, goal, autonomous, projectId = null) => {
      const id = newSessionId()
      // The start form's values become the session's own; later form changes do not touch it.
      const sessionLaunch = sessionLaunchDefaults()
      // Registered before the first await so a concurrent stopAll() sees it and the bus stays.
      const runtime: SessionRuntime = { exitUnlisteners: new Map(), messageSeq: 0 }
      runtimes.set(id, runtime)
      try {
        await orchestraReset(id)
        await shareAccountPolicy(id, sessionLaunch)
        if (runtimes.get(id) === runtime) await openBus()
      } catch (error) {
        if (runtimes.get(id) === runtime) runtimes.delete(id)
        releaseBusWhenIdle()
        void settle(() => orchestraEnd(id))
        set({ error: String(error) })
        return null
      }
      if (runtimes.get(id) !== runtime) return null
      const now = Date.now()
      // Obsidian is consulted before the orchestrator starts (bounded, never throws). It begins
      // before the session shows up, so the scribe's start note waits for its outcome.
      const context = prepareSessionContext({
        sessionId: id,
        goal,
        cwd,
        projectName: projectId
          ? useProjectsStore.getState().projects.find((p) => p.id === projectId)?.name
          : null,
        at: now,
      })
      const orchestrator = newAgent(ORCHESTRATOR_ID, 'orchestrator', goal, [], now, 'starting')
      set((s) => ({
        sessions: {
          ...s.sessions,
          [id]: {
            id,
            projectId,
            cwd,
            goal,
            autonomous,
            startedAt: now,
            mode: s.lastMode,
            agents: [orchestrator],
            messages: [],
            segments: [],
            selectedId: null,
            error: null,
            launch: sessionLaunch,
            accountSwitches: [],
          },
        },
        order: [...s.order, id],
        activeId: id,
        recent: touch(s.recent, id),
        lastAutonomous: autonomous,
        error: null,
      }))
      await context
      await launch(id, orchestrator)
      return id
    },

    // Closing a session tears down its own listeners and PTYs (if its agents still run), then
    // forgets it; nothing here may throw, so a failing kill or unlisten can never take the
    // window (or the HTTP listener) with it.
    stop: async (sessionId) => {
      await endProcesses(sessionId)
      set((s) => {
        if (!s.sessions[sessionId]) return s
        const sessions = { ...s.sessions }
        delete sessions[sessionId]
        const order = s.order.filter((id) => id !== sessionId)
        const recent = s.recent.filter((id) => id !== sessionId)
        // Side by side, the other session on screen takes over the whole view; otherwise the
        // view stays on the project, never jumping to another project's session.
        const activeId =
          s.activeId === sessionId
            ? (splitPartnerId(s) ??
              latestSessionOf({ sessions, recent }, s.sessions[sessionId].projectId))
            : s.activeId
        return {
          sessions,
          order,
          activeId,
          recent: activeId ? touch(recent, activeId) : recent,
          splitId: s.splitId === sessionId || s.splitId === activeId ? null : s.splitId,
        }
      })
      // Transcripts stay readable until their session is closed (closing a panel keeps them),
      // including those of agents that were restarted.
      for (const id of sessionPtys.get(sessionId) ?? []) safely(() => disposeMirror(id))
      sessionPtys.delete(sessionId)
      safely(() => forgetRetired(sessionId))
      safely(() => clearSessionDrafts(sessionId))
    },

    stopAll: async () => {
      const ids = new Set([...get().order, ...runtimes.keys()])
      await Promise.all([...ids].map((id) => get().stop(id)))
    },

    stopAgents: async (sessionId) => {
      const session = get().sessions[sessionId]
      // A second Stop while the first still ends the processes is the same Stop.
      if (!session || session.stoppedAt || stopping.has(sessionId)) return
      stopping.add(sessionId)
      try {
        await endProcesses(sessionId)
        const at = Date.now()
        // Whatever still worked was stopped by the user: idle, not failed. Messages that never
        // reached their agent will not anymore.
        patchSession(sessionId, (s) => ({
          stoppedAt: at,
          agents: s.agents.map((a) =>
            a.state === 'done' || a.state === 'exited' || a.exitReason === 'cancelled'
              ? a
              : {
                  ...a,
                  state: 'idle' as const,
                  exitReason: 'stopped' as const,
                  finishedAt: a.finishedAt ?? at,
                  blocked: null,
                },
          ),
          segments: s.segments.map((seg) => (seg.end === null ? { ...seg, end: at } : seg)),
          messages: s.messages.map((m) =>
            m.delivery === 'queued' || m.delivery === 'pending'
              ? { ...m, delivery: 'failed' as const, failure: 'stopped' as const }
              : m,
          ),
        }))
        safely(() => clearSessionDrafts(sessionId))
      } finally {
        stopping.delete(sessionId)
      }
    },

    restartAgent: async (sessionId, agentId, opts = {}) => {
      const ctx = runtimeOf(sessionId)
      const session = get().sessions[sessionId]
      const agent = agentOf(sessionId, agentId)
      if (!ctx || !session || session.stoppedAt || !agent) return
      // A second click while it restarts does nothing, and nothing restarts while it stops.
      const key = `${sessionId} ${agentId}`
      if (restarting.has(key) || stopping.has(sessionId)) return
      restarting.add(key)
      try {
        // The current launch is superseded: its process ending now is not a failure.
        ctx.track.launches.delete(agentId)
        const old = agent.ptyId
        if (old) {
          await settle(() => killPty(old))
          // Its transcript stays readable next to the new terminal until the session is closed;
          // only the last few are kept, so older mirrors are freed (Export transcript has them).
          safely(() => {
            const dropped = retirePty(sessionId, agentId, old)
            for (const id of dropped) disposeMirror(id)
            if (dropped.length) {
              recordMessage(
                sessionId,
                'orchestra',
                agentId,
                `older terminal discarded: only the last ${MAX_RETIRED} of ${agentId} are kept`,
              )
            }
          })
        }
        failDeliveriesTo(sessionId, agentId, 'exited')
        // Moving to the session's account: its conversation is copied there and continued;
        // with none to copy (or a copy that found nothing) it starts over in the new account.
        let carried: boolean | null = null
        if (opts.moveAccount) {
          const target = sessionLaunchOf(session).account
          const outcome = moveOutcome(agent, target)
          if (outcome !== 'same') {
            const fromDir = accountDirOf(agent.launchedWith?.account ?? agent.account ?? null)
            const toDir = accountDirOf(target)
            carried =
              outcome === 'carry' && session.cwd && fromDir !== null && toDir !== null
                ? await copyConversation({
                    fromDir,
                    toDir,
                    cwd: session.cwd,
                    sessionId: agent.claudeSessionId ?? '',
                  }).then(
                    (result) => result.copied || result.reason === 'same_dir',
                    (error: unknown) => {
                      console.warn('[orchestra] conversation copy failed', error)
                      return false
                    },
                  )
                : false
            const before = agent.launchedWith
            patchAgent(sessionId, agentId, () => ({
              account: target,
              launchedWith: carried && before ? { ...before, account: target } : null,
            }))
          }
        }
        patchAgent(sessionId, agentId, () => ({
          state: 'starting',
          ptyId: null,
          exitCode: null,
          exitReason: null,
          blocked: null,
          finishedAt: null,
          startedAt: Date.now(),
        }))
        if (opts.notice && agentId !== ORCHESTRATOR_ID) {
          void post(sessionId, 'you', ORCHESTRATOR_ID, opts.notice)
        }
        // Workers held because this one had failed go back to waiting for it.
        releaseWaiting(sessionId)
        const fresh = agentOf(sessionId, agentId)
        if (!fresh) return
        if (agentId === ORCHESTRATOR_ID) {
          // Never the goal from scratch: its own conversation when Claude Code told us its id
          // (Restart or Resume alike), and in any case where every worker stands.
          const conversation = carried === false ? null : (agent.claudeSessionId ?? null)
          const agents = get().sessions[sessionId]?.agents ?? []
          await launch(sessionId, fresh, {
            claudeSessionId: conversation,
            prompt: orchestratorRestartPrompt(agents, Boolean(conversation)),
          })
          return
        }
        // Resume continues its own conversation when Claude Code told us its id; otherwise (or
        // for a plain restart) it starts its task over.
        const conversation =
          (opts.resume && carried !== false) || carried ? agent.claudeSessionId : null
        await launch(
          sessionId,
          fresh,
          conversation
            ? { claudeSessionId: conversation, prompt: RESTARTED_IN_PLACE_PROMPT }
            : undefined,
        )
      } finally {
        restarting.delete(key)
      }
    },

    setSessionAccount: (sessionId, account) => {
      const session = get().sessions[sessionId]
      if (!session || session.stoppedAt) return
      const current = sessionLaunchOf(session)
      if (current.account === account) return
      const launch = { ...current, account }
      const at = Date.now()
      patchSession(sessionId, (s) => ({
        launch,
        accountSwitches: [...(s.accountSwitches ?? []), { at, from: current.account, to: account }],
        // A wait for the reset belongs to the account it was armed for.
        ...(s.limitWait && s.limitWait.account !== account ? { limitWait: null } : {}),
      }))
      void shareAccountPolicy(sessionId, launch)
      const from = accountLabel(current.account) ?? 'default'
      const to = accountLabel(account) ?? 'default'
      recordMessage(sessionId, 'you', ORCHESTRATOR_ID, `session account: ${from} → ${to}`, at)
      // The bus line never reaches its terminal: the orchestrator is told on its own.
      void pasteNotice(
        sessionId,
        ORCHESTRATOR_ID,
        `[orchestra] session account is now ${to} (was ${from}); workers spawned from now on start there`,
        '',
      )
    },

    setLimitWait: (sessionId, wait) =>
      patchSession(sessionId, (s) => {
        const before = s.limitWait ?? null
        const same =
          before?.account === wait?.account &&
          before?.resetsAt === wait?.resetsAt &&
          Boolean(before?.auto) === Boolean(wait?.auto) &&
          before?.resumedAt === wait?.resumedAt &&
          before?.rearms === wait?.rearms
        return same ? null : { limitWait: wait }
      }),

    tellAgent: (sessionId, agentId, text) => {
      recordMessage(sessionId, 'orchestra', agentId, text)
      // A notice is not a task: the agent's current task stays as it is.
      void pasteNotice(sessionId, agentId, `[orchestra] ${text}`, '')
    },

    interruptAgent: async (sessionId, agentId, notice) => {
      const agent = agentOf(sessionId, agentId)
      const ptyId = agent?.ptyId
      if (!ptyId || processEnded(agent) || get().sessions[sessionId]?.stoppedAt) return
      if (notice) recordMessage(sessionId, 'you', agentId, notice)
      // After any paste still being written, never in the middle of one.
      await queueWrite(ptyId, () => writePty(ptyId, '\x1b')).catch(() => {})
    },

    answerDialog: async (sessionId, agentId, choice, notice) => {
      const agent = agentOf(sessionId, agentId)
      const ptyId = agent?.ptyId
      if (!ptyId || !runtimes.has(sessionId) || processEnded(agent)) return false
      const press = (keys: string) => queueWrite(ptyId, () => writePty(ptyId, keys))
      const answered = await chooseOption(ptyId, choice, press).catch(() => false)
      // A restart or a stop meanwhile: this answer is not the agent's news anymore.
      if (!answered || agentOf(sessionId, agentId)?.ptyId !== ptyId || !runtimeOf(sessionId)) {
        return answered
      }
      if (notice) recordMessage(sessionId, 'you', agentId, notice)
      if (choice.deny) {
        // Refused: Claude Code drops the turn and waits at its prompt, which no hook reports.
        runtimeOf(sessionId)?.track.atPrompt.add(agentId)
        patchAgent(sessionId, agentId, (a) => (inDialog(a) ? { state: 'idle', blocked: null } : {}))
        void becomeReady(sessionId, agentId)
      } else {
        // Allowed: the tool runs, and its next hook lets the waiting messages in.
        patchAgent(sessionId, agentId, (a) =>
          inDialog(a) ? { state: 'thinking', blocked: null } : {},
        )
      }
      return true
    },

    setActive: (sessionId) =>
      set((s) => {
        if (s.activeId === sessionId || (sessionId !== null && !s.sessions[sessionId])) return s
        if (sessionId === null) return { activeId: null }
        const recent = touch(s.recent, sessionId)
        // The split session's pane takes the focus; both panes keep their sessions.
        if (sessionId === s.splitId) {
          const previous = s.activeId ?? s.recent[0] ?? null
          return {
            activeId: sessionId,
            recent,
            splitId: previous === sessionId ? null : previous,
            splitSide: s.splitSide === 'left' ? 'right' : 'left',
          }
        }
        return { activeId: sessionId, recent }
      }),

    toggleSplit: () =>
      set((s) => {
        if (splitPartnerId(s)) return { splitId: null }
        const { activeId, order, sessions } = s
        if (!activeId) return s
        const index = order.indexOf(activeId)
        const partner = [...s.recent, order[index + 1], order[index - 1]].find((id): id is string =>
          Boolean(id && id !== activeId && sessions[id]),
        )
        if (!partner) return s
        // Panes follow the tab order, so the strip and the panes read the same way.
        return { splitId: partner, splitSide: order.indexOf(partner) < index ? 'left' : 'right' }
      }),

    setMode: (sessionId, mode) => {
      try {
        localStorage.setItem(MODE_KEY, mode)
      } catch {
        // Non-persistent storage only loses the remembered view.
      }
      set((s) => {
        const session = s.sessions[sessionId]
        return session
          ? { lastMode: mode, sessions: { ...s.sessions, [sessionId]: { ...session, mode } } }
          : { lastMode: mode }
      })
    },

    select: (sessionId, agentId) =>
      patchSession(sessionId, (s) => (s.selectedId === agentId ? null : { selectedId: agentId })),

    sendTo: async (sessionId, to, text, from = 'you') => {
      await get().send(sessionId, to, text, from)
    },

    send: async (sessionId, to, text, from = 'you') => {
      const clean = text.trim()
      if (!clean) return { id: null, delivery: 'failed' }
      return post(sessionId, from, to, clean)
    },

    resend: async (sessionId, messageId) => {
      const message = get().sessions[sessionId]?.messages.find((m) => m.id === messageId)
      if (!message || message.delivery !== 'failed') return
      patchMessage(sessionId, messageId, { delivery: 'pending', failure: undefined })
      await route(sessionId, messageId, message.from, message.to, message.text)
    },

    screenBlock: (sessionId, agentId, block) => {
      if (block) {
        holdOnScreen(sessionId, agentId, block)
        return
      }
      const agent = agentOf(sessionId, agentId)
      if (!agent || agent.state !== 'blocked' || !isScreenBlock(agent.blocked)) return
      const at = Date.now()
      patchAgent(sessionId, agentId, () => ({ state: 'thinking', blocked: null }))
      setActivity(sessionId, agentId, 'thinking', at)
    },

    setStalled: (sessionId, agentId, since) =>
      patchAgent(sessionId, agentId, (a) =>
        (a.stalledSince ?? null) === since ? {} : { stalledSince: since },
      ),

    startNow: (sessionId, agentId, notice) => {
      const agent = agentOf(sessionId, agentId)
      const held = agent?.state === 'blocked' && agent.blocked?.reason === 'dependency'
      if (!agent || agent.ptyId || (agent.state !== 'waiting' && !held)) return
      patchAgent(sessionId, agentId, () => ({ state: 'starting', blocked: null }))
      if (notice) void post(sessionId, 'you', ORCHESTRATOR_ID, notice)
      void launch(sessionId, { ...agent, state: 'starting', blocked: null })
    },

    cancelWaiting: (sessionId, agentId, notice) => {
      const ctx = runtimeOf(sessionId)
      const agent = agentOf(sessionId, agentId)
      if (!ctx || !agent || agent.ptyId || agentId === ORCHESTRATOR_ID) return
      if (agent.state !== 'waiting' && agent.state !== 'blocked') return
      ctx.track.cancelled.add(agentId)
      ctx.track.launches.delete(agentId)
      failDeliveriesTo(sessionId, agentId, 'cancelled')
      // Kept in the session (cards, report, resume record) as cancelled, never launched.
      const at = Date.now()
      patchAgent(sessionId, agentId, (a) => ({
        state: 'idle',
        exitReason: 'cancelled',
        blocked: null,
        startedAt: a.startedAt || at,
        finishedAt: at,
      }))
      if (notice) void post(sessionId, 'you', ORCHESTRATOR_ID, notice)
      // Whoever waited for the cancelled worker is held now, with the reason.
      releaseWaiting(sessionId)
    },

    dismissError: (sessionId) => patchSession(sessionId, (s) => (s.error ? { error: null } : null)),

    reopen: (sessionId, agentId, task) =>
      reopen(sessionId, agentId, Date.now(), taskFromInput(task)),

    scribeWrote: (sessionId, note, text, at) => recordMessage(sessionId, SCRIBE_ID, note, text, at),

    resume: async (manifest, options = {}) => {
      const id = manifest.id
      const cwd = options.cwd ?? manifest.cwd
      if (!cwd || get().sessions[id] || runtimes.has(id)) return null
      // Never in another folder by accident: a folder that is gone stops the resume here (the
      // strip offers to pick its new place), instead of agents running in the home folder.
      const exists = await Promise.resolve()
        .then(() => orchestraFolderExists(cwd))
        .catch(() => false)
      if (!exists) {
        set({ error: `folder not found: ${cwd}` })
        return null
      }
      if (get().sessions[id] || runtimes.has(id)) return null
      const plan = resumePlan(
        { ...manifest, cwd },
        { folderChanged: !sameFolder(cwd, manifest.cwd) },
      )
      // Saved with the session; older manifests run on the orchestrator's last account.
      const resumedLaunch = restoredLaunch(
        manifest.launch,
        plan.agents.find((a) => a.id === ORCHESTRATOR_ID)?.launchedWith?.account,
        sessionLaunchDefaults(),
      )
      // Registered before the first await, like start(), so a concurrent stopAll() sees it.
      const runtime: SessionRuntime = { exitUnlisteners: new Map(), messageSeq: 0 }
      runtimes.set(id, runtime)
      try {
        // New spawns continue after the session's highest claude-N instead of reusing one.
        await orchestraResume(id, plan.nextWorker)
        await shareAccountPolicy(id, resumedLaunch)
        if (runtimes.get(id) === runtime) await openBus()
      } catch (error) {
        if (runtimes.get(id) === runtime) runtimes.delete(id)
        releaseBusWhenIdle()
        set({ error: String(error) })
        return null
      }
      if (runtimes.get(id) !== runtime) return null
      // Bus lines keep their ids; new ones continue after the highest.
      runtime.messageSeq = plan.messages.reduce((max, m) => Math.max(max, m.id), 0)
      const now = Date.now()
      set((s) => ({
        sessions: {
          ...s.sessions,
          [id]: {
            id,
            projectId: manifest.projectId,
            cwd,
            goal: manifest.goal,
            autonomous: manifest.autonomous,
            startedAt: manifest.startedAt || now,
            mode: (ORCHESTRA_VIEW_MODES as string[]).includes(manifest.mode)
              ? (manifest.mode as OrchestraViewMode)
              : s.lastMode,
            agents: plan.agents,
            messages: plan.messages,
            segments: [],
            selectedId: null,
            error: null,
            launch: resumedLaunch,
            accountSwitches: manifest.accountSwitches ?? [],
            limitWait: manifest.limitWait ?? null,
          },
        },
        order: [...s.order, id],
        activeId: id,
        recent: touch(s.recent, id),
        error: null,
      }))
      // The orchestrator gets the notice as its first message; the bus shows it too.
      recordMessage(id, 'you', ORCHESTRATOR_ID, plan.notice, now)
      for (const { agentId, resume } of plan.launches) {
        const agent = agentOf(id, agentId)
        if (agent) void launch(id, agent, resume)
      }
      releaseWaiting(id)
      return id
    },
  }
})

// The Obsidian scribe is a fixed role: it follows every session through the same bus.
installScribe({
  getState: useOrchestraStore.getState,
  subscribe: useOrchestraStore.subscribe,
  listen: (handler) => {
    busTaps.add(handler)
    return () => {
      busTaps.delete(handler)
    }
  },
  projectName: (projectId) =>
    useProjectsStore.getState().projects.find((p) => p.id === projectId)?.name,
  post: (sessionId, note, text, at) =>
    useOrchestraStore.getState().scribeWrote(sessionId, note, text, at),
})

// Warns the user when an agent of any session needs them (blocked or failed).
installAttention({
  getState: useOrchestraStore.getState,
  subscribe: useOrchestraStore.subscribe,
  listen: (handler) => {
    busTaps.add(handler)
    return () => {
      busTaps.delete(handler)
    }
  },
  shown: shownSessionIds,
})

// Stuck screens and stalled agents, read from the terminal mirrors.
installScreenWatch({
  getState: useOrchestraStore.getState,
  subscribe: useOrchestraStore.subscribe,
  screenBlock: (sessionId, agentId, block) =>
    useOrchestraStore.getState().screenBlock(sessionId, agentId, block),
  setStalled: (sessionId, agentId, since) =>
    useOrchestraStore.getState().setStalled(sessionId, agentId, since),
})

// Each running session keeps a manifest in app data: closing the app does not lose it.
if (isTauri()) {
  installManifests({
    getState: useOrchestraStore.getState,
    subscribe: useOrchestraStore.subscribe,
    save: orchestraManifestSave,
    remove: orchestraManifestRemove,
  })
}
