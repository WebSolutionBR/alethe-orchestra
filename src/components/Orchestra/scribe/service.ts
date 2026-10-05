/**
 * The scribe: a fixed, always-on Orchestra role. It follows every running session through the
 * same bus as the views and keeps what happens as local *material* (app data, never the vault).
 * Its *author*, a read-only `claude -p` run, turns that material into knowledge notes in the
 * owner's own pattern: when a worker finishes (after a quiet period), when the session ends,
 * and when the owner asks. The app checks the author's plan and writes it through an ordered,
 * persisted queue. Nothing raw is ever appended to the vault.
 *
 * With no vault configured it adopts Obsidian's open vault, and the reason it cannot write
 * (if any) is kept next to the queue state, so the UI never fails silently.
 */
import { create } from 'zustand'

import { accountConfigDirCached } from '../../../lib/claudeAccounts'
import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import { launchDefaults } from '../usage/launchDefaults'
import {
  obsidianAppend,
  obsidianDetectVaults,
  obsidianList,
  obsidianPatchHeading,
  obsidianPut,
  obsidianRead,
  obsidianRemoveContext,
  obsidianSearch,
  obsidianStatus,
  obsidianWriteContext,
  scribeAuthorCancel,
  scribeAuthorRun,
  scribeMaterialAppend,
  scribeMaterialRead,
  scribeMaterialRemove,
  scribeReadSources,
  scribeVaultIndex,
} from './api'
import type { AuthorAgent, VaultIndex } from './author'
import {
  type AuthorFailure,
  type AuthorStatus,
  authorStatusOf,
  MAX_FINAL_ATTEMPTS,
  patchAuthorStatus,
  pendingFinalRecords,
  sessionRecord,
  type SessionSnapshot,
  updateSessionRecord,
} from './authorStatus'
import {
  authorDelayMs,
  contextNoteLimit,
  getScribeConfig,
  notePathFor,
  useScribeConfig,
} from './config'
import {
  CONTEXT_BUDGET_MS,
  contextState,
  gatherObsidianContext,
  type ObsidianContext,
  SEARCH_CONTEXT_LENGTH,
  settleWithin,
} from './context'
import {
  clearSessionContext,
  sessionContextOf,
  setSessionContext,
  trackSessionContext,
  whenContextSettled,
} from './contextStore'
import { issueFromStatus, pickVault, type ScribeIssue } from './health'
import { noteFileName } from './identity'
import { type MaterialEntry, materialFromEvent, MaterialLog, renderMaterial } from './material'
import { brDate, hhmm, noteName } from './notePath'
import { CONFLICT_ISSUE, type QueueBatch, type QueueSnapshot, WriteQueue } from './queue'
import { redactSecrets } from './redact'
import { type AuthorRequest, AuthorScheduler, type ScheduleState } from './scheduler'
import { runSynthesis, type SynthesisDeps, vaultIndexFrom } from './synthesis'
import { applyWriteOp, type WriterDeps } from './writer'

/** The slice of an orchestra agent the scribe reads. */
export type ScribeAgent = {
  id: string
  area: string
  state: string
  progress: number
  task?: string
  note?: string
  /** The agent's Claude Code transcript (JSONL), from its hooks. */
  transcriptPath?: string | null
  history?: { task: string; note: string }[]
  account?: string | null
  model?: string | null
  effort?: string | null
}
export type ScribeSession = {
  id: string
  projectId: string | null
  cwd: string | null
  goal: string
  startedAt?: number
  /** Its agents were stopped: the session stays readable but nothing more happens in it. */
  stoppedAt?: number | null
  agents: ScribeAgent[]
}
export type ScribeSource = { sessions: Record<string, ScribeSession> }
export type ScribeStore = {
  getState: () => ScribeSource
  subscribe: (listener: (state: ScribeSource, prev: ScribeSource) => void) => () => void
  /** Bus events of the running sessions. */
  listen: (handler: (event: OrchestraEvent) => void) => () => void
  /** Display name of a project, for the notes. */
  projectName?: (projectId: string) => string | undefined
  /** Shows a written synthesis on its session's bus as `obsidian → <note>`. */
  post?: (sessionId: string, note: string, text: string, at: number) => void
}

const ORCHESTRATOR = 'orchestrator'
const WRITES_KEY = 'orchestra.scribe.writes'
/** The raw-block queue of the first scribe; its blocks are logs, never sent anymore. */
const LEGACY_QUEUE_KEY = 'orchestra.scribe.queue'
/** Settings edits settle this long before Obsidian is checked again. */
const RECHECK_MS = 800
/** A failing write asks Obsidian why at most this often. */
const FAILURE_CHECK_MS = 30_000
/** Final passes owed by an earlier run start this long after the app does. */
const RESUME_DELAY_MS = 30_000
/** The vault index is rebuilt at most this often. */
const INDEX_TTL_MS = 5 * 60_000
/** Longest the app waits for the scribe while closing. */
const FLUSH_TIMEOUT_MS = 2_500

