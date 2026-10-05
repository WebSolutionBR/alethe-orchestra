/** Grid geometry for the worker panes of the Terminals view. Pure, so it is unit tested. */

export type GridLayout = {
  cols: number
  rows: number
  /** True when the panes cannot all fit at their minimum size and the grid scrolls vertically. */
  scroll: boolean
}

export const PANE_MIN_W = 340
export const PANE_MIN_H = 190
const TARGET_ASPECT = 1.7

/**
 * Picks the column count that gives every pane the most usable, close-to-landscape area inside
 * width x height. When no arrangement keeps panes above the minimum size, it falls back to as
 * many minimum-width columns as fit and lets the rows scroll, instead of shrinking terminals to
 * a few unusable characters.
 */
export function gridLayout(
  count: number,
  width: number,
  height: number,
  gap = 8,
  minW = PANE_MIN_W,
  minH = PANE_MIN_H,
): GridLayout {
  if (count <= 0) return { cols: 1, rows: 1, scroll: false }
  // Before the first measurement keep a sane square-ish layout.
  if (width <= 0 || height <= 0) {
    const cols = Math.ceil(Math.sqrt(count))
    return { cols, rows: Math.ceil(count / cols), scroll: false }
  }

  let best: { cols: number; rows: number; score: number } | null = null
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const paneW = (width - gap * (cols - 1)) / cols
    const paneH = (height - gap * (rows - 1)) / rows
    if (paneW < minW || paneH < minH) continue
    const aspect = paneW / paneH
    const shape = Math.min(aspect / TARGET_ASPECT, TARGET_ASPECT / aspect)
    const filled = count / (cols * rows)
    const score = paneW * paneH * shape * filled
    if (!best || score > best.score) best = { cols, rows, score }
  }
  if (best) return { cols: best.cols, rows: best.rows, scroll: false }

  const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (minW + gap))))
  const rows = Math.ceil(count / cols)
  const fits = rows * minH + gap * (rows - 1) <= height
  return { cols, rows, scroll: !fits }
}

/** Clamps the orchestrator column so neither side collapses below a usable terminal. */
export function clampSplit(width: number, total: number, min = 260, minRest = PANE_MIN_W): number {
  const max = Math.max(min, total - minRest)
  return Math.round(Math.min(max, Math.max(min, width)))
}
