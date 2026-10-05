import { useState } from 'react'

import { panelBounds } from './panelGeometry'

function read(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function write(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // Panel sizes are a convenience only.
  }
}

/**
 * A panel size in px, remembered per view; drive it with `<Splitter>`. `max` only applies until the
 * Splitter has measured the container: from then on the panel may take all of it but a minimum
 * canvas, and shrinks with the window. The remembered size is kept, so it grows back with it too.
 */
export function usePanelSize(storageKey: string, initial: number, min: number, max: number) {
  const [desired, setDesired] = useState(() => read(storageKey) ?? initial)
  const [limit, setLimit] = useState<number | null>(null)
  const bounds = panelBounds(desired, min, max, limit)
  const setSize = (next: number, persist = false) => {
    const value = panelBounds(next, min, max, limit).size
    setDesired(value)
    if (persist) write(storageKey, value)
  }
  return {
    size: bounds.size,
    setSize,
    reset: () => setSize(initial, true),
    min,
    max: bounds.max,
    /** Set by the Splitter: the largest size the container allows (px), or null when unknown. */
    setLimit,
  }
}

export type PanelSize = ReturnType<typeof usePanelSize>
