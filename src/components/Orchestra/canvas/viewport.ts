/** Pure pan/zoom math shared by the Orchestra canvases. Screen = world * k + (x, y). */

export type View = { x: number; y: number; k: number }
export type Size = { w: number; h: number }

export const ZOOM_STEP = 1.2

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Scale and center the content inside the viewport, never upscaling past `maxK`. */
export function fitView(
  content: Size,
  viewport: Size,
  pad: number,
  minK: number,
  maxK: number,
): View {
  if (content.w <= 0 || content.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return { x: 0, y: 0, k: 1 }
  }
  const availW = Math.max(1, viewport.w - pad * 2)
  const availH = Math.max(1, viewport.h - pad * 2)
  const k = clamp(Math.min(availW / content.w, availH / content.h), minK, maxK)
  return centerAt(content, viewport, k)
}

/** Content centered in the viewport at a given zoom. */
export function centerAt(content: Size, viewport: Size, k: number): View {
  return {
    x: (viewport.w - content.w * k) / 2,
    y: (viewport.h - content.h * k) / 2,
    k,
  }
}

/** Zoom by `factor` keeping the screen point (px, py) fixed over the same world point. */
export function zoomAt(
  view: View,
  factor: number,
  px: number,
  py: number,
  minK: number,
  maxK: number,
): View {
  const k = clamp(view.k * factor, minK, maxK)
  if (k === view.k) return view
  const ratio = k / view.k
  return { x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio, k }
}

/** Keeps at least `margin` px of the content on screen so a pan can never lose the graph. */
export function constrainView(view: View, content: Size, viewport: Size, margin: number): View {
  const w = content.w * view.k
  const h = content.h * view.k
  const mx = Math.min(margin, w)
  const my = Math.min(margin, h)
  return {
    k: view.k,
    x: clamp(view.x, mx - w, viewport.w - mx),
    y: clamp(view.y, my - h, viewport.h - my),
  }
}

/** Wheel delta in pixels, whatever the device reports (pixels, lines or pages). */
export function wheelPixels(delta: number, mode: number, pageSize: number): number {
  if (mode === 1) return delta * 16
  if (mode === 2) return delta * pageSize
  return delta
}

/** Zoom factor for a Ctrl+wheel delta in pixels; trackpad pinches send small deltas. */
export function wheelZoomFactor(deltaPx: number): number {
  return Math.exp(-clamp(deltaPx, -120, 120) * 0.0022)
}

/** Rounds a translation to whole device pixels so text stays crisp on any DPI. */
export function snap(value: number, dpr: number): number {
  const ratio = dpr > 0 ? dpr : 1
  return Math.round(value * ratio) / ratio
}
