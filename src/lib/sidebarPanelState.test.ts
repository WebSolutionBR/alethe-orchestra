import { describe, expect, it } from 'vitest'

import {
  clampSidebarWidth,
  sidebarGeometryProblem,
  visibilityFromPanelResize,
  widthFromPanelResize,
} from './sidebarPanelState'

describe('sidebar panel persistence', () => {
  it('ignores transient collapsed sizes while the startup layout settles', () => {
    expect(
      visibilityFromPanelResize(false, true, false, { inPixels: 0 }, { inPixels: 286 }, true),
    ).toBeNull()
    expect(
      widthFromPanelResize(false, true, false, { inPixels: 220 }, { inPixels: 286 }, 220, 380),
    ).toBeNull()
  })

  it('ignores automatic layout changes after startup', () => {
    expect(
      visibilityFromPanelResize(true, false, false, { inPixels: 0 }, { inPixels: 286 }, true),
    ).toBeNull()
    expect(
      widthFromPanelResize(true, false, false, { inPixels: 220 }, { inPixels: 286 }, 220, 380),
    ).toBeNull()
  })

  it('ignores the zero-width layout emitted while the window is closing', () => {
    expect(
      visibilityFromPanelResize(true, true, true, { inPixels: 0 }, { inPixels: 286 }, true),
    ).toBeNull()
    expect(
      widthFromPanelResize(true, true, true, { inPixels: 240 }, { inPixels: 286 }, 220, 380),
    ).toBeNull()
  })

  it('persists explicit collapse and expand changes after startup', () => {
    expect(
      visibilityFromPanelResize(true, true, false, { inPixels: 0 }, { inPixels: 286 }, true),
    ).toBe(false)
    expect(
      visibilityFromPanelResize(true, true, false, { inPixels: 286 }, { inPixels: 0 }, false),
    ).toBe(true)
  })

  it('persists a user-resized width within panel limits', () => {
    expect(
      widthFromPanelResize(true, true, false, { inPixels: 341.6 }, { inPixels: 300 }, 220, 380),
    ).toBe(342)
  })
})

describe('right sidebar geometry guard', () => {
  it('flags a sidebar the preference shows but the layout does not', () => {
    expect(sidebarGeometryProblem({ left: 1280, right: 1280, width: 0 }, 1280, 260)).toBe(
      'zero-width',
    )
    expect(sidebarGeometryProblem({ left: 1100, right: 1400, width: 300 }, 1280, 260)).toBe(
      'off-window',
    )
    expect(sidebarGeometryProblem({ left: 1180, right: 1280, width: 100 }, 1280, 260)).toBe(
      'below-min',
    )
  })

  it('accepts a sidebar inside the window at or above its minimum', () => {
    expect(sidebarGeometryProblem({ left: 980, right: 1280, width: 300 }, 1280, 260)).toBeNull()
    expect(
      sidebarGeometryProblem({ left: 1020.4, right: 1280.6, width: 259.5 }, 1280, 260),
    ).toBeNull()
  })

  it('clamps a stored width into the legal range', () => {
    expect(clampSidebarWidth(0, 260, 420)).toBe(260)
    expect(clampSidebarWidth(900, 260, 420)).toBe(420)
    expect(clampSidebarWidth(Number.NaN, 260, 420)).toBe(260)
    expect(clampSidebarWidth(300.4, 260, 420)).toBe(300)
  })
})
