/**
 * Which orchestration the view shows for a project. Pure and type-only on the store, so the store
 * can use it too without an import cycle.
 */
import type { OrchestraState } from '../../stores/orchestraStore'

type Recency = Pick<OrchestraState, 'sessions' | 'recent'>

/** The project's most recently focused running orchestration, or null when it has none. */
export function latestSessionOf(state: Recency, projectId: string | null): string | null {
  return state.recent.find((id) => state.sessions[id]?.projectId === projectId) ?? null
}

/**
 * What the view shows when it opens or the sidebar picks another project: that project's most
 * recently focused orchestration, or its start screen (null), never another project's session.
 * Without a project in the sidebar it keeps what it shows (undefined).
 */
export function sessionForProject(
  state: Recency,
  projectId: string | null,
): string | null | undefined {
  return projectId ? latestSessionOf(state, projectId) : undefined
}
