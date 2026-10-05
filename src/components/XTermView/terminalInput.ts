type WheelLike = {
  deltaMode: number
  deltaY: number
  deltaX?: number
  shiftKey?: boolean
}

const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const PAGE_SCROLL_LINES = 10
export function getTerminalScrollbackRows(options?: {
  agent?: boolean
  memoryBudgetMb?: number
}): number {
  if (!options) return 10_000
  const budget = options.memoryBudgetMb ?? 1536
  if (budget <= 1536) return options.agent ? 6_000 : 3_000
  if (budget <= 3072) return options.agent ? 8_000 : 5_000
  return options.agent ? 10_000 : 6_000
}

/** xterm's mouse tracking mode (`terminal.modes.mouseTrackingMode`). */
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

/**
 * Whether a wheel event scrolls this view's own history instead of reaching the
 * program, the way Windows Terminal and VS Code route it.
 *
 * A program that tracks the mouse (claude/codex full screen) gets the wheel as
 * mouse reports, and one in the alternate screen without tracking gets it as
 * arrow keys — xterm sends both when the event is left alone. X10 tracking only
 * reports button presses, so the wheel behaves as if nothing tracked it.
 * Shift+wheel always scrolls the history: the way out when a program holds it.
 */
export function shouldScrollHostScrollback(
  bufferType: 'normal' | 'alternate',
  shiftKey: boolean,
  mouseTracking: MouseTrackingMode = 'none',
): boolean {
  if (shiftKey) return true
  if (mouseTracking !== 'none' && mouseTracking !== 'x10') return false
  return bufferType !== 'alternate'
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r')
}

/**
 * Formats dropped or pasted file paths for a shell prompt: space-separated,
 * quoted when they contain whitespace, with a trailing space so whatever is
 * typed next does not run into the last path.
 */
export function formatDroppedPaths(paths: string[]): string {
  const formatted = paths
    .filter(Boolean)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p))
    .join(' ')
  return formatted ? `${formatted} ` : ''
}

export function getWheelScrollLines(event: WheelLike, lineHeight: number): number {
  // Windows turns Shift+wheel into a sideways scroll (deltaX, no deltaY); Shift+wheel is how a
  // terminal's history is scrolled past a program that holds the wheel, so it counts as vertical.
  const delta = event.deltaY !== 0 ? event.deltaY : event.shiftKey ? (event.deltaX ?? 0) : 0
  if (delta === 0) return 0

  if (event.deltaMode === DOM_DELTA_LINE) {
    return Math.trunc(delta)
  }

  if (event.deltaMode !== DOM_DELTA_PIXEL) {
    return Math.sign(delta) * PAGE_SCROLL_LINES
  }

  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18
  const lines = Math.ceil(Math.abs(delta) / safeLineHeight)
  return Math.sign(delta) * Math.max(1, lines)
}
