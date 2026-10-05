/**
 * Ordered, persisted queue of the scribe's writes. Each entry is one synthesis: the notes and
 * hub links its plan wrote, applied in order. Obsidian may be closed or slow, so writes never
 * block the app: entries are saved to localStorage, resumed after a restart at the operation
 * they stopped on, and retried with exponential backoff.
 *
 * Nothing gets stuck: an operation that can never succeed (a refused path, a note the scribe
 * may not overwrite) moves to a visible list of failed items, with its text, and the queue
 * goes on. Writing twice is harmless: whole notes are compared before they are written, and
 * the plugin refuses to append a section that is already there.
 */
import type { WriteOp } from './author'

export type QueueBatch = {
  id: number
  /** The orchestra session the synthesis is about. */
  session?: string
  /** Short description for the panel. */
  label: string
  /** A synthesis of the author, or a note filed as is (an agent's `orch note`, a report). */
  kind?: 'synthesis' | 'note'
  createdAt: number
  ops: WriteOp[]
  /** Index of the next operation; the earlier ones are done. */
  next: number
  /** Notes this batch wrote or found already right. */
  done: string[]
  /** What was refused along the way. */
  issues: string[]
}

/** An operation that cannot be written, kept so its text is not lost. */
export type FailedItem = {
  id: number
  session?: string
  label: string
  notePath: string
  content: string
  reason: string
  /** A translated reason for the panel, when the item has one (`reason` stays the detail). */
  reasonKey?: string
  reasonParams?: Record<string, string | number>
  at: number
}

export type QueueSnapshot = {
  /** Syntheses waiting to be written. */
  pending: number
  sending: boolean
  /** Consecutive failed attempts (Obsidian closed, timeout). */
  failures: number
  lastOkAt: number | null
  lastError: string | null
  nextRetryAt: number | null
  failed: FailedItem[]
  /** Syntheses dropped because the queue was full. */
  dropped: number
}

export type ApplyResult = { status: 'written' | 'unchanged'; detail?: string }

/** Thrown by `apply` for an operation that will never succeed: it is not retried. */
export class PermanentWriteError extends Error {}

/**
 * The note changed after the author read it. Not a failure to keep: the next pass redoes it
 * from the new content, so the batch only records it (issues starting with `conflict:`).
 */
export class ConflictWriteError extends PermanentWriteError {}

export const CONFLICT_ISSUE = 'conflict:'

export type WriteQueueOptions = {
  /** Applies one operation; `done` lists the notes already written by its batch. */
  apply: (op: WriteOp, done: string[]) => Promise<ApplyResult>
  storageKey?: string
  now?: () => number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Oldest syntheses are dropped (and counted) beyond this. */
  maxBatches?: number
  maxFailed?: number
  /** Retries of one operation for errors that are not about Obsidian being away. */
  maxAttempts?: number
  /** Called when a batch is over (written, or partly refused). */
  onBatchDone?: (batch: QueueBatch, at: number) => void
  /** Errors that only mean "wait": Obsidian closed, timeout, vault not found yet. */
  isWaiting?: (message: string) => boolean
}

const DEFAULT_WAITING =
  /timeout|not reachable|vault not configured|rejected the key|unreachable|ECONN|network|failed to fetch/i

type Stored = { batches: QueueBatch[]; failed: FailedItem[]; dropped: number }

function opText(op: WriteOp): string {
  return op.kind === 'hub' ? op.lines.join('\n') : op.content
}

export class WriteQueue {
  private batches: QueueBatch[] = []
  private failedItems: FailedItem[] = []
  private droppedCount = 0
  private seq = 0
  private failures = 0
  private attempts = 0
  private sending = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastOkAt: number | null = null
  private lastError: string | null = null
  private nextRetryAt: number | null = null
  private listeners = new Set<(snapshot: QueueSnapshot) => void>()
  private idle = new Set<() => void>()
  private disposed = false
  private readonly opts: Required<Omit<WriteQueueOptions, 'storageKey' | 'onBatchDone'>> &
    Pick<WriteQueueOptions, 'storageKey' | 'onBatchDone'>

  constructor(options: WriteQueueOptions) {
    this.opts = {
      now: Date.now,
      baseDelayMs: 5_000,
      maxDelayMs: 5 * 60_000,
      maxBatches: 50,
      maxFailed: 30,
      maxAttempts: 6,
      isWaiting: (message) => DEFAULT_WAITING.test(message),
      ...options,
    }
    this.restore()
  }

  snapshot(): QueueSnapshot {
    return {
      pending: this.batches.length,
      sending: this.sending,
      failures: this.failures,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      failed: this.failedItems,
      dropped: this.droppedCount,
    }
  }

  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  enqueue(batch: {
    session?: string
    label: string
    ops: WriteOp[]
    kind?: 'synthesis' | 'note'
  }): number | null {
    if (this.disposed || batch.ops.length === 0) return null
    const id = ++this.seq
    this.batches.push({
      id,
      ...(batch.session ? { session: batch.session } : {}),
      label: batch.label,
      ...(batch.kind ? { kind: batch.kind } : {}),
      createdAt: this.opts.now(),
      ops: batch.ops,
      next: 0,
      done: [],
      issues: [],
    })
    if (this.batches.length > this.opts.maxBatches) {
      const over = this.batches.length - this.opts.maxBatches
      this.batches = this.batches.slice(over)
      this.droppedCount += over
    }
    this.persist()
    this.notify()
    // While backing off, the scheduled retry picks this entry up.
    if (this.timer === null) void this.flush()
    return id
  }

