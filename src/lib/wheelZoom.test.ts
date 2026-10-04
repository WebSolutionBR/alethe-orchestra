import { describe, expect, it } from 'vitest'

import { createWheelZoomAccumulator, WHEEL_ZOOM_THRESHOLD } from './wheelZoom'

describe('createWheelZoomAccumulator', () => {
  it('takes one step per mouse notch', () => {
    const accumulate = createWheelZoomAccumulator()
    // A wheel notch reports ±100 in every browser that ships a mouse.
    expect(accumulate(-100)).toBe(1)
    expect(accumulate(100)).toBe(-1)
  })

  it('holds back trackpad deltas until they add up to a notch', () => {
    const accumulate = createWheelZoomAccumulator()
    expect(accumulate(-10)).toBe(0)
    expect(accumulate(-10)).toBe(0)
    expect(accumulate(-10)).toBe(0)
    expect(accumulate(-10)).toBe(0)
    expect(accumulate(-9)).toBe(0)
    // 49 accumulated is still short of the threshold; the next tick crosses it.
    expect(accumulate(-1)).toBe(1)
  })

  it('drops the leftover after a step so the next one needs a full threshold', () => {
    const accumulate = createWheelZoomAccumulator()
    expect(accumulate(-120)).toBe(1)
    expect(accumulate(-20)).toBe(0)
  })

  it('discards the accumulated delta when the direction flips', () => {
    const accumulate = createWheelZoomAccumulator()
    // Without the reset, scrolling up then down would zoom in on the way back.
    expect(accumulate(-40)).toBe(0)
    expect(accumulate(40)).toBe(0)
    expect(accumulate(-40)).toBe(0)
  })

  it('ignores a delta of zero', () => {
    const accumulate = createWheelZoomAccumulator()
    expect(accumulate(0)).toBe(0)
  })

  it('keeps a threshold a mouse notch can always clear', () => {
    expect(WHEEL_ZOOM_THRESHOLD).toBeLessThanOrEqual(100)
  })
})
