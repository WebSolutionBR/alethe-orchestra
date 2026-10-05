import { useEffect, useState, useSyncExternalStore } from 'react'

import { ptyExists } from '../../lib/tauri'
import { getMirror, onMirrorRegistry } from '../../lib/terminalMirror'
import { useSessionFocusGetter } from './sessionContext'
import { isTerminalModeShortcut, useTerminalModeStore } from './terminalMode'

/** Elements that take the keyboard for a terminal: the live view's input, else xterm's. */
const INPUT_SELECTOR = '[data-live-terminal-input], .xterm-helper-textarea'
const TERMINAL_SELECTOR = '[data-live-terminal], .xterm'
/** The wrapper AgentTerminal renders around whichever view is mounted. */
export const AGENT_TERMINAL_ATTR = 'data-agent-terminal'

/** True for events from inside a terminal, whose keys (Esc above all) belong to the agent. */
export function isTerminalElement(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(TERMINAL_SELECTOR))
}

/**
 * Gives the keyboard to the terminal inside `container`. A terminal that is still mounting
 * (xterm opens in an effect) gets a few more frames before giving up.
 */
export function focusTerminalIn(container: Element | null | undefined, frames = 12): void {
  const attempt = (left: number) => {
    if (!container?.isConnected) return
    const input = container.querySelector<HTMLElement>(INPUT_SELECTOR)
    if (input) input.focus({ preventScroll: true })
    else if (left > 0) requestAnimationFrame(() => attempt(left - 1))
  }
  requestAnimationFrame(() => attempt(frames))
}

export type PtyGate = 'checking' | 'alive' | 'gone'

/**
 * Whether a PTY still runs, asked once per PTY. The classic view spawns a fresh process (a
 * stray `claude`) for a PTY the backend does not know, and the live one would take input for a
 * dead process: only a PTY confirmed alive gets an interactive view.
 */
export function usePtyGate(ptyId: string | null): PtyGate {
  const [gate, setGate] = useState<{ ptyId: string; status: PtyGate } | null>(null)
  useEffect(() => {
    if (!ptyId) return
    let cancelled = false
    setGate((current) => (current?.ptyId === ptyId ? current : { ptyId, status: 'checking' }))
    ptyExists(ptyId)
      .then((alive) => {
        if (!cancelled)
          setGate((current) =>
            current?.ptyId === ptyId && current.status === 'alive'
              ? current
              : { ptyId, status: alive ? 'alive' : 'gone' },
          )
      })
      .catch(() => {
        if (!cancelled) setGate({ ptyId, status: 'gone' })
      })
    return () => {
      cancelled = true
    }
  }, [ptyId])
  if (!ptyId) return 'gone'
  return gate?.ptyId === ptyId ? gate.status : 'checking'
}

/** Whether the PTY has a mirror to read: its whole transcript, also after the process ended. */
export function useHasTranscript(ptyId: string | null): boolean {
  return useSyncExternalStore(onMirrorRegistry, () => (ptyId ? getMirror(ptyId) !== null : false))
}

/**
 * Ctrl+Shift+L flips the live/classic preference from anywhere in the focused session pane, also
 * from inside a terminal: caught in the capture phase, so neither view sends ^L to the agent. The
 * terminal that had the keyboard hands it to the view that replaces it.
 */
export function useTerminalModeShortcut(): void {
  const hasFocus = useSessionFocusGetter()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isTerminalModeShortcut(event) || !hasFocus()) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      const host =
        event.target instanceof Element ? event.target.closest(`[${AGENT_TERMINAL_ATTR}]`) : null
      useTerminalModeStore.getState().toggle()
      if (host) focusTerminalIn(host)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hasFocus])
}