export type ScribeHealth = {
  /** Why the scribe cannot write; null once a check or a write went through. */
  issue: ScribeIssue | null
  /** Backend detail of the issue, when there is one. */
  detail: string | null
  checking: boolean
  checkedAt: number | null
}

export type ScribeStatus = QueueSnapshot & {
  listening: boolean
  /** The agents' session note of today (vault-relative). */
  notePath: string | null
  /** Syntheses written to Obsidian since the app started. */
  writes: number
  /** Something is being written to Obsidian right now. */
  writing: boolean
  health: ScribeHealth
}

export const useScribeStatus = create<ScribeStatus>(() => ({
  listening: false,
  notePath: null,
  pending: 0,
  sending: false,
  failures: 0,
  lastOkAt: null,
  lastError: null,
  nextRetryAt: null,
  failed: [],
  dropped: 0,
  writes: 0,
  writing: false,
  health: { issue: null, detail: null, checking: false, checkedAt: null },
}))

/* ------------------------------------------------------------------ vault access */

function target() {
  return { vaultPath: getScribeConfig().vaultPath.trim() }
}

/** The vault, finding it first when none is set; a missing one only means "wait". */
async function vaultOrWait(): Promise<{ vaultPath: string }> {
  if (!getScribeConfig().vaultPath.trim()) await checkScribe()
  const found = target()
  if (!found.vaultPath) throw new Error('vault not configured')
  return found
}

const writerDeps: WriterDeps = {
  read: async (notePath, tail = false) => {
    const vault = await vaultOrWait()
    try {
      const note = await obsidianRead(vault, notePath, tail)
      return { content: note.content, truncated: note.truncated }
    } catch (error) {
      if (/note not found/i.test(String(error))) return null
      throw error instanceof Error ? error : new Error(String(error))
    }
  },
  put: async (notePath, content) => obsidianPut(await vaultOrWait(), notePath, content),
  patch: async (notePath, heading, content) =>
    obsidianPatchHeading(await vaultOrWait(), notePath, heading, content),
  append: async (notePath, content) => obsidianAppend(await vaultOrWait(), notePath, content),
}

let cachedIndex: { vault: string; at: number; index: VaultIndex | null } | null = null

async function vaultIndex(vaultPath: string): Promise<VaultIndex | null> {
  const now = Date.now()
  if (cachedIndex && cachedIndex.vault === vaultPath && now - cachedIndex.at < INDEX_TTL_MS)
    return cachedIndex.index
  let index: VaultIndex | null = null
  try {
    index = vaultIndexFrom(await scribeVaultIndex(vaultPath))
  } catch {
    // Without an index links cannot be checked; they are kept as written.
  }
  cachedIndex = { vault: vaultPath, at: now, index }
  return index
}

/* ------------------------------------------------------------------ module state */

let installed = false
let queue: WriteQueue | null = null
let scheduler: AuthorScheduler | null = null
/** Bus of the installed store, for the `obsidian → <note>` lines. */
let post: ScribeStore['post'] | null = null
let liveStore: ScribeStore | null = null
/** Vault the scribe picked itself, so its own config change does not trigger a re-check. */
let adoptedVault: string | null = null
let check: Promise<void> | null = null
let lastFailureCheck = 0
/** Sessions followed now, with their latest snapshot. */
const followed = new Map<string, ScribeSession>()
/** Run id of the author running now, so closing the app can stop it. */
let currentRun: { sessionId: string; runId: string } | null = null
/** Batches of this run's syntheses, so their outcome reaches the session's status. */
const batchSessions = new Map<
  number,
  {
    sessionId: string
    summary: string | null
    notePath: string | null
    issues: string[]
    /** When the author run that made the batch started. */
    startedAt: number
  }
>()

/** What `scribeSaveReport` resolves with. */
export type ScribeSaveResult = {
  /** `queued`: waiting for Obsidian; it is written as soon as Obsidian answers. */
  status: 'written' | 'failed' | 'off' | 'queued'
  notePath: string | null
  detail: string | null
}

type Waiter = { requestedAt: number; resolve: (result: ScribeSaveResult) => void }
/** Callers waiting for the next synthesis of a session (a report saved to Obsidian). */
const waiters = new Map<string, Waiter[]>()
/** Batches filed as is (a report with the author off), and who waits for them. */
const filedBatches = new Map<number, (result: ScribeSaveResult) => void>()

/** Resolves the waiters a run covers: those that asked before it started. */
function settleWaiters(sessionId: string, runStartedAt: number, result: ScribeSaveResult): void {
  const list = waiters.get(sessionId)
  if (!list) return
  const later = list.filter((w) => w.requestedAt > runStartedAt)
  for (const waiter of list) if (waiter.requestedAt <= runStartedAt) waiter.resolve(result)
  if (later.length) waiters.set(sessionId, later)
  else waiters.delete(sessionId)
}
/** Sessions already re-run once after a conflict, so two writers cannot loop. */
const conflictReruns = new Set<string>()
/** Second attempts of failed final passes, waiting to run. */
const finalRetries = new Map<string, ReturnType<typeof setTimeout>>()

