import { describe, expect, it } from 'vitest'

import { CANVAS_MIN, handlePlacement, panelBounds, panelLimit } from './panelGeometry'

describe('panelLimit', () => {
  it('leaves the minimum canvas out of the room', () => {
    expect(panelLimit(900)).toBe(900 - CANVAS_MIN)
    expect(panelLimit(900, Infinity, 100)).toBe(800)
    expect(panelLimit(900.8)).toBe(740)
  })

  it('never exceeds what the content needs', () => {
    expect(panelLimit(900, 300)).toBe(300)
    expect(panelLimit(400, 300)).toBe(240)
  })

  it('reports nothing before layout', () => {
    expect(panelLimit(0)).toBeNull()
    expect(panelLimit(Number.NaN)).toBeNull()
  })
})

describe('panelBounds', () => {
  it('uses the fixed max until the container is measured', () => {
    expect(panelBounds(700, 80, 520, null)).toEqual({ size: 520, max: 520 })
    expect(panelBounds(300, 80, 520, null)).toEqual({ size: 300, max: 520 })
  })

  it('lets the panel grow past the fixed max when the container has room', () => {
    expect(panelBounds(700, 80, 520, 840)).toEqual({ size: 700, max: 840 })
  })

  it('re-clamps for a smaller container and grows back with a larger one', () => {
    expect(panelBounds(700, 80, 520, 440)).toEqual({ size: 440, max: 440 })
    expect(panelBounds(700, 80, 520, 900)).toEqual({ size: 700, max: 900 })
  })

  it('keeps the minimum when the container has no room left', () => {
    expect(panelBounds(300, 80, 520, 20)).toEqual({ size: 80, max: 80 })
    expect(panelBounds(300, 80, 520, -60)).toEqual({ size: 80, max: 80 })
    expect(panelBounds(10, 80, 520, 840).size).toBe(80)
  })
})

describe('handlePlacement', () => {
  const el = (...children: HTMLElement[]) => {
    const node = document.createElement('div')
    node.append(...children)
    return node
  }

  it('climbs from the leading edge of a bottom panel to the view root', () => {
    // Constellation / Flow: root > [canvas, bus > [handle, head, body]]
    const handle = el()
    const root = el(el(), el(handle, el(), el()))
    expect(handlePlacement(handle).container).toBe(root)
    expect(handlePlacement(handle).panelBefore).toBeNull()
  })

  it('climbs out of the wrapper of a side panel', () => {
    // Hive: layout > [stage, side > [wrapper > [handle], head]]
    const handle = el()
    const layout = el(el(), el(el(handle), el()))
    expect(handlePlacement(handle).container).toBe(layout)
    expect(handlePlacement(handle).panelBefore).toBeNull()
  })

  it('resizes the sibling right before a handle placed between two', () => {
    // Timeline: root > [toolbar, lanes, handle, legend, bus]
    const lanes = el()
    const handle = el()
    const root = el(el(), lanes, handle, el(), el())
    expect(handlePlacement(handle).container).toBe(root)
    expect(handlePlacement(handle).panelBefore).toBe(lanes)
  })

  it('finds no container for a handle with nothing beside it', () => {
    const handle = el()
    el(el(handle))
    expect(handlePlacement(handle)).toEqual({ container: null, panelBefore: null })
  })
})
