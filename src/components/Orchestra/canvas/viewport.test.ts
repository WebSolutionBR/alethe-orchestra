import { describe, expect, it } from 'vitest'

import {
  centerAt,
  constrainView,
  fitView,
  snap,
  wheelPixels,
  wheelZoomFactor,
  zoomAt,
} from './viewport'

describe('fitView', () => {
  it('scales down and centers content larger than the viewport', () => {
    const view = fitView({ w: 2000, h: 500 }, { w: 1000, h: 800 }, 0, 0.1, 1)
    expect(view.k).toBe(0.5)
    expect(view.x).toBe(0)
    expect(view.y).toBe((800 - 250) / 2)
  })

  it('never upscales past maxK and centers small content', () => {
    const view = fitView({ w: 200, h: 100 }, { w: 1000, h: 800 }, 20, 0.1, 1)
    expect(view).toEqual({ x: 400, y: 350, k: 1 })
  })

  it('respects padding and the minimum zoom', () => {
    expect(fitView({ w: 1000, h: 1000 }, { w: 540, h: 540 }, 20, 0.1, 1).k).toBe(0.5)
    expect(fitView({ w: 100000, h: 100 }, { w: 500, h: 500 }, 0, 0.25, 1).k).toBe(0.25)
  })

  it('falls back to identity before anything is measured', () => {
    expect(fitView({ w: 0, h: 0 }, { w: 800, h: 600 }, 0, 0.1, 1)).toEqual({ x: 0, y: 0, k: 1 })
    expect(fitView({ w: 100, h: 100 }, { w: 0, h: 0 }, 0, 0.1, 1)).toEqual({ x: 0, y: 0, k: 1 })
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const view = { x: 10, y: 20, k: 1 }
    const next = zoomAt(view, 2, 110, 120, 0.1, 4)
    expect(next.k).toBe(2)
    // World point under (110, 120) was (100, 100); it must still map to (110, 120).
    expect(100 * next.k + next.x).toBe(110)
    expect(100 * next.k + next.y).toBe(120)
  })

  it('clamps to the zoom range and returns the same view at the limit', () => {
    const view = { x: 0, y: 0, k: 4 }
    expect(zoomAt(view, 2, 0, 0, 0.1, 4)).toBe(view)
    expect(zoomAt({ x: 0, y: 0, k: 0.2 }, 0.1, 0, 0, 0.1, 4).k).toBe(0.1)
  })
})

describe('constrainView', () => {
  it('keeps part of the content on screen', () => {
    const content = { w: 1000, h: 1000 }
    const viewport = { w: 500, h: 500 }
    expect(constrainView({ x: -5000, y: 9000, k: 1 }, content, viewport, 40)).toEqual({
      x: -960,
      y: 460,
      k: 1,
    })
  })
})

describe('helpers', () => {
  it('centers at a given zoom', () => {
    expect(centerAt({ w: 100, h: 50 }, { w: 300, h: 150 }, 1)).toEqual({ x: 100, y: 50, k: 1 })
  })

  it('normalizes wheel deltas and maps them to a zoom factor', () => {
    expect(wheelPixels(3, 1, 800)).toBe(48)
    expect(wheelPixels(1, 2, 800)).toBe(800)
    expect(wheelPixels(-7, 0, 800)).toBe(-7)
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
    expect(wheelZoomFactor(10000)).toBe(wheelZoomFactor(120))
  })

  it('snaps to device pixels', () => {
    expect(snap(10.3, 1)).toBe(10)
    expect(snap(10.3, 2)).toBe(10.5)
    expect(snap(10.3, 0)).toBe(10)
  })
})
