import { create } from 'zustand'

type Notice = { text: string; at: number }

type AttentionState = {
  /** Sessions whose orchestrator is idle and waiting on the user, with what it last said. */
  waiting: Record<string, Notice>
  /** Latest notice per session, read by its status line's live region. */
  last: Record<string, Notice>
  /**
   * Blocks the user silenced (`<session>:<agent>:<block.at>`): no reminders for them. A new
   * block of the same agent is announced again.
   */
  muted: Record<string, true>
  /**
   * Sign-ins running, by `<session>:<account>` ('' the default account), with the agent whose
   * card started it: the other cards of that account wait instead of starting a second one.
   */
  signingIn: Record<string, string>
}

/** Attention state the service keeps outside the orchestra store. */
export const useAttentionStore = create<AttentionState>(() => ({
  waiting: {},
  last: {},
  muted: {},
  signingIn: {},
}))

export function setWaiting(sessionId: string, notice: Notice | null): void {
  useAttentionStore.setState((s) => {
    if (!notice && !s.waiting[sessionId]) return s
    const waiting = { ...s.waiting }
    if (notice) waiting[sessionId] = notice
    else delete waiting[sessionId]
    return { waiting }
  })
}

export function setLastNotice(sessionId: string, notice: Notice): void {
  useAttentionStore.setState((s) => ({ last: { ...s.last, [sessionId]: notice } }))
}

/** Drops the entries of sessions that no longer exist. */
export function forgetSessions(alive: ReadonlySet<string>): void {
  useAttentionStore.setState((s) => {
    const keep = <T>(map: Record<string, T>) =>
      Object.fromEntries(Object.entries(map).filter(([id]) => alive.has(id)))
    const waiting = keep(s.waiting)
    const last = keep(s.last)
    const same =
      Object.keys(waiting).length === Object.keys(s.waiting).length &&
      Object.keys(last).length === Object.keys(s.last).length
    return same ? s : { waiting, last }
  })
}

export const muteKey = (sessionId: string, agentId: string, blockAt: number) =>
  `${sessionId}:${agentId}:${blockAt}`

/** Silences (or unsilences) the reminders of one block. */
export function setMuted(key: string, muted: boolean): void {
  useAttentionStore.setState((s) => {
    if (Boolean(s.muted[key]) === muted) return s
    const next = { ...s.muted }
    if (muted) next[key] = true
    else delete next[key]
    return { muted: next }
  })
}

export const signInKey = (sessionId: string, accountId: string | null) =>
  `${sessionId}:${accountId ?? ''}`

/** Marks a sign-in of one account as started by `agentId`, or (null) as over. */
export function setSigningIn(key: string, agentId: string | null): void {
  useAttentionStore.setState((s) => {
    if ((s.signingIn[key] ?? null) === agentId) return s
    const next = { ...s.signingIn }
    if (agentId) next[key] = agentId
    else delete next[key]
    return { signingIn: next }
  })
}