const material = new MaterialLog({
  append: (sessionId, lines) => scribeMaterialAppend(sessionId, lines),
  read: (sessionId) => scribeMaterialRead(sessionId),
  remove: (sessionId) => scribeMaterialRemove(sessionId),
})

function setStatus(patch: Partial<ScribeStatus>): void {
  useScribeStatus.setState(patch)
}

function recordMaterial(sessionId: string, entries: MaterialEntry[]): void {
  try {
    material.record(sessionId, entries)
  } catch (error) {
    console.warn('[scribe] material entry dropped', error)
  }
}

/* ------------------------------------------------------------------ writes */

function onBatchDone(batch: QueueBatch, at: number): void {
  const filed = filedBatches.get(batch.id)
  if (filed) {
    filedBatches.delete(batch.id)
    filed({
      status: batch.done.length ? 'written' : 'failed',
      notePath: batch.done[0] ?? null,
      detail: batch.issues[0] ?? null,
    })
  }
  const sessionId = batch.session
  // Notes filed as is (`orch note`, a report) are not syntheses.
  if (!sessionId || batch.kind === 'note') return
  const known = batchSessions.get(batch.id)
  batchSessions.delete(batch.id)
  // Only the diary note is rewritten whole, so only it can change under the author.
  const conflict = batch.issues.some(
    (issue) =>
      issue.startsWith(CONFLICT_ISSUE) &&
      Boolean(known?.notePath) &&
      issue.endsWith(known?.notePath ?? ''),
  )
  const notes = batch.done
  const failedAll = notes.length === 0
  const status = authorStatusOf(sessionId)
  patchAuthorStatus(sessionId, {
    phase: failedAll ? 'failed' : status.phase === 'saving' ? 'ready' : status.phase,
    failure: failedAll ? 'write' : null,
    detail: failedAll ? (batch.issues[0] ?? null) : null,
    notes,
    issues: [
      ...(known?.issues ?? []),
      ...batch.issues.filter((i) => !i.startsWith(CONFLICT_ISSUE)),
    ],
    lastAt: at,
    syntheses: failedAll ? status.syntheses : status.syntheses + 1,
  })
  if (!failedAll) {
    useScribeStatus.setState((s) => ({ writes: s.writes + 1 }))
    const record = updateSessionRecord(sessionId, {
      lastAt: at,
      lastNotes: notes,
      syntheses: (sessionRecord(sessionId)?.syntheses ?? 0) + 1,
    })
    const note = known?.notePath ?? record.sessionNote ?? notes[0]
    if (note) {
      try {
        post?.(sessionId, noteFileName(note), known?.summary ?? batch.label, at)
      } catch (error) {
        console.warn('[scribe] bus line failed', error)
      }
    }
  }
  if (known) {
    const note = known.notePath ?? notes[0] ?? null
    settleWaiters(
      sessionId,
      known.startedAt,
      failedAll
        ? { status: 'failed', notePath: null, detail: batch.issues[0] ?? null }
        : { status: 'written', notePath: note, detail: null },
    )
  }
  // The note changed under the author (the owner or an agent edited it): one more pass.
  if (conflict && !conflictReruns.has(sessionId)) {
    conflictReruns.add(sessionId)
    getScheduler().request(sessionId, 'manual')
  }
}

function getQueue(): WriteQueue {
  if (!queue) {
    queue = new WriteQueue({
      storageKey: WRITES_KEY,
      apply: (op, done) => applyWriteOp(op, done, writerDeps),
      onBatchDone,
    })
    queue.subscribe((snapshot) => {
      const firstFailure = snapshot.failures === 1 && useScribeStatus.getState().failures === 0
      setStatus({ ...snapshot, writing: snapshot.sending })
      // The first failure of a streak asks Obsidian why, so the chip can name the cause.
      if (firstFailure && Date.now() - lastFailureCheck > FAILURE_CHECK_MS) {
        lastFailureCheck = Date.now()
        void checkScribe()
      }
    })
    setStatus({ ...queue.snapshot(), writing: false })
  }
  return queue
}

/** Writes what waits in the queue right away (the panel's "retry now"). */
export function scribeRetryNow(): void {
  getQueue().retryNow()
  void checkScribe()
}

/** Forgets an item that could not be written (after the owner copied it). */
export function scribeDiscardFailed(id: number): void {
  getQueue().discard(id)
}

/* ------------------------------------------------------------------ the author */

function snapshotOf(session: ScribeSession, endedAt: number | null): SessionSnapshot {
  const orchestrator = session.agents.find((a) => a.id === ORCHESTRATOR)
  const projectName = session.projectId
    ? (liveStore?.projectName?.(session.projectId) ?? null)
    : null
  const agents: AuthorAgent[] = session.agents.map((a) => ({
    id: a.id,
    area: a.area,
    state: a.state,
    progress: a.progress,
    task: redactSecrets(a.task ?? ''),
    note: redactSecrets(a.note ?? ''),
    transcriptPath: a.transcriptPath ?? null,
    history: (a.history ?? []).map((h) => ({
      task: redactSecrets(h.task),
      note: redactSecrets(h.note),
    })),
  }))
  return {
    id: session.id,
    projectName,
    cwd: session.cwd,
    goal: redactSecrets(session.goal),
    startedAt: session.startedAt ?? null,
    endedAt,
    agents,
    account: orchestrator?.account ?? null,
    model: orchestrator?.model ?? null,
    effort: orchestrator?.effort ?? null,
  }
}

