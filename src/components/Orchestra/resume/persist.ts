/**
 * Keeps one manifest per running orchestration in app data, so closing the app (or a crash)
 * leaves enough behind to read the session again and resume it. Writes are debounced and only
 * happen when a session's manifest changed; a session that stops loses its manifest.
 */
import type { OrchestraSession } from '../../../stores/orchestraStore'
import { manifestOf, type OrchestraManifest } from './manifest'

type SessionsState = { sessions: Record<string, OrchestraSession> }

export type ManifestDeps = {
  getState: () => SessionsState
  subscribe: (listener: (state: SessionsState, previous: SessionsState) => void) => () => void
  save: (sessionId: string, manifest: OrchestraManifest) => Promise<void>
  remove: (sessionId: string) => Promise<void>
  delayMs?: number
  now?: () => number
}

/** Quiet time after a change before the manifests are written. */
export const MANIFEST_DELAY_MS = 1500

/** Sessions whose agents still run; one the user stopped stays on screen but is over. */
const runningSessions = (state: SessionsState) =>
  Object.values(state.sessions).filter((session) => !session.stoppedAt)

type Persistence = {
  flush: () => Promise<void>
  /** Running sessions, and how many of them have no usable manifest (their last save failed). */
  closing: () => { count: number; lost: number }
  dispose: () => void
}

let current: Persistence | null = null

/**
 * Starts following the store: changed sessions get their manifest written after a quiet
 * moment, stopped ones lose theirs. Manifests of sessions this run never had (orchestrations
 * interrupted earlier) are left alone. Returns the function that stops it.
 */
export function installManifests(deps: ManifestDeps): () => void {
  current?.dispose()
  const delay = deps.delayMs ?? MANIFEST_DELAY_MS
  const now = deps.now ?? Date.now
  /** Each saved session's manifest as written (with `savedAt` 0), to skip unchanged ones. */
  const written = new Map<string, string>()
  /** Sessions whose last save failed: per session, so one failure never hides behind another's success. */
  const failed = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  // Passes run one after another, so a session's removal never races its last save.
  let pass: Promise<void> = Promise.resolve()

  const sync = async () => {
    const sessions = runningSessions(deps.getState())
    const running = new Set(sessions.map((session) => session.id))
    const jobs: Promise<void>[] = []
    for (const session of sessions) {
      const body = JSON.stringify(manifestOf(session, 0))
      if (written.get(session.id) === body) continue
      jobs.push(
        deps.save(session.id, manifestOf(session, now())).then(
          () => {
            written.set(session.id, body)
            failed.delete(session.id)
          },
          (error: unknown) => {
            failed.add(session.id)
            console.warn('[orchestra] could not save the session manifest', error)
          },
        ),
      )
    }
    for (const id of [...failed]) if (!running.has(id)) failed.delete(id)
    for (const id of [...written.keys()]) {
      if (running.has(id)) continue
      written.delete(id)
      jobs.push(
        deps.remove(id).catch((error: unknown) => {
          console.warn('[orchestra] could not remove the session manifest', error)
        }),
      )
    }
    await Promise.all(jobs)
  }

  const run = () => {
    pass = pass.then(sync, sync)
    return pass
  }

  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void run()
    }, delay)
  }

  const unsubscribe = deps.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) schedule()
  })
  if (runningSessions(deps.getState()).length > 0) schedule()

  const persistence: Persistence = {
    flush: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      return run()
    },
    closing: () => {
      const sessions = runningSessions(deps.getState())
      return {
        count: sessions.length,
        lost: sessions.filter((session) => failed.has(session.id)).length,
      }
    },
    dispose: () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (current === persistence) current = null
    },
  }
  current = persistence
  return persistence.dispose
}

/** Writes what is pending now (the app is closing), waiting at most `timeoutMs`. */
export async function flushManifests(timeoutMs = 1500): Promise<void> {
  if (!current) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    current.flush().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
}

/**
 * Orchestrations a close would cut short, and how many of them cannot be resumed because their
 * manifest could not be saved; the others can (a pending save is flushed before closing).
 */
export function closingOrchestrations(): { count: number; lost: number } {
  return current ? current.closing() : { count: 0, lost: 0 }
}
