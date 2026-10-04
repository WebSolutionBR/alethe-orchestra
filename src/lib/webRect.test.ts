import { describe, expect, it } from 'vitest'

import { webRectsEqual } from './webRect'

const r = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h })

describe('webRectsEqual', () => {
  it('rects idênticos são iguais (coalesce: não re-sincroniza)', () => {
    expect(webRectsEqual(r(1, 2, 3, 4), r(1, 2, 3, 4))).toBe(true)
  })

  it('qualquer dimensão diferente quebra a igualdade', () => {
    expect(webRectsEqual(r(1, 2, 3, 4), r(9, 2, 3, 4))).toBe(false)
    expect(webRectsEqual(r(1, 2, 3, 4), r(1, 9, 3, 4))).toBe(false)
    expect(webRectsEqual(r(1, 2, 3, 4), r(1, 2, 9, 4))).toBe(false)
    expect(webRectsEqual(r(1, 2, 3, 4), r(1, 2, 3, 9))).toBe(false)
  })

  it('null só é igual a null', () => {
    expect(webRectsEqual(null, null)).toBe(true)
    expect(webRectsEqual(null, r(0, 0, 0, 0))).toBe(false)
    expect(webRectsEqual(r(0, 0, 0, 0), null)).toBe(false)
  })
})
