import type { MirrorPalette } from './types'

/** xterm.js defaults, used when a theme leaves an ANSI slot (or fg/bg) undefined. */
export const XTERM_DEFAULT_FOREGROUND = '#ffffff'
export const XTERM_DEFAULT_BACKGROUND = '#000000'
export const XTERM_DEFAULT_ANSI: readonly string[] = Object.freeze([
  '#2e3436',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf',
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec',
])

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

type AnsiName = (typeof ANSI_NAMES)[number]

/** The subset of an xterm `ITheme` the mirror needs (getXtermTheme's result fits). */
export type MirrorThemeLike = Partial<Record<'foreground' | 'background' | AnsiName, string>>

/** Builds the palette a view hands to `getLines` from the same theme the XTermView uses. */
export function mirrorPaletteFromTheme(theme: MirrorThemeLike): MirrorPalette {
  return {
    foreground: theme.foreground ?? XTERM_DEFAULT_FOREGROUND,
    background: theme.background ?? XTERM_DEFAULT_BACKGROUND,
    ansi: ANSI_NAMES.map((name, index) => theme[name] ?? XTERM_DEFAULT_ANSI[index]),
  }
}

/** Color modes as returned by `IBufferCell.getFgColorMode()` / `getBgColorMode()`. */
export const COLOR_MODE_DEFAULT = 0
export const COLOR_MODE_P16 = 0x1000000
export const COLOR_MODE_P256 = 0x2000000
export const COLOR_MODE_RGB = 0x3000000

const CUBE_STEPS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0')
}

export function rgbToCss(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

/** The 216-color cube (16-231) and the 24 greys (232-255), the same values xterm.js generates. */
const EXTENDED_COLORS: readonly string[] = (() => {
  const colors: string[] = []
  for (let i = 0; i < 216; i++) {
    const r = CUBE_STEPS[Math.floor(i / 36) % 6]
    const g = CUBE_STEPS[Math.floor(i / 6) % 6]
    const b = CUBE_STEPS[i % 6]
    colors.push(`#${hexByte(r)}${hexByte(g)}${hexByte(b)}`)
  }
  for (let i = 0; i < 24; i++) {
    const c = 8 + i * 10
    colors.push(`#${hexByte(c)}${hexByte(c)}${hexByte(c)}`)
  }
  return colors
})()

let cachedPalette: MirrorPalette | null = null
let cachedTable: string[] = []

/** 256 CSS colors for a palette: its 16 ANSI slots, then the fixed cube and greys. Memoized. */
export function paletteTable(palette: MirrorPalette): string[] {
  if (palette === cachedPalette) return cachedTable
  const table: string[] = new Array(256)
  for (let i = 0; i < 16; i++) table[i] = palette.ansi[i] ?? XTERM_DEFAULT_ANSI[i]
  for (let i = 16; i < 256; i++) table[i] = EXTENDED_COLORS[i - 16]
  cachedPalette = palette
  cachedTable = table
  return table
}

/** A cell color as CSS; null when it is the theme default. */
export function resolveColor(mode: number, value: number, table: string[]): string | null {
  switch (mode) {
    case COLOR_MODE_P16:
    case COLOR_MODE_P256:
      return table[value & 0xff] ?? null
    case COLOR_MODE_RGB:
      return rgbToCss(value)
    default:
      return null
  }
}
