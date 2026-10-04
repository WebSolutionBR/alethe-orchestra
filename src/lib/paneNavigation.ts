/** A pane as it is laid out on screen, in viewport coordinates. */
export type PaneRect = {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/** Tolerance for panes that share a border and round to fractional pixels. */
const EDGE_SLACK = 2

type Axis = {
  /** Distance from the active pane towards the candidate, positive when ahead. */
  gap: (active: PaneRect, candidate: PaneRect) => number
  /** How much the two panes share of the perpendicular axis. */
  overlap: (active: PaneRect, candidate: PaneRect) => number
  /** Distance between centres on the perpendicular axis. */
  drift: (active: PaneRect, candidate: PaneRect) => number
}

const span = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  Math.min(aEnd, bEnd) - Math.max(aStart, bStart)

const centre = (start: number, end: number) => (start + end) / 2

const AXES: Record<PaneDirection, Axis> = {
  right: {
    gap: (a, c) => c.left - a.right,
    overlap: (a, c) => span(a.top, a.bottom, c.top, c.bottom),
    drift: (a, c) => Math.abs(centre(a.top, a.bottom) - centre(c.top, c.bottom)),
  },
  left: {
    gap: (a, c) => a.left - c.right,
    overlap: (a, c) => span(a.top, a.bottom, c.top, c.bottom),
    drift: (a, c) => Math.abs(centre(a.top, a.bottom) - centre(c.top, c.bottom)),
  },
  down: {
    gap: (a, c) => c.top - a.bottom,
    overlap: (a, c) => span(a.left, a.right, c.left, c.right),
    drift: (a, c) => Math.abs(centre(a.left, a.right) - centre(c.left, c.right)),
  },
  up: {
    gap: (a, c) => a.top - c.bottom,
    overlap: (a, c) => span(a.left, a.right, c.left, c.right),
    drift: (a, c) => Math.abs(centre(a.left, a.right) - centre(c.left, c.right)),
  },
}

/**
 * Picks the pane a directional move should land on, the way Windows Terminal
 * does it: the neighbour is chosen by where the panes actually sit on screen,
 * and a move with nothing on that side does nothing rather than wrapping around.
 *
 * Panes that share the band perpendicular to the move win over panes that only
 * sit vaguely in that direction — with two stacked panes to the right, the one
 * covering more of the current pane's height is the neighbour. Reading the
 * rectangles off the rendered panes keeps this correct in every layout mode,
 * including flat, without re-deriving the grid maths.
 */
export function pickNeighborPane(
  rects: PaneRect[],
  activeId: string,
  direction: PaneDirection,
): string | null {
  const active = rects.find((rect) => rect.id === activeId)
  if (!active) return null

  const axis = AXES[direction]
  const ahead = rects.filter(
    (rect) => rect.id !== activeId && axis.gap(active, rect) >= -EDGE_SLACK,
  )
  if (ahead.length === 0) return null

  const overlapping = ahead.filter((rect) => axis.overlap(active, rect) > 0)
  const pool = overlapping.length > 0 ? overlapping : ahead

  let best = pool[0]
  for (const candidate of pool.slice(1)) {
    const gapDelta = axis.gap(active, candidate) - axis.gap(active, best)
    if (gapDelta < -EDGE_SLACK) {
      best = candidate
      continue
    }
    if (gapDelta > EDGE_SLACK) continue
    // Same distance ahead: take the one sharing more of the perpendicular band,
    // and fall back to the closest centre when neither shares any.
    const overlapDelta = axis.overlap(active, candidate) - axis.overlap(active, best)
    if (overlapDelta > 0) best = candidate
    else if (overlapDelta === 0 && axis.drift(active, candidate) < axis.drift(active, best)) {
      best = candidate
    }
  }
  return best.id
}

/** Reads the laid-out panes from the DOM, newest geometry included. */
export function readPaneRects(root: ParentNode = document): PaneRect[] {
  const nodes = root.querySelectorAll<HTMLElement>('[data-pane-id]')
  const rects: PaneRect[] = []
  for (const node of nodes) {
    const id = node.dataset.paneId
    if (!id) continue
    const box = node.getBoundingClientRect()
    // A pane in a background workspace tab is mounted but has no box.
    if (box.width <= 0 || box.height <= 0) continue
    rects.push({ id, left: box.left, top: box.top, right: box.right, bottom: box.bottom })
  }
  return rects
}
