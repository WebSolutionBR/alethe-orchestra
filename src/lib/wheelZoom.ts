/**
 * A mouse notch reports a `deltaY` of ±100, but a trackpad reports dozens of
 * single-digit deltas for the same gesture. Stepping the zoom on every event
 * would make a trackpad run through the whole range in one swipe, so deltas are
 * summed and only cross into a step once they add up to a notch-sized push.
 */
export const WHEEL_ZOOM_THRESHOLD = 50

/**
 * Returns the zoom direction a wheel event should apply: 1 to zoom in, -1 to
 * zoom out, 0 while the gesture has not added up to a step yet. Scrolling up
 * (a negative `deltaY`) zooms in, matching every other app on the platform.
 */
export function createWheelZoomAccumulator(): (deltaY: number) => number {
  let accumulated = 0
  return (deltaY: number): number => {
    if (!deltaY) return 0
    // A reversal means the user changed their mind — carrying the old delta
    // over would fire a step in the new direction almost immediately.
    if (accumulated !== 0 && Math.sign(deltaY) !== Math.sign(accumulated)) accumulated = 0
    accumulated += deltaY
    if (Math.abs(accumulated) < WHEEL_ZOOM_THRESHOLD) return 0
    const direction = accumulated < 0 ? 1 : -1
    accumulated = 0
    return direction
  }
}
