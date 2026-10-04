/** Where the container of a freshly created terminal belongs. */
export type TerminalPlacement = 'existingContainer' | 'appendToActiveTab' | 'ownTab'

/**
 * Decides where a new terminal goes.
 *
 * Every created terminal used to be pushed into the active workspace tab, even
 * when it belonged to a project that was not there — so creating a project or a
 * group opened the new session right next to the previous one. A project with
 * no container in the active tab now gets its own tab instead; the earlier
 * session stays alive in the tab it already had.
 *
 * Appending is still right in two cases: when the project already has a
 * container in the tab (the pane joins it), and in flat mode, where mixing
 * panes from different projects is the whole point.
 */
export function resolveTerminalPlacement({
  projectHasContainer,
  hasActiveTab,
  workspaceFlat,
}: {
  projectHasContainer: boolean
  hasActiveTab: boolean
  workspaceFlat: boolean
}): TerminalPlacement {
  if (projectHasContainer) return 'existingContainer'
  if (!hasActiveTab) return 'ownTab'
  return workspaceFlat ? 'appendToActiveTab' : 'ownTab'
}
