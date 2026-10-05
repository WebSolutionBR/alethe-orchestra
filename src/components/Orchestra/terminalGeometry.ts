/**
 * Geometry the Orchestra spawns agent PTYs with. An agent used to start headless at a fixed
 * 120x32 and was then shown at another width, so its first frames were drawn for a box nobody
 * looked at. Now every view that fits an Orchestra terminal (agent drawer, Terminals view cell)
 * records the size it measured, per role, and the next agent of that role is born at it.
 */
export type TerminalSize = { cols: number; rows: number }

/** The orchestrator usually gets a bigger box (its own column) than a worker cell. */
export type TerminalRole = 'orchestrator' | 'worker'

export const TERMINAL_SIZE_KEY = 'orchestra.terminalSize'
/** Used until some Orchestra view has measured a terminal. */
export const DEFAULT_SPAWN_SIZE: TerminalSize = Object.freeze({ cols: 100, rows: 30 })

/** Smaller boxes come from a hidden or collapsing view, never from one the user reads. */
const MIN_COLS = 20
const MIN_ROWS = 5
/** Anything above is a measurement glitch, not a screen. */
const MAX_COLS = 1000
const MAX_ROWS = 500

type Remembered = Partial<Record<TerminalRole, TerminalSize>>

/** A usable integer size, or null when the measurement cannot come from a real view. */
export function validTerminalSize(cols: unknown, rows: unknown): TerminalSize | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') return null
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  const size = { cols: Math.floor(cols), rows: Math.floor(rows) }
  if (size.cols < MIN_COLS || size.rows < MIN_ROWS) return null
  if (size.cols > MAX_COLS || size.rows > MAX_ROWS) return null
  return size
}

function load(): Remembered {
  try {
    const saved = JSON.parse(localStorage.getItem(TERMINAL_SIZE_KEY) ?? 'null') as unknown
    if (!saved || typeof saved !== 'object') return {}
    const out: Remembered = {}
    for (const role of ['orchestrator', 'worker'] as const) {
      const entry = (saved as Record<string, { cols?: unknown; rows?: unknown } | undefined>)[role]
      const size = entry ? validTerminalSize(entry.cols, entry.rows) : null
      if (size) out[role] = size
    }
    return out
  } catch {
    // Unreadable storage just means nothing remembered yet.
    return {}
  }
}

let remembered: Remembered | null = null

function current(): Remembered {
  remembered ??= load()
  return remembered
}

/**
 * Records the size a view fitted an agent's terminal to. Returns true when it changed what is
 * remembered; invalid or unchanged sizes are ignored, so callers may report every frame.
 */
export function rememberViewSize(role: TerminalRole, cols: number, rows: number): boolean {
  const size = validTerminalSize(cols, rows)
  if (!size) return false
  const sizes = current()
  const known = sizes[role]
  if (known && known.cols === size.cols && known.rows === size.rows) return false
  remembered = { ...sizes, [role]: size }
  try {
    localStorage.setItem(TERMINAL_SIZE_KEY, JSON.stringify(remembered))
  } catch {
    // Non-persistent storage keeps the size for this run only.
  }
  return true
}

/**
 * Size to spawn an agent PTY with: the last one a view measured for its role, else the other
 * role's (some view of this screen), else a sane default.
 */
export function spawnTerminalSize(role: TerminalRole): TerminalSize {
  const sizes = current()
  const other: TerminalRole = role === 'orchestrator' ? 'worker' : 'orchestrator'
  const size = sizes[role] ?? sizes[other] ?? DEFAULT_SPAWN_SIZE
  return { cols: size.cols, rows: size.rows }
}

/** Test seam: forgets the in-memory copy so the next read goes back to storage. */
export function resetTerminalGeometryCache(): void {
  remembered = null
}
