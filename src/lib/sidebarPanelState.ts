export type SidebarPanelSize = { inPixels: number }

// A resize that lands while the window is hidden is never a user action: closing the app
// tears the webview down and the panel group emits one last zero-width layout on the way
// out, which would otherwise be saved as "the user collapsed both sidebars".
export function visibilityFromPanelResize(
  layoutReady: boolean,
  userInitiated: boolean,
  windowHidden: boolean,
  size: SidebarPanelSize,
  previous: SidebarPanelSize | undefined,
  currentVisible: boolean,
): boolean | null {
  if (!layoutReady || !userInitiated || windowHidden || !previous) return null
  const nextVisible = size.inPixels >= 1
  return nextVisible === currentVisible ? null : nextVisible
}

export function widthFromPanelResize(
  layoutReady: boolean,
  userInitiated: boolean,
  windowHidden: boolean,
  size: SidebarPanelSize,
  previous: SidebarPanelSize | undefined,
  min: number,
  max: number,
): number | null {
  if (
    !layoutReady ||
    !userInitiated ||
    windowHidden ||
    !previous ||
    size.inPixels < min ||
    Math.abs(size.inPixels - previous.inPixels) < 1
  ) {
    return null
  }
  return Math.max(min, Math.min(max, Math.round(size.inPixels)))
}

export function clampSidebarWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min
  return Math.max(min, Math.min(max, Math.round(width)))
}

export type SidebarGeometryProblem = 'zero-width' | 'below-min' | 'off-window'

/**
 * Tells whether a sidebar that the preference says is visible actually is: present in the
 * layout, at least `min` wide and inside the viewport. One pixel of slack absorbs rounding.
 */
export function sidebarGeometryProblem(
  rect: { left: number; right: number; width: number },
  viewportWidth: number,
  min: number,
): SidebarGeometryProblem | null {
  if (rect.width < 1) return 'zero-width'
  if (rect.right > viewportWidth + 1 || rect.left < -1) return 'off-window'
  if (rect.width < min - 1) return 'below-min'
  return null
}
