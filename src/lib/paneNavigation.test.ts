import { describe, expect, it } from 'vitest'

import { pickNeighborPane, type PaneRect } from './paneNavigation'

/** 2x2 grid of 100x100 panes: A B on top, C D below. */
const GRID: PaneRect[] = [
  { id: 'A', left: 0, top: 0, right: 100, bottom: 100 },
  { id: 'B', left: 100, top: 0, right: 200, bottom: 100 },
  { id: 'C', left: 0, top: 100, right: 100, bottom: 200 },
  { id: 'D', left: 100, top: 100, right: 200, bottom: 200 },
]

describe('pickNeighborPane', () => {
  it('walks a 2x2 grid the way the screen looks', () => {
    expect(pickNeighborPane(GRID, 'A', 'right')).toBe('B')
    expect(pickNeighborPane(GRID, 'A', 'down')).toBe('C')
    expect(pickNeighborPane(GRID, 'B', 'left')).toBe('A')
    expect(pickNeighborPane(GRID, 'B', 'down')).toBe('D')
    expect(pickNeighborPane(GRID, 'D', 'up')).toBe('B')
    expect(pickNeighborPane(GRID, 'D', 'left')).toBe('C')
  })

  it('stops at the edge instead of wrapping around, like Windows Terminal', () => {
    expect(pickNeighborPane(GRID, 'A', 'up')).toBeNull()
    expect(pickNeighborPane(GRID, 'A', 'left')).toBeNull()
    expect(pickNeighborPane(GRID, 'D', 'right')).toBeNull()
    expect(pickNeighborPane(GRID, 'D', 'down')).toBeNull()
  })

  it('prefers the nearest pane on that side', () => {
    const rects: PaneRect[] = [
      { id: 'A', left: 0, top: 0, right: 100, bottom: 100 },
      { id: 'near', left: 100, top: 0, right: 200, bottom: 100 },
      { id: 'far', left: 300, top: 0, right: 400, bottom: 100 },
    ]
    expect(pickNeighborPane(rects, 'A', 'right')).toBe('near')
  })

  it('picks the overlapping neighbour when one pane faces two stacked ones', () => {
    // A tall pane on the left, two stacked on the right. Coming from the tall
    // one, the neighbour is whichever shares more of the vertical band.
    const rects: PaneRect[] = [
      { id: 'tall', left: 0, top: 0, right: 100, bottom: 200 },
      { id: 'topRight', left: 100, top: 0, right: 200, bottom: 60 },
      { id: 'bottomRight', left: 100, top: 60, right: 200, bottom: 200 },
    ]
    expect(pickNeighborPane(rects, 'tall', 'right')).toBe('bottomRight')
    expect(pickNeighborPane(rects, 'topRight', 'left')).toBe('tall')
    expect(pickNeighborPane(rects, 'topRight', 'down')).toBe('bottomRight')
  })

  it('falls back to the closest pane when nothing overlaps on the other axis', () => {
    const rects: PaneRect[] = [
      { id: 'A', left: 0, top: 0, right: 100, bottom: 100 },
      { id: 'offset', left: 200, top: 300, right: 300, bottom: 400 },
    ]
    expect(pickNeighborPane(rects, 'A', 'right')).toBe('offset')
  })

  it('returns null with a single pane or an unknown active id', () => {
    expect(pickNeighborPane([GRID[0]], 'A', 'right')).toBeNull()
    expect(pickNeighborPane(GRID, 'missing', 'right')).toBeNull()
    expect(pickNeighborPane([], 'A', 'right')).toBeNull()
  })
})
