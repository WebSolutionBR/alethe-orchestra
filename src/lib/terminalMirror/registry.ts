import type { UnlistenFn } from '@tauri-apps/api/event'

import { attachPty, listenPtyActivity, listenPtyData, listenPtyExit } from '../tauri/pty'
import { Mirror } from './mirror'
import { registerMirror, unregisterMirror } from './store'
import type { MirrorOptions, TerminalMirror } from './types'

type Entry = {
  mirror: Mirror
  ready: Promise<void>
  unlisteners: UnlistenFn[]
  disposed: boolean
}

const entries = new Map<string, Entry>()

/**
 * The backend gates `pty://data` while no view shows the PTY and sends the same text, batched, as
 * `pty://activity`; each chunk goes to exactly one of the two, so the mirror follows both to see the
 * whole stream in order. Exit only flips the `exited` flag.
 */
function subscribe(ptyId: string, entry: Entry): Promise<void> {
  const keep = (unlisten: UnlistenFn) => {
    if (entry.disposed) unlisten()
    else entry.unlisteners.push(unlisten)
  }
  const register = (listen: () => Promise<UnlistenFn>) =>
    Promise.resolve()
      .then(listen)
      .then(keep)
      .catch((error) => console.warn(`[terminal-mirror] ${ptyId}: listen failed`, error))
  return Promise.all([
    register(() => listenPtyData(ptyId, (chunk) => entry.mirror.feed(chunk))),
    register(() => listenPtyActivity(ptyId, (chunk) => entry.mirror.feed(chunk))),
    register(() => listenPtyExit(ptyId, (payload) => entry.mirror.markExited(payload?.reason))),
  ]).then(() => undefined)
}

/** Creates the mirror once (idempotent) and subscribes to pty://data immediately. Call BEFORE spawnPty. */
export function ensureMirror(ptyId: string, opts: MirrorOptions): TerminalMirror {
  const existing = entries.get(ptyId)
  if (existing) return existing.mirror
  const entry: Entry = {
    mirror: new Mirror(ptyId, opts),
    ready: Promise.resolve(),
    unlisteners: [],
    disposed: false,
  }
  entries.set(ptyId, entry)
  entry.ready = subscribe(ptyId, entry)
  registerMirror(entry.mirror)
  return entry.mirror
}

/**
 * Resolves once the mirror's PTY listeners are registered in the backend (or failed to), so a
 * caller can spawn without losing the first bytes. Resolves at once when there is no mirror. Never
 * rejects.
 */
export function whenMirrorReady(ptyId: string): Promise<void> {
  return entries.get(ptyId)?.ready ?? Promise.resolve()
}

/** For PTYs born before their mirror (restored panes): writes the attachPty replay once, best effort. */
export async function seedMirror(ptyId: string): Promise<void> {
  const entry = entries.get(ptyId)
  if (!entry) return
  // Listeners first: whatever streams while the recording is fetched is held, not lost.
  await entry.ready
  if (entry.disposed) return
  await entry.mirror.seed(() => attachPty(ptyId))
}

/** Unsubscribes and frees the buffer. Keeps nothing. */
export function disposeMirror(ptyId: string): void {
  const entry = entries.get(ptyId)
  if (!entry) return
  entry.disposed = true
  entries.delete(ptyId)
  for (const unlisten of entry.unlisteners.splice(0)) {
    try {
      unlisten()
    } catch {
      // The listener is already gone with its webview; nothing left to release.
    }
  }
  entry.mirror.dispose()
  unregisterMirror(ptyId)
}

/**
 * VT text that redraws the mirror's normal buffer (scrollback + screen) with explicit spaces, CRLF
 * and SGR, at the mirror's current width. For XTermView restores: no raw bytes from another width.
 *
 * Also repaints the alternate screen when it is active and restores modes, margins, pen and cursor.
 * Write it into a reset terminal of the mirror's size. It reflects every chunk the PTY listeners
 * have received so far. Null when there is no mirror or it has not received a byte yet.
 */
export function serializeMirror(ptyId: string): string | null {
  return entries.get(ptyId)?.mirror.serialize() ?? null
}

/**
 * Writes text into a mirror as if the PTY had sent it. For tests and local notices; real output
 * arrives through the PTY listeners on its own.
 */
export function feedMirror(ptyId: string, data: string): void {
  entries.get(ptyId)?.mirror.feed(data)
}
