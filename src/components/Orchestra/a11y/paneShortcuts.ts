import type { OrchestraAgent } from '../../../stores/orchestraStore'
import { isOrchestrator, workersOf } from '../shared'

type Chord = Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/**
 * Digit of a Ctrl+Shift+0..9 chord, or null. Reads `code`, not `key`: with Shift held the key is a
 * symbol that depends on the layout (Shift+1 is "!"). Ctrl+1..9 without Shift stays the app's.
 */
export function paneShortcutDigit(e: Chord): number | null {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return null
  const m = /^Digit([0-9])$/.exec(e.code)
  return m ? Number(m[1]) : null
}

/** 0 is the orchestrator; 1 to 9 are the worker panes in the order the grid shows them. */
export function paneForShortcut(agents: OrchestraAgent[], digit: number): string | null {
  if (digit === 0) return agents.find((a) => isOrchestrator(a))?.id ?? null
  return workersOf(agents)[digit - 1]?.id ?? null
}

/** The digit that focuses this agent's pane, or null past the ninth worker. */
export function shortcutForPane(agents: OrchestraAgent[], id: string): number | null {
  if (id === agents.find((a) => isOrchestrator(a))?.id) return 0
  const index = workersOf(agents).findIndex((a) => a.id === id)
  return index >= 0 && index < 9 ? index + 1 : null
}
