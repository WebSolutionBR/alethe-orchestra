/**
 * Last geometry each PTY was told to use, kept in memory and keyed by PTY id.
 *
 * Restarting a terminal respawns the shell from scratch, and the process draws
 * its first frame against whatever size it is handed. Handing it a default
 * 80x24 inside a window that is 230 columns wide makes agent TUIs wrap their
 * banner at 80, then reflow when the real size arrives a few frames later —
 * which is what leaves dense TUIs looking scrambled. The XTerm session records
 * the size it fits to here, so a restart can respawn at the size the pane
 * actually has instead of guessing.
 */
export type TerminalSize = { cols: number; rows: number }

const sizes = new Map<string, TerminalSize>()

/** Records the geometry a PTY was resized to. Non-positive values are ignored. */
export function rememberTerminalSize(id: string, cols: number, rows: number): void {
  if (!id) return
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
  if (cols <= 0 || rows <= 0) return
  sizes.set(id, { cols: Math.floor(cols), rows: Math.floor(rows) })
}

/** The last known geometry of a PTY, or null when it never reported one. */
export function getTerminalSize(id: string): TerminalSize | null {
  return sizes.get(id) ?? null
}

/** Drops a PTY's geometry once its terminal is gone for good. */
export function forgetTerminalSize(id: string): void {
  sizes.delete(id)
}

/** Test seam: empties the registry. */
export function clearTerminalSizes(): void {
  sizes.clear()
}