function liveSnapshot(sessionId: string): SessionSnapshot | null {
  const session = liveStore?.getState().sessions[sessionId] ?? followed.get(sessionId)
  return session ? snapshotOf(session, null) : null
}

let runSeq = 0

function synthesisDeps(): SynthesisDeps {
  return {
    config: getScribeConfig,
    now: Date.now,
    record: sessionRecord,
    snapshot: (id) => liveSnapshot(id) ?? sessionRecord(id)?.snapshot ?? null,
    material: (id) => material.load(id),
    contextNotes: (id) => sessionContextOf(id)?.notes.map((note) => note.path) ?? [],
    read: (notePath) => writerDeps.read(notePath),
    list: async (dir) => obsidianList(await vaultOrWait(), dir),
    index: vaultIndex,
    sources: (request) => scribeReadSources(request),
    accountDir: accountConfigDirCached,
    launchDefaults,
    run: async (request) => {
      currentRun = { sessionId: request.runId.split('-')[0], runId: request.runId }
      try {
        return await scribeAuthorRun(request)
      } finally {
        currentRun = null
      }
    },
    enqueue: (batch) => getQueue().enqueue(batch),
    runId: (id) => `${id}-${Date.now().toString(36)}-${(++runSeq).toString(36)}`,
  }
}

/** Failures that happen before the CLI spends anything: they never use up a final attempt. */
const FREE_FAILURES = new Set<AuthorFailure>([
  'no-vault',
  'unreachable',
  'no-session',
  'cli-missing',
  'cli-locks',
  'invalid',
  'cancelled',
])
/** A final pass that failed once runs again after this long (in this run of the app). */
const FINAL_RETRY_MS = 5 * 60_000

/** Adds what a run cost to its session, on screen and in the session's record. */
function addCost(sessionId: string, cost: number | null | undefined): void {
  const value = typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : null
  const status = authorStatusOf(sessionId)
  patchAuthorStatus(sessionId, {
    lastCostUsd: value,
    sessionCostUsd: status.sessionCostUsd + (value ?? 0),
  })
  if (value !== null)
    updateSessionRecord(sessionId, { costUsd: (sessionRecord(sessionId)?.costUsd ?? 0) + value })
}

/**
 * A final pass failed. A failure that spent nothing stays owed (it runs again when Obsidian
 * answers, or at the next start). One that spent usage is tried once more; the second time it
 * is given up: the session's material goes to the items that could not be written, to copy or
 * discard, and nothing retries it on its own again.
 */
async function finalFailed(
  sessionId: string,
  failure: AuthorFailure,
  detail: string | null,
): Promise<void> {
  if (FREE_FAILURES.has(failure)) return
  const record = sessionRecord(sessionId)
  const attempts = (record?.finalAttempts ?? 0) + 1
  if (attempts < MAX_FINAL_ATTEMPTS) {
    updateSessionRecord(sessionId, { finalAttempts: attempts })
    const timer = setTimeout(() => {
      finalRetries.delete(sessionId)
      const config = getScribeConfig()
      if (config.enabled && config.authorEnabled && sessionRecord(sessionId)?.pendingFinal)
        getScheduler().request(sessionId, 'resume', { final: true })
    }, FINAL_RETRY_MS)
    finalRetries.set(sessionId, timer)
    return
  }
  updateSessionRecord(sessionId, { finalAttempts: attempts, pendingFinal: false, snapshot: null })
  const entries = await material.load(sessionId).catch(() => [] as MaterialEntry[])
  getQueue().report({
    session: sessionId,
    label: 'final',
    notePath:
      record?.sessionNote ??
      record?.diaryPath ??
      notePathFor(getScribeConfig(), record?.snapshot?.startedAt ?? Date.now()),
    content: renderMaterial(entries),
    reason: detail ? `${failure}: ${detail}` : failure,
    reasonKey: 'orchestra.scribe.finalGivenUp',
    reasonParams: { count: attempts },
  })
}

