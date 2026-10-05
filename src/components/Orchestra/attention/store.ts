import { create } from 'zustand'

type Notice = { text: string; at: number }

type AttentionState = {
  /** Sessions whose orchestrator is idle and waiting on the user, with what it last said. */
  waiting: Record<string, Notice>
  /** Latest notice per session, read by its status line's live region. */
  last: Record<string, Notice>
}

/** Attention state the service keeps outside the orchestra store. */
export const useAttentionStore = create<AttentionState>(() => ({ waiting: {}, last: {} }))

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
