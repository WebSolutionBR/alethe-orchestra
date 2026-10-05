/**
 * The Obsidian context of each running session: what the scribe chip lists, what the agent
 * prompts point to and what the session's start note names. `prepareSessionContext` (service)
 * fills it; the scribe clears it when the session ends.
 */
import { create } from 'zustand'

import type { ObsidianContext } from './context'

type ScribeContextState = { bySession: Record<string, ObsidianContext> }

export const useScribeContext = create<ScribeContextState>(() => ({ bySession: {} }))

/** Consultations still running, so the start note can wait for theirs. */
const running = new Map<string, Promise<ObsidianContext>>()

export function sessionContextOf(sessionId: string): ObsidianContext | null {
  return useScribeContext.getState().bySession[sessionId] ?? null
}

/** The context of the chip's session; null outside a session or before it was consulted. */
export function useSessionContext(sessionId: string | null): ObsidianContext | null {
  return useScribeContext((s) => (sessionId ? (s.bySession[sessionId] ?? null) : null))
}

export function setSessionContext(sessionId: string, context: ObsidianContext): void {
  useScribeContext.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: context } }))
}

/** Drops a session's context and returns what it held. */
export function clearSessionContext(sessionId: string): ObsidianContext | null {
  const context = sessionContextOf(sessionId)
  if (!context) return null
  useScribeContext.setState((s) => {
    const bySession = { ...s.bySession }
    delete bySession[sessionId]
    return { bySession }
  })
  return context
}

export function trackSessionContext(sessionId: string, run: Promise<ObsidianContext>): void {
  running.set(sessionId, run)
  const settled = () => {
    if (running.get(sessionId) === run) running.delete(sessionId)
  }
  run.then(settled, settled)
}

/** Settles when the session's consultation is over; null when none is running. */
export function whenContextSettled(sessionId: string): Promise<ObsidianContext> | null {
  return running.get(sessionId) ?? null
}
