import { describe, expect, it } from 'vitest'

import { clampSplit, gridLayout } from './terminalsLayout'

describe('gridLayout', () => {
  it('handles empty and unmeasured grids', () => {
    expect(gridLayout(0, 1000, 800)).toEqual({ cols: 1, rows: 1, scroll: false })
    expect(gridLayout(4, 0, 0)).toEqual({ cols: 2, rows: 2, scroll: false })
  })

  it('stacks two panes on a tall narrow area and places them side by side on a wide one', () => {
    expect(gridLayout(2, 700, 900)).toMatchObject({ cols: 1, rows: 2, scroll: false })
    expect(gridLayout(2, 1600, 500)).toMatchObject({ cols: 2, rows: 1, scroll: false })
  })

  it('uses a 2x2 grid for four panes on a landscape area', () => {
    expect(gridLayout(4, 1200, 700)).toMatchObject({ cols: 2, rows: 2, scroll: false })
  })

  it('keeps panes at the minimum size and scrolls when too many workers are running', () => {
    const layout = gridLayout(12, 1000, 500)
    expect(layout.cols).toBe(2)
    expect(layout.rows).toBe(6)
    expect(layout.scroll).toBe(true)
  })

  it('never returns more columns than panes', () => {
    expect(gridLayout(1, 3000, 400).cols).toBe(1)
    expect(gridLayout(2, 100, 100).cols).toBe(1)
  })
})

describe('clampSplit', () => {
  it('keeps both sides usable', () => {
    expect(clampSplit(100, 1400)).toBe(260)
    expect(clampSplit(1300, 1400)).toBe(1060)
    expect(clampSplit(500.4, 1400)).toBe(500)
    expect(clampSplit(500, 300)).toBe(260)
  })
})