async function runAuthor(request: AuthorRequest): Promise<boolean> {
  const id = request.sessionId
  const startedAt = Date.now()
  const pending = finalRetries.get(id)
  if (pending !== undefined) {
    clearTimeout(pending)
    finalRetries.delete(id)
  }
  patchAuthorStatus(id, { phase: 'writing', since: startedAt, failure: null, detail: null })
  // Material recorded until now is part of this pass.
  await material.flush()
  const result = await runSynthesis(request, synthesisDeps())
  addCost(id, result.outcome?.costUsd)
  if (!result.ok) {
    const detail = result.detail ? redactSecrets(result.detail).slice(0, 400) : null
    patchAuthorStatus(id, { phase: 'failed', since: null, failure: result.failure, detail })
    settleWaiters(id, startedAt, {
      status: 'failed',
      notePath: null,
      detail: detail ?? result.failure,
    })
    if (request.final) await finalFailed(id, result.failure, detail)
    return false
  }
  const { plan, diaryPath, title } = result
  const wroteDiary = plan.ops.some((op) => op.notePath === diaryPath)
  const sessionNote =
    plan.sessionNote ?? (wroteDiary ? diaryPath : (sessionRecord(id)?.sessionNote ?? null))
  batchSessions.set(result.batchId, {
    sessionId: id,
    summary: plan.summary,
    notePath: sessionNote,
    issues: plan.issues,
    startedAt,
  })
  updateSessionRecord(id, {
    title,
    ...(wroteDiary ? { diaryPath } : {}),
    sessionNote,
    lastSummary: plan.summary,
    ...(request.final ? { pendingFinal: false, snapshot: null, finalAttempts: 0 } : {}),
  })
  patchAuthorStatus(id, {
    phase: 'saving',
    since: null,
    title,
    notePath: sessionNote,
    summary: plan.summary,
    issues: plan.issues,
  })
  const touched = plan.ops.map((op) => noteName(op.notePath))
  recordMaterial(id, [
    {
      at: Date.now(),
      kind: 'synthesis',
      text: `${plan.summary ?? 'síntese escrita'} (notas: ${[...new Set(touched)].join(', ')})`,
    },
  ])
  return true
}

/**
 * Final passes still owed by sessions that are gone (the app closed with them running, or
 * Obsidian did not answer): asked again at start and when Obsidian answers again, never past
 * the attempt limit.
 */
function resumeOwedFinals(): void {
  const config = getScribeConfig()
  if (!installed || !config.enabled || !config.authorEnabled) return
  for (const record of pendingFinalRecords()) {
    if (followed.has(record.id) || finalRetries.has(record.id)) continue
    if ((record.finalAttempts ?? 0) >= MAX_FINAL_ATTEMPTS) continue
    getScheduler().request(record.id, 'resume', { final: true })
  }
}

/** Turns the author on (the owner's explicit choice: it spends the session account's usage). */
export function scribeEnableAuthor(): void {
  useScribeConfig.getState().update({ authorEnabled: true })
}

function scheduleState(sessionId: string, state: ScheduleState): void {
  const current: AuthorStatus = authorStatusOf(sessionId)
  switch (state.phase) {
    case 'scheduled':
      patchAuthorStatus(sessionId, { phase: 'scheduled', dueAt: state.dueAt })
      return
    case 'queued':
      patchAuthorStatus(sessionId, { phase: 'queued', dueAt: null })
      return
    case 'running':
      patchAuthorStatus(sessionId, { phase: 'writing', dueAt: null, since: state.since })
      return
    default:
      // Back to idle: keep the outcome of the last run on screen.
      if (current.phase === 'scheduled' || current.phase === 'queued')
        patchAuthorStatus(sessionId, { phase: current.lastAt ? 'ready' : 'idle', dueAt: null })
  }
}

function getScheduler(): AuthorScheduler {
  if (!scheduler) {
    scheduler = new AuthorScheduler({
      run: runAuthor,
      debounceMs: () => authorDelayMs(getScribeConfig()),
      onChange: scheduleState,
    })
  }
  return scheduler
}

/** "Write the note now": a pass for the session right away, whatever the triggers say. */
export function scribeWriteNow(sessionId: string): void {
  const config = getScribeConfig()
  if (!config.enabled || !config.authorEnabled) return
  conflictReruns.delete(sessionId)
  getScheduler().request(sessionId, 'manual')
}

const REPORT_WAIT_MS = 15_000

/**
 * Saves a session report to Obsidian the owner's way: it becomes material of the session
 * (secrets masked) and the author folds it into the session's diary note, instead of a raw
 * report note. Resolves when that note is written, or failed. With the author off, the report
 * is filed as a section of the agents' note instead (`queued` while Obsidian is away).
 */
