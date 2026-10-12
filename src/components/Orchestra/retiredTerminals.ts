import { useSyncExternalStore } from 'react'

/**
 * Terminals an agent ran before a Restart, oldest first. Their mirrors are kept (read-only
 * transcripts) until the session is closed, when the store disposes every mirror it created;
 * only the last `MAX_RETIRED` per agent are kept, so a long session does not pile them up.
 */
const retired = new Map<string, readonly string[]>()
/** The retired terminal a host shows instead of the current one, per agent (Restart history). */
const viewing = new Map<string, string>()
const listeners = new Set<() => void>()
const NONE: readonly string[] = []

/** Earlier terminals kept per agent; Export transcript is how older ones are saved. */
export const MAX_RETIRED = 2

const keyOf = (sessionId: string, agentId: string) => `${sessionId} ${agentId}`

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * The agent left this PTY for a new one (Restart); its transcript stays readable. Returns the
 * older PTYs that fell out of the history: the caller disposes their mirrors.
 */
export function retirePty(sessionId: string, agentId: string, ptyId: string): string[] {
  const key = keyOf(sessionId, agentId)
  const list = retired.get(key) ?? NONE
  if (list.includes(ptyId)) return []
  const next = [...list, ptyId]
  const dropped = next.splice(0, Math.max(0, next.length - MAX_RETIRED))
  retired.set(key, next)
  // The new terminal is what the user wants to see after a Restart.
  viewing.delete(key)
  notify()
  return dropped
}

export function retiredPtys(sessionId: string, agentId: string): readonly string[] {
  return retired.get(keyOf(sessionId, agentId)) ?? NONE
}

/** The session was closed: its mirrors are gone, and so are the entries. */
export function forgetRetired(sessionId: string): void {
  const prefix = `${sessionId} `
  let changed = false
  for (const map of [retired, viewing]) {
    for (const key of [...map.keys()]) {
      if (key.startsWith(prefix)) {
        map.delete(key)
        changed = true
      }
    }
  }
  if (changed) notify()
}

/** Shows one of the agent's retired terminals in its hosts (null: back to the current one). */
export function viewRetired(sessionId: string, agentId: string, ptyId: string | null): void {
  const key = keyOf(sessionId, agentId)
  if ((viewing.get(key) ?? null) === ptyId) return
  if (ptyId && retired.get(key)?.includes(ptyId)) viewing.set(key, ptyId)
  else viewing.delete(key)
  notify()
}

/** The retired terminal the agent's hosts show, or null for the current one. */
export function viewedRetired(sessionId: string, agentId: string): string | null {
  return viewing.get(keyOf(sessionId, agentId)) ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRetiredPtys(sessionId: string | null, agentId: string): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? retiredPtys(sessionId, agentId) : NONE),
    () => NONE,
  )
}

export function useViewedRetired(sessionId: string | null, agentId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? viewedRetired(sessionId, agentId) : null),
    () => null,
  )
}
