import { describe, expect, it } from 'vitest'

import { domPointToCell, orderPoints } from './domSelection'

/** The DOM the renderer produces for: "ab" + boxed "✻" (cell 2) + "cd" on line 7, and an empty line 8. */
function rows(): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML =
    '<div data-line="7" data-c0="0" data-c1="5">' +
    '<span data-c="0">ab</span>' +
    '<span><span data-c="2" data-w="1">✻</span><span data-c="3">cd</span></span>' +
    '</div>' +
    '<div data-line="8" data-c0="0" data-c1="0"></div>'
  document.body.appendChild(container)
  return container
}

describe('domPointToCell', () => {
  it('reads a text offset inside a plain segment as a cell', () => {
    const container = rows()
    const text = container.querySelector('[data-c="3"]')!.firstChild!
    expect(domPointToCell(text, 1, container)).toEqual({ line: 7, cell: 4 })
    container.remove()
  })

  it('maps the two sides of a box to its first cell and the cell after it', () => {
    const container = rows()
    const text = container.querySelector('[data-w]')!.firstChild!
    expect(domPointToCell(text, 0, container)).toEqual({ line: 7, cell: 2 })
    expect(domPointToCell(text, 1, container)).toEqual({ line: 7, cell: 3 })
    container.remove()
  })

  it('resolves element boundaries through the children', () => {
    const container = rows()
    const row = container.querySelector('[data-line="7"]')!
    expect(domPointToCell(row, 1, container)).toEqual({ line: 7, cell: 2 })
    expect(domPointToCell(row, 2, container)).toEqual({ line: 7, cell: 5 })
    expect(domPointToCell(container, 1, container)).toEqual({ line: 8, cell: 0 })
    expect(domPointToCell(container, 2, container)).toEqual({ line: 8, cell: 0 })
    const empty = container.querySelector('[data-line="8"]')!
    expect(domPointToCell(empty, 0, container)).toEqual({ line: 8, cell: 0 })
    container.remove()
  })

  it('ignores points outside the rows', () => {
    const container = rows()
    const outside = document.createElement('p')
    document.body.appendChild(outside)
    expect(domPointToCell(outside, 0, container)).toBeNull()
    outside.remove()
    container.remove()
  })
})

describe('orderPoints', () => {
  it('orders by line, then cell', () => {
    const a = { line: 2, cell: 9 }
    const b = { line: 3, cell: 0 }
    expect(orderPoints(b, a)).toEqual([a, b])
    expect(orderPoints({ line: 2, cell: 5 }, { line: 2, cell: 1 })).toEqual([
      { line: 2, cell: 1 },
      { line: 2, cell: 5 },
    ])
  })
})
