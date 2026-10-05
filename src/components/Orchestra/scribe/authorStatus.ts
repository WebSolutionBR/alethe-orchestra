/**
 * What the scribe's author is doing for each session, as the chip, the panel and the view
 * marks show it, plus the record kept per session across restarts (its diary note, title,
 * last synthesis, a final pass still owed).
 */
import { create } from 'zustand'

import type { AuthorAgent } from './author'

export type AuthorPhase =
  /** Nothing asked yet (or nothing since the last synthesis). */
  | 'idle'
  /** A run is due after the quiet period. */
  | 'scheduled'
  /** Waiting for another session's author to finish. */
  | 'queued'
  /** The author is writing. */
  | 'writing'
  /** The plan is being written to the vault. */
  | 'saving'
  | 'ready'
  | 'failed'

export type AuthorFailure =
  | 'no-vault'
  | 'unreachable'
  | 'no-session'
  | 'cli-missing'
  | 'cli-locks'
  | 'invalid'
  | 'spawn'
  | 'timeout'
  | 'cancelled'
  | 'exit'
  | 'output'
  | 'max-turns'
  | 'max-budget'
  | 'cli-error'
  | 'plan'
  | 'empty'
  | 'write'

export const AUTHOR_FAILURES: AuthorFailure[] = [
  'no-vault',
  'unreachable',
  'no-session',
  'cli-missing',
  'cli-locks',
  'invalid',
  'spawn',
  'timeout',
  'cancelled',
  'exit',
  'output',
  'max-turns',
  'max-budget',
  'cli-error',
  'plan',
  'empty',
  'write',
]

export type AuthorStatus = {
  phase: AuthorPhase
  /** When a scheduled run is due. */
  dueAt: number | null
  /** When the current run started. */
  since: number | null
  failure: AuthorFailure | null
  detail: string | null
  /** The note the session points to (its diary note). */
  notePath: string | null
  title: string | null
  /** One line on what the last synthesis added. */
  summary: string | null
  /** Notes the last synthesis wrote or added to. */
  notes: string[]
  /** What the last synthesis dropped or could not write. */
  issues: string[]
  syntheses: number
  lastAt: number | null
  /** What the last run cost, as the CLI estimates it (US dollars); null when unknown. */
  lastCostUsd: number | null
  /** What every run of this session cost so far, failed ones included. */
  sessionCostUsd: number
}

export const IDLE_AUTHOR: AuthorStatus = {
  phase: 'idle',
  dueAt: null,
  since: null,
  failure: null,
  detail: null,
  notePath: null,
  title: null,
  summary: null,
  notes: [],
  issues: [],
  syntheses: 0,
  lastAt: null,
  lastCostUsd: null,
  sessionCostUsd: 0,
}

type AuthorState = { bySession: Record<string, AuthorStatus> }

export const useScribeAuthor = create<AuthorState>(() => ({ bySession: {} }))

export function authorStatusOf(sessionId: string): AuthorStatus {
  return useScribeAuthor.getState().bySession[sessionId] ?? IDLE_AUTHOR
}

export function patchAuthorStatus(sessionId: string, patch: Partial<AuthorStatus>): void {
  useScribeAuthor.setState((s) => ({
    bySession: {
      ...s.bySession,
      [sessionId]: { ...(s.bySession[sessionId] ?? IDLE_AUTHOR), ...patch },
    },
  }))
}

/** The author of the chip's session; idle outside a session. */
export function useAuthorStatus(sessionId: string | null): AuthorStatus {
  return useScribeAuthor((s) => (sessionId ? (s.bySession[sessionId] ?? IDLE_AUTHOR) : IDLE_AUTHOR))
}

/** The part of a session the author writes from, kept after the session is gone. */
export type SessionSnapshot = {
  id: string
  projectName: string | null
  cwd: string | null
  goal: string
  startedAt: number | null
  endedAt: number | null
  agents: AuthorAgent[]
  /** Account, model and effort the orchestrator ran with (the session's defaults). */
  account: string | null
  model: string | null
  effort: string | null
}

export type SessionRecord = {
  id: string
  title: string | null
  /** The diary note, fixed by the first synthesis. */
  diaryPath: string | null
  /** The note the chip opens: the diary note, or a same-day note the author added to. */
  sessionNote: string | null
  syntheses: number
  lastAt: number | null
  lastSummary: string | null
  lastNotes: string[]
  /** The session ended (or the app closed) before its final pass was written. */
  pendingFinal: boolean
  /** Final passes that ran and failed; at the limit the pass is given up, never retried. */
  finalAttempts: number
  /** What the author's runs for this session cost so far (US dollars, estimated). */
  costUsd: number
  /** Kept while a pass is still owed, so it can run after a restart. */
  snapshot: SessionSnapshot | null
  updatedAt: number
}

const RECORDS_KEY = 'orchestra.scribe.sessions'
const MAX_RECORDS = 40
const RECORD_TTL_MS = 14 * 24 * 60 * 60 * 1000

function loadRecords(): Record<string, SessionRecord> {
  try {
    const raw = localStorage.getItem(RECORDS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, SessionRecord>) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let records: Record<string, SessionRecord> | null = null

function all(): Record<string, SessionRecord> {
  if (!records) records = loadRecords()
  return records
}

function save(now: number): void {
  const kept = Object.values(all())
    .filter((r) => r.pendingFinal || now - r.updatedAt < RECORD_TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS)
  records = Object.fromEntries(kept.map((r) => [r.id, r]))
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records))
  } catch {
    // The record still lives in memory for this run.
  }
}

export function sessionRecord(sessionId: string): SessionRecord | null {
  return all()[sessionId] ?? null
}

export function updateSessionRecord(
  sessionId: string,
  patch: Partial<SessionRecord>,
  now: number = Date.now(),
): SessionRecord {
  const current: SessionRecord = all()[sessionId] ?? {
    id: sessionId,
    title: null,
    diaryPath: null,
    sessionNote: null,
    syntheses: 0,
    lastAt: null,
    lastSummary: null,
    lastNotes: [],
    pendingFinal: false,
    finalAttempts: 0,
    costUsd: 0,
    snapshot: null,
    updatedAt: now,
  }
  const next = {
    ...current,
    finalAttempts: current.finalAttempts ?? 0,
    costUsd: current.costUsd ?? 0,
    ...patch,
    updatedAt: now,
  }
  all()[sessionId] = next
  save(now)
  return next
}

/** Sessions whose final pass is still owed (the app closed, or the author failed). */
export function pendingFinalRecords(): SessionRecord[] {
  return Object.values(all()).filter((r) => r.pendingFinal && r.snapshot)
}

/** Final passes that failed after running at most this many times are given up. */
export const MAX_FINAL_ATTEMPTS = 2

/** Test hook: forget the in-memory copy so the next read comes from storage. */
export function resetSessionRecords(): void {
  records = null
}
