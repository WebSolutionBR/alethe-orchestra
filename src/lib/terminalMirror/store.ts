import type { TerminalMirror } from './types'

/**
 * The registry of live mirrors, kept free of xterm imports so `lib/tauri/pty.ts` can look a mirror
 * up (to resize it) without pulling the emulator into every module that talks to a PTY.
 */
const mirrors = new Map<string, TerminalMirror>()
const listeners = new Set<(ptyId: string) => void>()

function notify(ptyId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(ptyId)
    } catch (error) {
      console.warn('[terminal-mirror] registry listener failed', error)
    }
  }
}

export function getMirror(ptyId: string): TerminalMirror | null {
  return mirrors.get(ptyId) ?? null
}

/** Subscribe to the mirror registry (mirror created/disposed) — for views waiting on a PTY. */
export function onMirrorRegistry(listener: (ptyId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function registerMirror(mirror: TerminalMirror): void {
  mirrors.set(mirror.ptyId, mirror)
  notify(mirror.ptyId)
}

export function unregisterMirror(ptyId: string): void {
  if (!mirrors.delete(ptyId)) return
  notify(ptyId)
}
