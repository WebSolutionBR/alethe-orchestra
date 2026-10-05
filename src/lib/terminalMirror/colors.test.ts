import { describe, expect, it } from 'vitest'

import {
  COLOR_MODE_DEFAULT,
  COLOR_MODE_P16,
  COLOR_MODE_P256,
  COLOR_MODE_RGB,
  mirrorPaletteFromTheme,
  paletteTable,
  resolveColor,
  XTERM_DEFAULT_ANSI,
} from './colors'

describe('mirror colors', () => {
  it('builds a palette from an xterm theme, filling the gaps with xterm defaults', () => {
    const palette = mirrorPaletteFromTheme({
      foreground: '#cccccc',
      background: '#1e1e1e',
      red: '#cd3131',
    })
    expect(palette.foreground).toBe('#cccccc')
    expect(palette.background).toBe('#1e1e1e')
    expect(palette.ansi).toHaveLength(16)
    expect(palette.ansi[1]).toBe('#cd3131')
    expect(palette.ansi[0]).toBe(XTERM_DEFAULT_ANSI[0])
    expect(palette.ansi[15]).toBe(XTERM_DEFAULT_ANSI[15])
    expect(mirrorPaletteFromTheme({})).toMatchObject({
      foreground: '#ffffff',
      background: '#000000',
    })
  })

  it('generates the 256-color cube and greys exactly like xterm', () => {
    const table = paletteTable(mirrorPaletteFromTheme({}))
    expect(table).toHaveLength(256)
    expect(table[16]).toBe('#000000')
    expect(table[21]).toBe('#0000ff')
    expect(table[196]).toBe('#ff0000')
    expect(table[100]).toBe('#878700')
    expect(table[231]).toBe('#ffffff')
    expect(table[232]).toBe('#080808')
    expect(table[255]).toBe('#eeeeee')
  })

  it('resolves default, palette and truecolor cells', () => {
    const palette = mirrorPaletteFromTheme({ blue: '#0000aa' })
    const table = paletteTable(palette)
    expect(resolveColor(COLOR_MODE_DEFAULT, -1, table)).toBeNull()
    expect(resolveColor(COLOR_MODE_P16, 4, table)).toBe('#0000aa')
    expect(resolveColor(COLOR_MODE_P256, 4, table)).toBe('#0000aa')
    expect(resolveColor(COLOR_MODE_P256, 232, table)).toBe('#080808')
    expect(resolveColor(COLOR_MODE_RGB, 0x0102ff, table)).toBe('#0102ff')
  })

  it('memoizes the table per palette object', () => {
    const palette = mirrorPaletteFromTheme({})
    expect(paletteTable(palette)).toBe(paletteTable(palette))
    const other = mirrorPaletteFromTheme({ black: '#111111' })
    expect(paletteTable(other)[0]).toBe('#111111')
  })
})