export function scribeSaveReport(input: {
  sessionId: string
  markdown: string
}): Promise<ScribeSaveResult> {
  const config = getScribeConfig()
  const text = redactSecrets(input.markdown).trim()
  if (!config.enabled || !installed || !text)
    return Promise.resolve({ status: 'off', notePath: null, detail: null })
  const at = Date.now()
  recordMaterial(input.sessionId, [{ at, kind: 'note', agent: 'relatório', text }])
  if (config.authorEnabled) {
    return new Promise<ScribeSaveResult>((resolve) => {
      const list = waiters.get(input.sessionId) ?? []
      list.push({ requestedAt: at, resolve })
      waiters.set(input.sessionId, list)
      conflictReruns.delete(input.sessionId)
      getScheduler().request(input.sessionId, 'manual')
    })
  }
  const batchId = getQueue().enqueue({
    session: input.sessionId,
    label: 'relatório da sessão',
    kind: 'note',
    ops: [
      {
        kind: 'section',
        notePath: notePathFor(config, at),
        heading: `Relatório da sessão · ${brDate(at)} ${hhmm(at)}`,
        content: text,
        diary: false,
        createIfMissing: true,
      },
    ],
  })
  if (batchId === null) return Promise.resolve({ status: 'failed', notePath: null, detail: null })
  return new Promise<ScribeSaveResult>((resolve) => {
    const timer = setTimeout(() => {
      filedBatches.delete(batchId)
      resolve({ status: 'queued', notePath: notePathFor(config, at), detail: null })
    }, REPORT_WAIT_MS)
    filedBatches.set(batchId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

/* ------------------------------------------------------------------ health */

function setHealth(patch: Partial<ScribeHealth>): void {
  useScribeStatus.setState((s) => ({ health: { ...s.health, ...patch } }))
}

async function runCheck(redetect: boolean): Promise<void> {
  const before = useScribeStatus.getState().health.issue
  if (!getScribeConfig().enabled) {
    setHealth({ issue: null, detail: null, checking: false })
    return
  }
  setHealth({ checking: true })
  let issue: ScribeIssue | null = null
  let detail: string | null = null
  try {
    let vaultPath = getScribeConfig().vaultPath.trim()
    let status = vaultPath ? await obsidianStatus({ vaultPath }) : null
    if (!vaultPath || (redetect && status && !status.vault_exists)) {
      const found = await obsidianDetectVaults()
      const vaults = Array.isArray(found) ? found : []
      const picked = pickVault(vaults)
      if (picked && picked !== vaultPath) {
        adoptedVault = picked
        useScribeConfig.getState().update({ vaultPath: picked })
        vaultPath = picked
        status = await obsidianStatus({ vaultPath })
      } else if (!vaultPath) {
        issue = vaults.length > 1 ? 'pick-vault' : 'no-vault'
      }
    }
    if (status) {
      issue = issueFromStatus(status)
      detail = issue ? status.error : null
    }
  } catch (error) {
    issue = 'unreachable'
    detail = error instanceof Error ? error.message : String(error)
  }
  setHealth({ issue, detail, checking: false, checkedAt: Date.now() })
  // Just fixed (vault found, Obsidian opened): send what waited.
  if (before && !issue) {
    if (queue && queue.snapshot().pending > 0) queue.retryNow()
    // Final passes that waited for Obsidian go now.
    resumeOwedFinals()
  }
}

/**
 * Finds the vault when none is set (Obsidian's open vault, else the only one) and asks the
 * Local REST API whether the scribe can write. Never throws and never blocks a session:
 * the outcome lands in `useScribeStatus().health`. `redetect` also replaces a configured
 * vault whose folder is gone.
 */
export function checkScribe(options: { redetect?: boolean } = {}): Promise<void> {
  // An explicit "detect again" never settles for a plain check already in flight.
  if (check && options.redetect) return check.then(() => checkScribe(options))
  if (!check) {
    check = runCheck(options.redetect ?? false).finally(() => {
      check = null
    })
  }
  return check
}

/* ------------------------------------------------------------------ session context (claude-5) */

export type SessionContextInput = {
  sessionId: string
  goal: string
  cwd: string | null
  projectName?: string | null
  /** When the session started. */
  at?: number
}

async function consultVault(input: SessionContextInput, at: number): Promise<ObsidianContext> {
  const deadline = Date.now() + CONTEXT_BUDGET_MS
  // No vault yet: the scribe looks for Obsidian's open vault first, inside the same budget.
  if (!getScribeConfig().vaultPath.trim()) {
    await settleWithin(() => checkScribe(), deadline - Date.now())
  }
  const config = getScribeConfig()
  const vaultPath = config.vaultPath.trim()
  if (!vaultPath) return contextState('failed', at, { failure: 'no-vault' })
  const vault = { vaultPath }
  return gatherObsidianContext(
    {
      at,
      subject: { projectName: input.projectName, cwd: input.cwd, goal: input.goal },
      vaultPath,
      sessionNote: notePathFor(config, at),
      maxNotes: contextNoteLimit(config),
      budgetMs: deadline - Date.now(),
    },
    {
      search: (query) => obsidianSearch(vault, query, SEARCH_CONTEXT_LENGTH),
      read: (notePath, tail) => obsidianRead(vault, notePath, tail),
      list: (dir) => obsidianList(vault, dir),
      write: (markdown) => obsidianWriteContext(input.sessionId, markdown),
    },
  )
}

/**
 * Consults Obsidian for a session about to start (see `context.ts`) and keeps the result for the
 * chip, the agent prompts and the session's material. Bounded by CONTEXT_BUDGET_MS and never
 * rejects: without Obsidian the session starts without context and the chip says why. The
 * pending state is set before this returns.
 */
export function prepareSessionContext(input: SessionContextInput): Promise<ObsidianContext> {
  const at = input.at ?? Date.now()
  if (!getScribeConfig().consultContext) {
    const off = contextState('off', at)
    setSessionContext(input.sessionId, off)
    return Promise.resolve(off)
  }
  setSessionContext(input.sessionId, contextState('pending', at))
  const run = consultVault(input, at)
    .catch((error: unknown) =>
      contextState('failed', at, { failure: 'unreachable', detail: String(error) }),
    )
    .then((context) => {
      // The session ended while the vault was consulted: nobody will read that file.
      if (!sessionContextOf(input.sessionId)) {
        if (context.file) void obsidianRemoveContext(input.sessionId).catch(() => {})
        return context
      }
      setSessionContext(input.sessionId, context)
      return context
    })
  trackSessionContext(input.sessionId, run)
  return run
}

/** A session ended: its context goes, and so does the file its agents read. */
function forgetSessionContext(sessionId: string): void {
  const context = clearSessionContext(sessionId)
  if (context?.file) void obsidianRemoveContext(sessionId).catch(() => {})
}

/** The material line about the Obsidian consultation made before the orchestrator started. */
function contextEntry(context: ObsidianContext | null, at: number): MaterialEntry | null {
  if (!context || context.status === 'off' || context.status === 'pending') return null
  if (context.status === 'failed')
    return {
      at,
      kind: 'context',
      text: `Obsidian não consultado no início (${context.failure ?? 'erro'})`,
    }
  const links = context.notes.map((note) => `[[${noteName(note.path)}]]`)
  return {
    at,
    kind: 'context',
    text: `Notas consultadas no início: ${links.length ? links.join(', ') : 'nenhuma relacionada'}`,
  }
}

/* ------------------------------------------------------------------ following sessions */

/** The scribe lives in the main window only; the monitor window loads the same bundle. */
function isMainWindow(): boolean {
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } }
      }
    ).__TAURI_INTERNALS__
    const label = internals?.metadata?.currentWindow?.label
    return !label || label === 'main'
  } catch {
    return true
  }
}

