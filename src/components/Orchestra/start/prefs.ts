/**
 * Start screen preferences. The autonomous switch is not remembered on purpose: the owner decided
 * (2026-10-04) that the screen always opens with it on; flip this constant to change that.
 */
export const AUTONOMOUS_ON_START = true

/** localStorage key of the unsent goal typed for a project. */
export const goalDraftKey = (projectId: string) => `orchestra.goalDraft.${projectId}`

export function readGoalDraft(projectId: string | null | undefined): string {
  if (!projectId) return ''
  try {
    return localStorage.getItem(goalDraftKey(projectId)) ?? ''
  } catch {
    return ''
  }
}

/** Saves the draft of a project; an empty draft removes the key. */
export function writeGoalDraft(projectId: string | null | undefined, text: string): void {
  if (!projectId) return
  try {
    if (text.trim()) localStorage.setItem(goalDraftKey(projectId), text)
    else localStorage.removeItem(goalDraftKey(projectId))
  } catch {
    // The draft stays on screen; only the restart copy is lost.
  }
}

export function clearGoalDraft(projectId: string | null | undefined): void {
  writeGoalDraft(projectId, '')
}
