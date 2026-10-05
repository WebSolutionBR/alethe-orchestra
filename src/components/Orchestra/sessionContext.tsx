/* eslint-disable react-refresh/only-export-components -- the provider and its hooks are one module */
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react'

import {
  type BusMessage,
  type OrchestraAgent,
  type OrchestraSession,
  type OrchestraViewMode,
  type Segment,
  useOrchestraStore,
} from '../../stores/orchestraStore'

export type OrchestraSessionActions = {
  select: (agentId: string | null) => void
  sendTo: (to: string, text: string, from?: string) => Promise<void>
  reopen: (agentId: string, task?: string) => void
  setMode: (mode: OrchestraViewMode) => void
  stop: () => Promise<void>
}

const SessionIdContext = createContext<string | null>(null)

function frozenEmpty<T>(): T[] {
  return Object.freeze([]) as readonly T[] as T[]
}

/**
 * Stand-in for a session that stopped while something still renders it. Frozen and shared,
 * so selectors keep returning the same references instead of looping.
 */
const EMPTY_SESSION: OrchestraSession = Object.freeze({
  id: '',
  projectId: null,
  cwd: null,
  goal: '',
  autonomous: false,
  startedAt: 0,
  mode: 'constellation',
  agents: frozenEmpty<OrchestraAgent>(),
  messages: frozenEmpty<BusMessage>(),
  segments: frozenEmpty<Segment>(),
  selectedId: null,
  error: null,
})

/** Scopes everything below it (views, drawer, shortcuts) to one orchestra session. */
export function OrchestraSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  return <SessionIdContext.Provider value={sessionId}>{children}</SessionIdContext.Provider>
}

export function useSessionId(): string {
  const id = useContext(SessionIdContext)
  if (id === null) throw new Error('useSessionId must be used inside <OrchestraSessionProvider>')
  return id
}

/** Reads the provider's session; wrap selectors that build objects or arrays in `useShallow`. */
export function useSession<T>(selector: (session: OrchestraSession) => T): T {
  const id = useSessionId()
  return useOrchestraStore((state) => selector(state.sessions[id] ?? EMPTY_SESSION))
}

/** Reads the provider's session at call time without subscribing (event handlers, effects). */
export function useSessionGetter(): () => OrchestraSession {
  const id = useSessionId()
  return useCallback(() => useOrchestraStore.getState().sessions[id] ?? EMPTY_SESSION, [id])
}

/** True while the provider's session owns the keyboard: alone on screen, or the focused pane. */
export function useSessionFocused(): boolean {
  const id = useSessionId()
  return useOrchestraStore((state) => state.activeId === id)
}

/** `useSessionFocused` read at call time, for key handlers registered on `window`. */
export function useSessionFocusGetter(): () => boolean {
  const id = useSessionId()
  return useCallback(() => useOrchestraStore.getState().activeId === id, [id])
}

/** The store actions bound to the provider's session; stable while the session id is. */
export function useSessionActions(): OrchestraSessionActions {
  const id = useSessionId()
  return useMemo<OrchestraSessionActions>(() => {
    const store = useOrchestraStore.getState
    return {
      select: (agentId) => store().select(id, agentId),
      sendTo: (to, text, from) => store().sendTo(id, to, text, from),
      reopen: (agentId, task) => store().reopen(id, agentId, task),
      setMode: (mode) => store().setMode(id, mode),
      stop: () => store().stop(id),
    }
  }, [id])
}
