import { getProjectDefaultCwd, resolveTerminalCwd } from '../../../lib/terminalFactory'
import type { Project } from '../../../lib/types'

/** Where the folder an orchestration starts in comes from. */
export type FolderSource = 'chosen' | 'project' | 'inherited'

export type StartFolder = {
  path: string
  source: FolderSource
  /** Name of the group sibling whose terminal folder a project without one inherits. */
  inheritedFrom: string | null
  /** The project's own folder (its default folder or its last terminal's), when it has one. */
  projectPath: string | null
}

/** localStorage key of the folder picked on the start screen for a project. */
export const projectCwdKey = (projectId: string) => `orchestra.projectCwd.${projectId}`

export function readChosenFolder(projectId: string): string | null {
  try {
    return localStorage.getItem(projectCwdKey(projectId))?.trim() || null
  } catch {
    return null
  }
}

export function writeChosenFolder(projectId: string, path: string): void {
  try {
    localStorage.setItem(projectCwdKey(projectId), path)
  } catch {
    // The pick still applies to this screen through the returned state.
  }
}

export function clearChosenFolder(projectId: string): void {
  try {
    localStorage.removeItem(projectCwdKey(projectId))
  } catch {
    // Nothing stored, nothing to clear.
  }
}

/** Folder of a project's most recently used terminal, as `getProjectDefaultCwd` reads it. */
function lastTerminalFolder(project: Project): string {
  const terminals = [...project.terminals].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  for (const terminal of terminals) {
    const cwd = resolveTerminalCwd(terminal)
    if (cwd) return cwd
  }
  return ''
}

/**
 * Folder an orchestration of `project` starts in. A folder picked on the start screen wins over
 * the project's own folder; without either, the workspace rule lends a group sibling's last
 * terminal folder, which is reported as inherited so the screen can say whose it is.
 */
export function resolveStartFolder(
  project: Project,
  projects: Project[],
  chosen: string | null = readChosenFolder(project.id),
): StartFolder | null {
  const own = getProjectDefaultCwd(project, []) || null
  if (chosen) return { path: chosen, source: 'chosen', inheritedFrom: null, projectPath: own }
  if (own) return { path: own, source: 'project', inheritedFrom: null, projectPath: own }
  const lent = getProjectDefaultCwd(project, projects)
  if (!lent) return null
  const sibling = projects.find(
    (p) =>
      p.id !== project.id &&
      Boolean(project.groupId) &&
      p.groupId === project.groupId &&
      lastTerminalFolder(p) === lent,
  )
  return {
    path: lent,
    source: 'inherited',
    inheritedFrom: sibling?.name ?? null,
    projectPath: null,
  }
}

/** Why the Start button is disabled, as an i18n key; null when it can start. */
export type StartBlocker = 'noProjects' | 'noProject' | 'noFolder'

export function startBlocker(input: {
  projectCount: number
  hasProject: boolean
  hasFolder: boolean
}): StartBlocker | null {
  if (input.projectCount === 0) return 'noProjects'
  if (!input.hasProject) return 'noProject'
  if (!input.hasFolder) return 'noFolder'
  return null
}
