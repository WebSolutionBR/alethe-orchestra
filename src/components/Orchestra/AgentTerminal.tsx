import { ScrollText, SquareTerminal } from 'lucide-react'
import { memo, useEffect } from 'react'

import { useT } from '../../lib/i18n'
import { getMirror, onMirrorRegistry } from '../../lib/terminalMirror'
import { useProjectsStore } from '../../stores/projectsStore'
import { LiveTerminal } from '../LiveTerminal'
import { XTermView } from '../XTermView'
import styles from './AgentTerminal.module.css'
import { useViewedRetired } from './retiredTerminals'
import { rememberViewSize, type TerminalRole } from './terminalGeometry'
import { AGENT_TERMINAL_ATTR } from './terminalHooks'
import { TERMINAL_MODE_SHORTCUT, useTerminalMode, useTerminalModeStore } from './terminalMode'

/**
 * Remembers the size this view fitted the PTY to, so the next agent of the role is born at it.
 * Every view resizes the PTY through `resizePty`, which keeps the mirror at the same size, so a
 * change of the mirror's size while this view is mounted is this view's own fit.
 */
function useRememberViewSize(ptyId: string, role: TerminalRole, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let unwatch = () => {}
    const watch = () => {
      unwatch()
      unwatch = () => {}
      const mirror = getMirror(ptyId)
      if (!mirror) return
      // The size it has now came from the spawn or from an earlier view.
      let seen = { cols: mirror.cols, rows: mirror.rows }
      unwatch = mirror.onChange(() => {
        if (mirror.cols === seen.cols && mirror.rows === seen.rows) return
        seen = { cols: mirror.cols, rows: mirror.rows }
        rememberViewSize(role, seen.cols, seen.rows)
      })
    }
    watch()
    const unsubscribe = onMirrorRegistry((id) => {
      if (id === ptyId) watch()
    })
    return () => {
      unsubscribe()
      unwatch()
    }
  }, [enabled, ptyId, role])
}

/** Discreet header button that flips the live/classic preference of every Orchestra terminal. */
export function TerminalModeToggle({
  className,
  onToggled,
}: {
  className?: string
  /** Runs after the switch, e.g. to hand the keyboard to the new view. */
  onToggled?: () => void
}) {
  const t = useT()
  const mode = useTerminalMode()
  const label = t(
    mode === 'live' ? 'orchestra.terminals.mode.toClassic' : 'orchestra.terminals.mode.toLive',
    { keys: TERMINAL_MODE_SHORTCUT },
  )
  const Icon = mode === 'live' ? ScrollText : SquareTerminal
  return (
    <button
      type="button"
      className={className}
      data-terminal-mode={mode}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        useTerminalModeStore.getState().toggle()
        onToggled?.()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon size={13} aria-hidden="true" />
    </button>
  )
}

type AgentTerminalProps = {
  ptyId: string
  /** Which remembered spawn size this view keeps up to date. */
  role: TerminalRole
  /**
   * False once the process is gone. The transcript is then read from the mirror, read-only, in
   * either mode (the classic view would spawn a new process for a PTY the backend lost); hosts
   * check `useHasTranscript` first and show their own placeholder when there is none.
   */
  alive: boolean
  cwd: string | null
  /** Takes the keyboard when it mounts (an opened drawer); grid cells leave it where it is. */
  autoFocus?: boolean
  /**
   * The agent this terminal belongs to: when the user picked one of its terminals from before a
   * Restart (AgentControls), that transcript is shown instead, read-only.
   */
  sessionId?: string | null
  agentId?: string
}

/**
 * An agent's terminal in the Orchestra: the live transcript (LiveTerminal, sized to its box) or
 * the classic xterm view, as the user prefers. Only one of them is ever mounted for a PTY, so
 * they never fight over its size. Props are primitives: agent updates do not re-render it.
 */
export const AgentTerminal = memo(function AgentTerminal({
  ptyId,
  role,
  alive,
  cwd,
  autoFocus = false,
  sessionId = null,
  agentId = '',
}: AgentTerminalProps) {
  const mode = useTerminalMode()
  const earlier = useViewedRetired(sessionId, agentId)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  useRememberViewSize(ptyId, role, alive)
  const host = { className: styles.host, [AGENT_TERMINAL_ATTR]: ptyId }

  if (earlier) {
    // A terminal from before a Restart: its process is gone, so only the transcript remains.
    return (
      <div {...host} data-retired-pty={earlier}>
        <LiveTerminal
          key={`retired-${earlier}`}
          ptyId={earlier}
          ownsSize={false}
          readOnly
          className={styles.view}
        />
      </div>
    )
  }

  if (!alive) {
    // The live view itself says the process ended; the header already shows the state.
    return (
      <div {...host}>
        <LiveTerminal
          key="transcript"
          ptyId={ptyId}
          ownsSize={false}
          readOnly
          className={styles.view}
        />
      </div>
    )
  }

  return (
    <div {...host} data-terminal-mode={mode}>
      {mode === 'live' ? (
        <LiveTerminal key="live" ptyId={ptyId} autoFocus={autoFocus} className={styles.view} />
      ) : (
        <XTermView
          key="classic"
          ptyId={ptyId}
          command="claude"
          cwd={cwd}
          terminalTheme={terminalTheme}
        />
      )}
    </div>
  )
})
