import { recordAppEvent } from '../lib/tauri'

/**
 * Every way the right sidebar can be hidden goes through here, so app-events.log always
 * says why it went away. The owner's rule is that it never disappears on its own: the
 * only legitimate reasons are explicit user actions, and anything else shows up as
 * `reason=preferences` (a plain setPreferences call) and points at a caller to fix.
 */
export type RightSidebarHideReason =
  'user.close-button' | 'user.titlebar-toggle' | 'user.shortcut' | 'preferences'

export function traceRightSidebarHide(
  wasVisible: boolean,
  nextVisible: boolean | undefined,
  reason: RightSidebarHideReason,
): void {
  if (!wasVisible || nextVisible !== false) return
  void recordAppEvent('sidebar.right.hidden', `reason=${reason}`)
}

/** Logs a layout that leaves the sidebar on screen in name only (0 px, squeezed, clipped). */
export function traceRightSidebarGeometry(problem: string, details: string): void {
  void recordAppEvent('sidebar.right.geometry', `problem=${problem} ${details}`)
}
