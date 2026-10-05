/**
 * Focus changes the user makes in the Orchestra view (tabs, keys, pane clicks, back, stop). They
 * also make the focused orchestration's project the sidebar's, so both agree; the view follows
 * sidebar changes in the other direction (see `sessionForProject`), and the two settle at once.
 */
import { useOrchestraStore } from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'

/** Makes the focused orchestration's project the sidebar's active project. */
export function syncSidebarProject(): void {
  const { activeId, sessions } = useOrchestraStore.getState()
  const projectId = activeId ? sessions[activeId]?.projectId : null
  const projects = useProjectsStore.getState()
  if (projectId && projects.activeProjectId !== projectId) projects.setActiveProjectOnly(projectId)
}

/** Focuses an orchestration (first, so the sidebar change finds it already focused). */
export function showSession(sessionId: string): void {
  useOrchestraStore.getState().setActive(sessionId)
  syncSidebarProject()
}

/** Stops an orchestration; the sidebar follows the session that takes over, if any. */
export async function stopSession(sessionId: string): Promise<void> {
  await useOrchestraStore.getState().stop(sessionId)
  syncSidebarProject()
}