  /** Writes everything queued, oldest first; stops at the first error that means "wait". */
  async flush(): Promise<void> {
    if (this.sending || this.disposed) return
    this.clearTimer()
    this.sending = true
    this.notify()
    try {
      while (this.batches.length > 0 && !this.disposed) {
        const batch = this.batches[0]
        while (batch.next < batch.ops.length) {
          const op = batch.ops[batch.next]
          try {
            const result = await this.opts.apply(op, batch.done)
            if (!batch.done.includes(op.notePath)) batch.done.push(op.notePath)
            if (result.detail) batch.issues.push(result.detail)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const permanent =
              error instanceof PermanentWriteError ||
              (!this.opts.isWaiting(message) && ++this.attempts >= this.opts.maxAttempts)
            if (!permanent) {
              this.failures++
              this.lastError = message
              this.persist()
              this.scheduleRetry()
              return
            }
            if (error instanceof ConflictWriteError)
              batch.issues.push(`${CONFLICT_ISSUE} ${op.notePath}`)
            else this.fail(batch, op, message)
          }
          this.attempts = 0
          batch.next++
          this.persist()
        }
        this.batches.shift()
        const at = this.opts.now()
        this.failures = 0
        this.lastError = null
        this.lastOkAt = at
        this.persist()
        try {
          this.opts.onBatchDone?.(batch, at)
        } catch {
          // A failing listener must not stop the queue.
        }
      }
    } finally {
      this.sending = false
      this.notify()
      if (this.batches.length === 0) for (const resolve of this.idle) resolve()
    }
  }

  /** Retries right away, e.g. after the user fixed the settings or opened Obsidian. */
  retryNow(): void {
    this.failures = 0
    void this.flush()
  }

  /** Resolves once the queue is empty, or after `timeoutMs`; never rejects. */
  whenIdle(timeoutMs: number): Promise<void> {
    if (this.batches.length === 0 && !this.sending) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.idle.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.idle.add(done)
    })
  }

  /**
   * Keeps something that will never be written by itself (a final pass given up), with its
   * text, next to the writes that could not go through.
   */
  report(item: {
    session?: string
    label: string
    notePath: string
    content: string
    reason: string
    reasonKey?: string
    reasonParams?: Record<string, string | number>
  }): void {
    this.failedItems = [
      ...this.failedItems,
      {
        id: ++this.seq,
        ...(item.session ? { session: item.session } : {}),
        label: item.label,
        notePath: item.notePath,
        content: item.content,
        reason: item.reason,
        ...(item.reasonKey ? { reasonKey: item.reasonKey } : {}),
        ...(item.reasonParams ? { reasonParams: item.reasonParams } : {}),
        at: this.opts.now(),
      },
    ].slice(-this.opts.maxFailed)
    this.persist()
    this.notify()
  }

  /** Forgets a failed item (after the user copied it, or decided it does not matter). */
  discard(id: number): void {
    const before = this.failedItems.length
    this.failedItems = this.failedItems.filter((item) => item.id !== id)
    if (this.failedItems.length !== before) {
      this.persist()
      this.notify()
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.listeners.clear()
  }

  private fail(batch: QueueBatch, op: WriteOp, reason: string): void {
    batch.issues.push(`${op.notePath}: ${reason}`)
    this.failedItems = [
      ...this.failedItems,
      {
        id: ++this.seq,
        ...(batch.session ? { session: batch.session } : {}),
        label: batch.label,
        notePath: op.notePath,
        content: opText(op),
        reason,
        at: this.opts.now(),
      },
    ].slice(-this.opts.maxFailed)
  }

  private scheduleRetry(): void {
    const delay = Math.min(this.opts.baseDelayMs * 2 ** (this.failures - 1), this.opts.maxDelayMs)
    this.nextRetryAt = this.opts.now() + delay
    this.timer = setTimeout(() => {
      this.timer = null
      this.nextRetryAt = null
      void this.flush()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.nextRetryAt = null
  }

  private persist(): void {
    if (!this.opts.storageKey) return
    try {
      const stored: Stored = {
        batches: this.batches,
        failed: this.failedItems,
        dropped: this.droppedCount,
      }
      if (this.batches.length || this.failedItems.length || this.droppedCount)
        localStorage.setItem(this.opts.storageKey, JSON.stringify(stored))
      else localStorage.removeItem(this.opts.storageKey)
    } catch {
      // Entries stay in memory for this run.
    }
  }

  private restore(): void {
    if (!this.opts.storageKey) return
    try {
      const raw = localStorage.getItem(this.opts.storageKey)
      const parsed = (raw ? JSON.parse(raw) : null) as Partial<Stored> | null
      if (!parsed || typeof parsed !== 'object') return
      this.batches = (Array.isArray(parsed.batches) ? parsed.batches : []).filter(
        (b): b is QueueBatch =>
          Boolean(b) && Array.isArray(b.ops) && typeof b.next === 'number' && Array.isArray(b.done),
      )
      this.failedItems = (Array.isArray(parsed.failed) ? parsed.failed : []).filter(
        (f): f is FailedItem =>
          Boolean(f) && typeof f.notePath === 'string' && typeof f.content === 'string',
      )
      this.droppedCount = typeof parsed.dropped === 'number' ? parsed.dropped : 0
      this.seq = [...this.batches, ...this.failedItems].reduce(
        (max, item) => Math.max(max, Number(item.id) || 0),
        0,
      )
    } catch {
      this.batches = []
    }
  }

  private notify(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