function startEntry(session: ScribeSession, at: number): MaterialEntry {
  const projectName = session.projectId ? liveStore?.projectName?.(session.projectId) : undefined
  const parts = [
    `Sessão iniciada em ${brDate(at)} ${hhmm(at)}`,
    projectName ? `projeto ${projectName}` : '',
    session.cwd ? `pasta ${session.cwd}` : '',
    `objetivo: ${session.goal}`,
  ].filter(Boolean)
  return { at, kind: 'start', text: redactSecrets(parts.join(' · ')) }
}

function endEntry(session: ScribeSession, at: number): MaterialEntry {
  const workers = session.agents.filter((a) => a.id !== ORCHESTRATOR)
  const done = workers.filter((a) => a.state === 'done').length
  const open = workers
    .filter((a) => a.state !== 'done')
    .map((a) => `${a.id} ${a.progress}%`)
    .join(', ')
  return {
    at,
    kind: 'end',
    text: `Sessão encerrada: ${workers.length} workers, ${done} concluídos${open ? `; em aberto: ${open}` : ''}`,
  }
}

/** The final pass of a session is owed: kept with a snapshot, so it survives a restart. */
function owedFinal(session: ScribeSession, at: number): void {
  updateSessionRecord(session.id, { pendingFinal: true, snapshot: snapshotOf(session, at) })
}

/** Files an `orch note` in the agents' session note, under the agent's own heading. */
function fileAgentNote(event: {
  session: string
  at: number
  agent_id: string
  text: string
}): void {
  const config = getScribeConfig()
  const text = redactSecrets(event.text ?? '').trim()
  if (!text) return
  const session = followed.get(event.session)
  const area = session?.agents.find((a) => a.id === event.agent_id)?.area
  getQueue().enqueue({
    session: event.session,
    label: `orch note · ${event.agent_id}`,
    kind: 'note',
    ops: [
      {
        kind: 'section',
        notePath: notePathFor(config, event.at),
        heading: area && area !== event.agent_id ? `${event.agent_id} · ${area}` : event.agent_id,
        content: text,
        diary: false,
        createIfMissing: true,
      },
    ],
  })
}

function isWorkerDone(event: OrchestraEvent): string | null {
  if (event.kind !== 'report' || event.agent_id === ORCHESTRATOR) return null
  return event.status === 'done' || event.progress === 100 ? event.agent_id : null
}

/**
 * Starts following `store`: material for every session that runs while the scribe is on, an
 * author pass when a worker finishes and when the session ends, and the queue of writes.
 * Also checks Obsidian right away (app start) and whenever a session starts. Only the main
 * window installs it. Returns a function that uninstalls it.
 */
