/** Geometry of the resizable panels (buses, lanes, side panels) beside the Orchestra canvases. */

import { clamp } from './viewport'

/** Extent always left to the canvas next to a resizable panel, in px. */
export const CANVAS_MIN = 160

/**
 * Largest size a panel may take out of `room` px: all of it but `reserve` for the canvas, and
 * never more than the panel's content needs. Null when nothing is laid out yet (hidden view).
 */
export function panelLimit(room: number, content = Infinity, reserve = CANVAS_MIN): number | null {
  if (!(room > 0)) return null
  return Math.floor(Math.min(room - reserve, content))
}

/**
 * Size and maximum of a panel: `desired` kept between `min` and the measured `limit`, or the fixed
 * `max` while there is no measurement. The minimum wins when the container has no room left.
 */
export function panelBounds(
  desired: number,
  min: number,
  max: number,
  limit: number | null,
): { size: number; max: number } {
  const hi = Math.max(min, limit ?? max)
  return { size: clamp(desired, min, hi), max: hi }
}

export type HandlePlacement = {
  /** Element the panel shares with the canvas; its size bounds the panel. */
  container: HTMLElement | null
  /** The panel when it sits before the handle (above or left of it); null when the handle leads it. */
  panelBefore: HTMLElement | null
}

/**
 * Where a resize handle sits. Right after a sibling, it resizes that sibling inside their parent.
 * Otherwise it is the leading edge of a bottom or right panel (possibly wrapped), and the container
 * is the parent of the nearest ancestor with a previous sibling: the one that also holds the canvas.
 */
export function handlePlacement(handle: HTMLElement): HandlePlacement {
  const before = handle.previousElementSibling
  if (before instanceof HTMLElement) return { container: handle.parentElement, panelBefore: before }
  let region = handle.parentElement
  while (region && !region.previousElementSibling) region = region.parentElement
  return { container: region?.parentElement ?? null, panelBefore: null }
}
