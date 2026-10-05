import type { CellPoint } from './cells'

/*
 * The renderer tags its DOM so a native selection can be read back as cells:
 *   row     [data-line] [data-c0] [data-c1]   one visual row, cells [c0, c1) of a mirror line
 *   segment [data-c] (+ [data-w] when boxed)  text starting at cell c; a box covers w cells
 * Plain segments hold one UTF-16 unit per cell, so a text offset inside one is a cell offset.
 */

function cellAttr(element: Element, name: string): number | null {
  const raw = element.getAttribute(name)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function segmentEnd(segment: Element): number {
  const start = cellAttr(segment, 'data-c') ?? 0
  const width = cellAttr(segment, 'data-w')
  return width !== null ? start + width : start + (segment.textContent?.length ?? 0)
}

function firstCellIn(node: Node): number | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  if (!element) return null
  if (element.hasAttribute('data-c')) return cellAttr(element, 'data-c')
  const inner = element.querySelector('[data-c]')
  return inner ? cellAttr(inner, 'data-c') : null
}

function lastCellIn(element: Element): number | null {
  if (element.hasAttribute('data-c')) return segmentEnd(element)
  const all = element.querySelectorAll('[data-c]')
  const last = all[all.length - 1]
  return last ? segmentEnd(last) : null
}

function rowStart(row: Element): CellPoint | null {
  const line = cellAttr(row, 'data-line')
  if (line === null) return null
  return { line, cell: cellAttr(row, 'data-c0') ?? 0 }
}

function rowEnd(row: Element): CellPoint | null {
  const line = cellAttr(row, 'data-line')
  if (line === null) return null
  return { line, cell: cellAttr(row, 'data-c1') ?? lastCellIn(row) ?? 0 }
}

/** The cell a selection boundary (node, offset) falls on, or null when it is outside `container`. */
export function domPointToCell(node: Node, offset: number, container: Element): CellPoint | null {
  if (node === container) {
    const rows = container.children
    if (offset < rows.length) return rowStart(rows[offset])
    const last = rows[rows.length - 1]
    return last ? rowEnd(last) : null
  }
  if (!container.contains(node)) return null
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  if (!element) return null
  const row = element.closest('[data-line]')
  if (!row || !container.contains(row)) return null
  const line = cellAttr(row, 'data-line')
  if (line === null) return null

  if (node.nodeType === Node.TEXT_NODE) {
    const segment = element.closest('[data-c]')
    if (!segment || !row.contains(segment)) return rowStart(row)
    const start = cellAttr(segment, 'data-c') ?? 0
    const width = cellAttr(segment, 'data-w')
    if (width !== null) return { line, cell: offset > 0 ? start + width : start }
    return { line, cell: start + Math.min(offset, node.textContent?.length ?? offset) }
  }

  const host = node as Element
  if (offset < host.childNodes.length) {
    const cell = firstCellIn(host.childNodes[offset])
    if (cell !== null) return { line, cell }
  }
  if (host === row) return rowEnd(row)
  const cell = lastCellIn(host)
  return cell !== null ? { line, cell } : rowEnd(row)
}

/** Orders two points (line first, then cell). */
export function orderPoints(a: CellPoint, b: CellPoint): [CellPoint, CellPoint] {
  if (a.line < b.line || (a.line === b.line && a.cell <= b.cell)) return [a, b]
  return [b, a]
}