export function installScribe(store: ScribeStore): () => void {
  if (installed || !isMainWindow()) return () => {}
  installed = true
  liveStore = store
  post = store.post ?? null
  let recheck: ReturnType<typeof setTimeout> | null = null
  const enabled = () => getScribeConfig().enabled

  try {
    // The first scribe queued raw log blocks; the owner does not want them in the vault.
    if (localStorage.getItem(LEGACY_QUEUE_KEY) !== null) localStorage.removeItem(LEGACY_QUEUE_KEY)
  } catch {
    // Storage unavailable: nothing to clean.
  }

  const begin = (session: ScribeSession) => {
    // A stopped session is over: nothing new to follow.
    if (!enabled() || session.stoppedAt) return
    followed.set(session.id, session)
    const at = session.startedAt ?? Date.now()
    recordMaterial(session.id, [startEntry(session, at)])
    const settled = whenContextSettled(session.id)
    const addContext = () => {
      const entry = contextEntry(sessionContextOf(session.id), Date.now())
      if (entry) recordMaterial(session.id, [entry])
    }
    if (settled) void settled.then(addContext, addContext)
    else addContext()
    setStatus({ listening: true, notePath: notePathFor(getScribeConfig(), at) })
    void checkScribe()
  }

  const end = (session: ScribeSession) => {
    const at = Date.now()
    followed.delete(session.id)
    recordMaterial(session.id, [endEntry(session, at)])
    void material.flush()
    setStatus({ listening: followed.size > 0 })
    const config = getScribeConfig()
    if (config.authorEnabled && config.authorOnSessionEnd) {
      owedFinal(session, at)
      getScheduler().request(session.id, 'session-end', { final: true })
    }
  }

  const onEvent = (event: OrchestraEvent) => {
    if (!followed.has(event.session) || !enabled()) return
    recordMaterial(event.session, materialFromEvent(event))
    if ((event as { kind: string }).kind === 'note')
      fileAgentNote(
        event as unknown as { session: string; at: number; agent_id: string; text: string },
      )
    const finished = isWorkerDone(event)
    const config = getScribeConfig()
    if (finished && config.authorEnabled && config.authorOnWorkerDone)
      getScheduler().request(event.session, 'worker-done', { finished: [finished] })
  }

  const unsubscribe = store.subscribe((state, prev) => {
    for (const [id, session] of Object.entries(prev.sessions)) {
      if (state.sessions[id]) continue
      if (followed.has(id)) end(session)
      forgetSessionContext(id)
    }
    for (const [id, session] of Object.entries(state.sessions)) {
      // Stopping the agents ends the session for the scribe; closing it later only forgets it.
      if (followed.has(id) && session.stoppedAt && !prev.sessions[id]?.stoppedAt) end(session)
      else if (followed.has(id)) followed.set(id, session)
      else if (!prev.sessions[id]) begin(session)
    }
  })
  const unlisten = store.listen(onEvent)

  // Turned back on: follow what is already running. Settings edits are checked once they settle.
  const unwatchConfig = useScribeConfig.subscribe((config, prev) => {
    if (config.enabled && !prev.enabled) {
      for (const session of Object.values(store.getState().sessions)) {
        if (!followed.has(session.id)) begin(session)
      }
    }
    const vaultEdited = config.vaultPath !== prev.vaultPath && config.vaultPath !== adoptedVault
    if (config.enabled !== prev.enabled || vaultEdited) {
      if (recheck !== null) clearTimeout(recheck)
      recheck = setTimeout(() => {
        recheck = null
        void checkScribe()
      }, RECHECK_MS)
    }
  })

  for (const session of Object.values(store.getState().sessions)) begin(session)
  // Writes queued by a previous run go out now.
  if (getQueue().snapshot().pending > 0) getQueue().retryNow()
  void checkScribe()

  // Final passes owed by a previous run (the app closed with sessions running).
  const resume = setTimeout(resumeOwedFinals, RESUME_DELAY_MS)

  return () => {
    unsubscribe()
    unlisten()
    unwatchConfig()
    clearTimeout(resume)
    for (const timer of finalRetries.values()) clearTimeout(timer)
    finalRetries.clear()
    if (recheck !== null) clearTimeout(recheck)
    void material.flush()
    scheduler?.dispose()
    scheduler = null
    followed.clear()
    post = null
    liveStore = null
    installed = false
    setStatus({ listening: false })
  }
}

/**
 * Called while the app closes: saves the material, keeps the final pass of every running
 * session owed (it runs after the next start), stops a running author and gives queued
 * writes a moment to go out. Bounded and never rejects.
 */
export async function flushScribe(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  if (!installed) return
  const deadline = Date.now() + timeoutMs
  try {
    const at = Date.now()
    const config = getScribeConfig()
    if (config.enabled && config.authorEnabled && config.authorOnSessionEnd) {
      for (const session of followed.values()) {
        recordMaterial(session.id, [endEntry(session, at)])
        owedFinal(session, at)
      }
    }
    const running = currentRun
    if (running) {
      // It cannot finish in time; its session gets a pass after the next start.
      void scribeAuthorCancel(running.runId).catch(() => false)
      const live = followed.get(running.sessionId)
      if (live) owedFinal(live, at)
      else if (sessionRecord(running.sessionId)?.snapshot)
        updateSessionRecord(running.sessionId, { pendingFinal: true })
    }
    const left = () => Math.max(0, deadline - Date.now())
    await Promise.race([
      material.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, left())),
    ])
    if (queue && queue.snapshot().pending > 0) {
      queue.retryNow()
      await queue.whenIdle(left())
    }
  } catch (error) {
    console.warn('[scribe] flush on close failed', error)
  }
}
