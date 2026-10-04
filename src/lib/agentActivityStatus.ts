/**
 * Silence that ends a turn. Agent CLIs redraw their status line while they
 * think, so any real work keeps producing output well inside this window; a gap
 * this long means the agent stopped and is waiting on the user.
 */
export const AGENT_SETTLE_MS = 2_000

/**
 * How long output must span for the turn to be worth flagging.
 *
 * Reattaching a pane makes the agent redraw its whole interface — a single burst
 * measured in milliseconds — and that was enough to badge every agent that was
 * not in focus the moment the app opened. A turn the user should be told about
 * takes seconds of output, so the span separates the two cleanly.
 */
export const MIN_TURN_MS = 3_000

export type ActivitySettler = {
  /** Call on every chunk the agent's PTY produces. */
  pulse: () => void
  dispose: () => void
}

/**
 * Turns raw PTY output into a working/waiting status.
 *
 * The previous indicator was driven by the completion monitor, which only armed
 * once the user pressed Enter in that pane and then ignored all output until the
 * next prompt. A resumed session, a hook, or an agent still working after a tool
 * call therefore showed no activity at all, and a pause longer than the
 * monitor's idle timeout ended the turn for good. Watching the output itself
 * covers every case, background panes included.
 *
 * On settling, `workedMs` reports how long the output actually spanned — from
 * the first chunk of the turn to the last, excluding the silence that ended it.
 */
export function createActivitySettler(
  onChange: (status: 'working' | 'waiting', workedMs: number) => void,
  settleMs: number = AGENT_SETTLE_MS,
): ActivitySettler {
  let timer: number | null = null
  let working = false
  let disposed = false
  let startedAt = 0
  let lastPulseAt = 0

  const clear = () => {
    if (timer === null) return
    window.clearTimeout(timer)
    timer = null
  }

  return {
    pulse: () => {
      if (disposed) return
      const now = Date.now()
      if (!working) {
        working = true
        startedAt = now
        onChange('working', 0)
      }
      lastPulseAt = now
      clear()
      timer = window.setTimeout(() => {
        timer = null
        working = false
        onChange('waiting', lastPulseAt - startedAt)
      }, settleMs)
    },
    dispose: () => {
      disposed = true
      clear()
    },
  }
}
