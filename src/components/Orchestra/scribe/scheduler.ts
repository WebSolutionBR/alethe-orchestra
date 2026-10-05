/**
 * When the scribe's author runs. Requests (a worker finished, the session ended, the owner
 * clicked "write the note now") are coalesced per session with a debounce, so a burst of
 * events makes one run; only one author runs at a time across all sessions, the others wait
 * in line; a request that arrives during a run makes one more run afterwards, never two in
 * parallel. Timers and the clock are injected so tests drive them.
 */
import type { AuthorTriggerKind } from './author'

export type AuthorRequest = {
  sessionId: string
  /** Every trigger merged into this run. */
  triggers: AuthorTriggerKind[]
  /** Workers whose completion is part of this run. */
  finished: string[]
  /** The session is over: this run is its final pass. */
  final: boolean
}

export type ScheduleState =
  | { phase: 'idle' }
  | { phase: 'scheduled'; dueAt: number }
  | { phase: 'queued' }
  | { phase: 'running'; since: number }

export type SchedulerOptions = {
  /** Runs the author; resolves when it is over (true when it wrote, false when it failed). */
  run: (request: AuthorRequest) => Promise<boolean>
  /** Quiet period after a worker finishes, read on every request (it is a setting). */
  debounceMs: () => number
  /** A session never waits longer than this while requests keep coming. */
  maxWaitMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  onChange?: (sessionId: string, state: ScheduleState) => void
}

type Slot = {
  triggers: Set<AuthorTriggerKind>
  finished: Set<string>
  final: boolean
  firstAt: number
  dueAt: number | null
  timer: unknown
  queued: boolean
  running: boolean
  /** A request arrived while running: one more run follows. */
  again: boolean
  runningSince: number
}

/** Triggers that skip the quiet period. */
const IMMEDIATE = new Set<AuthorTriggerKind>(['manual', 'session-end', 'resume'])

export class AuthorScheduler {
  private slots = new Map<string, Slot>()
  private line: string[] = []
  private active: string | null = null
  private disposed = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly maxWaitMs: number

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      opts.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.maxWaitMs = opts.maxWaitMs ?? 10 * 60_000
  }

  private slot(sessionId: string): Slot {
    let slot = this.slots.get(sessionId)
    if (!slot) {
      slot = {
        triggers: new Set(),
        finished: new Set(),
        final: false,
        firstAt: 0,
        dueAt: null,
        timer: null,
        queued: false,
        running: false,
        again: false,
        runningSince: 0,
      }
      this.slots.set(sessionId, slot)
    }
    return slot
  }

  request(
    sessionId: string,
    trigger: AuthorTriggerKind,
    options: { finished?: string[]; final?: boolean } = {},
  ): void {
    if (this.disposed) return
    const slot = this.slot(sessionId)
    const fresh = slot.triggers.size === 0
    slot.triggers.add(trigger)
    for (const agent of options.finished ?? []) slot.finished.add(agent)
    if (options.final) slot.final = true
    if (slot.running) {
      slot.again = true
      return
    }
    if (slot.queued) return
    const now = this.now()
    if (fresh) slot.firstAt = now
    const immediate = [...slot.triggers].some((t) => IMMEDIATE.has(t))
    const delay = immediate
      ? 0
      : Math.max(0, Math.min(this.opts.debounceMs(), slot.firstAt + this.maxWaitMs - now))
    this.arm(sessionId, slot, delay)
  }

  private arm(sessionId: string, slot: Slot, delay: number): void {
    if (slot.timer !== null) this.clearTimer(slot.timer)
    slot.dueAt = this.now() + delay
    slot.timer = this.setTimer(() => {
      slot.timer = null
      slot.dueAt = null
      slot.queued = true
      this.line.push(sessionId)
      this.emit(sessionId)
      this.pump()
    }, delay)
    this.emit(sessionId)
  }

  /** Forgets what a session asked for (it was discarded); a running author finishes alone. */
  cancel(sessionId: string): void {
    const slot = this.slots.get(sessionId)
    if (!slot) return
    if (slot.timer !== null) this.clearTimer(slot.timer)
    this.line = this.line.filter((id) => id !== sessionId)
    if (slot.running) {
      slot.again = false
      return
    }
    this.slots.delete(sessionId)
    this.emit(sessionId)
  }

  state(sessionId: string): ScheduleState {
    const slot = this.slots.get(sessionId)
    if (!slot) return { phase: 'idle' }
    if (slot.running) return { phase: 'running', since: slot.runningSince }
    if (slot.queued) return { phase: 'queued' }
    if (slot.dueAt !== null) return { phase: 'scheduled', dueAt: slot.dueAt }
    return { phase: 'idle' }
  }

  /** Requests not run yet (and the running one), e.g. to resume them after a restart. */
  outstanding(): AuthorRequest[] {
    return [...this.slots.entries()]
      .filter(([, slot]) => slot.triggers.size > 0 || slot.running)
      .map(([sessionId, slot]) => ({
        sessionId,
        triggers: [...slot.triggers],
        finished: [...slot.finished],
        final: slot.final,
      }))
  }

  /** The session being written, if any. */
  running(): string | null {
    return this.active
  }

  dispose(): void {
    this.disposed = true
    for (const slot of this.slots.values()) if (slot.timer !== null) this.clearTimer(slot.timer)
    this.slots.clear()
    this.line = []
  }

  private pump(): void {
    if (this.active !== null || this.disposed) return
    const sessionId = this.line.shift()
    if (sessionId === undefined) return
    const slot = this.slots.get(sessionId)
    if (!slot) return this.pump()
    const request: AuthorRequest = {
      sessionId,
      triggers: [...slot.triggers],
      finished: [...slot.finished],
      final: slot.final,
    }
    slot.triggers.clear()
    slot.finished.clear()
    slot.queued = false
    slot.running = true
    slot.runningSince = this.now()
    this.active = sessionId
    this.emit(sessionId)
    const settle = () => {
      slot.running = false
      this.active = null
      if (this.disposed) return
      if (slot.again && slot.triggers.size > 0) {
        slot.again = false
        // What arrived meanwhile runs after its own quiet period (at once when urgent).
        const immediate = [...slot.triggers].some((t) => IMMEDIATE.has(t))
        slot.firstAt = this.now()
        this.arm(sessionId, slot, immediate ? 0 : this.opts.debounceMs())
      } else {
        slot.again = false
        if (slot.triggers.size === 0) this.slots.delete(sessionId)
        this.emit(sessionId)
      }
      this.pump()
    }
    let result: Promise<boolean>
    try {
      result = this.opts.run(request)
    } catch {
      result = Promise.resolve(false)
    }
    result.then(settle, settle)
  }

  private emit(sessionId: string): void {
    try {
      this.opts.onChange?.(sessionId, this.state(sessionId))
    } catch {
      // The UI listener must not break the schedule.
    }
  }
}
