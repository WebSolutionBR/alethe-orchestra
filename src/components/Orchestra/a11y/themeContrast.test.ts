import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/*
 * WCAG contrast of the agent and status colors in every theme. Text needs 4.5:1 (SC 1.4.3);
 * swatches, bars and the focus ring need 3:1 (SC 1.4.11). `--status-disabled` is left out on
 * purpose: inactive controls have no contrast requirement. Faint text (hints, counts, paths) has
 * the agreed 3:1 floor and must stay fainter than muted text. Filled danger buttons get their own
 * deeper red, and a working agent never reads like a failed one.
 */

type Rgba = [number, number, number, number]
type Vars = Record<string, string>

/** Painted as text by the Orchestra: state labels, agent names, bus lines, badges. */
const TEXT_TOKENS = [
  '--agent-claude',
  '--agent-codex',
  '--agent-obsidian',
  '--agent-creative',
  '--status-working',
  '--status-waiting',
  '--status-offline',
  '--status-stopped',
]
/** Only drawn as swatches and bars (the Timeline's "running"). */
const GRAPHIC_TOKENS = ['--agent-freebuff']
/** The light themes define their own colors for all of these instead of inheriting the dark ones. */
const LIGHT_THEMES = ['light', 'min-light']
const LIGHT_OWN_TOKENS = [
  '--agent-shell',
  '--agent-claude',
  '--agent-codex',
  '--agent-opencode',
  '--agent-freebuff',
  '--agent-mimo',
  '--agent-antigravity',
  '--status-working',
  '--status-waiting',
  '--status-stopped',
  '--status-offline',
  '--focus-ring',
]
const LIGHT_SURFACES = [
  '--bg',
  '--bg-elevated',
  '--bg-sunken',
  '--panel',
  '--panel-hover',
  '--surface-card-default',
  '--surface-card-default-strong',
]
/**
 * Written as text on their own `-soft` tint, with the surfaces those badges sit on: the session
 * tabs on the background; the start screen and the Mission control cards on the elevated one.
 */
const BADGES: Record<string, string[]> = {
  '--status-offline': ['--bg'],
  '--status-waiting': ['--bg', '--bg-elevated'],
}
/** Where faint text sits; hover and selected fills are passing states and stay out. */
const TEXT_SURFACES = ['--bg', '--bg-elevated', '--bg-sunken', '--panel', '--surface-card-default']
/**
 * Where the Orchestra writes its colored text, with the minimum each one needs: the views sit on
 * the background, the cards on the elevated surface; `--panel` is only hover fills, selections and
 * bar tracks, so 3:1 there.
 */
const COLORED_TEXT_ON: Record<string, number> = { '--bg': 4.5, '--bg-elevated': 4.5, '--panel': 3 }
/** Smallest OKLab distance between a working worker (orange) and a failed one (red). */
const WORKING_FAILED_GAP = 0.06
/** The light themes darken every warm color toward brown, so they keep twice the gap. */
const WORKING_FAILED_GAP_LIGHT = 0.12

// Read from disk (vitest runs from the repo root): it stubs CSS imports, `?raw` included.
const css = readFileSync(resolve(process.cwd(), 'src/styles/theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function declarations(body: string): Vars {
  const vars: Vars = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim()
  return vars
}

/** Each theme's own declarations, and what it resolves to over `:root` (the dark theme). */
function readThemes(source: string) {
  const blocks = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    vars: declarations(m[2]),
  }))
  const root = blocks.find((b) => /(^|,)\s*:root\b/.test(b.selector))?.vars ?? {}
  const own = new Map<string, Vars>()
  for (const block of blocks) {
    for (const m of block.selector.matchAll(/\[data-theme='([\w-]+)'\]/g)) own.set(m[1], block.vars)
  }
  const resolved = new Map<string, Vars>()
  for (const [name, vars] of own) resolved.set(name, { ...root, ...vars })
  return { own, resolved }
}

const { own, resolved } = readThemes(css)
const themeNames = [...resolved.keys()]

function value(theme: string, token: string): string {
  const vars = resolved.get(theme) ?? {}
  let v = vars[token]
  for (let i = 0; i < 8 && v?.startsWith('var('); i++) v = vars[v.slice(4, -1).trim()]
  if (!v) throw new Error(`${theme} has no ${token}`)
  return v
}

function parse(color: string): Rgba {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba
  }
  const rgba = color.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(',').map(Number)
    return [r, g, b, a]
  }
  throw new Error(`unsupported color ${color}`)
}

/** An opaque color; tokens checked as foreground or surface must not be translucent. */
function solid(theme: string, token: string): Rgba {
  const c = parse(value(theme, token))
  expect(c[3], `${theme} ${token} must be opaque`).toBe(1)
  return c
}

/** A translucent tint laid over an opaque background. */
function over(tint: Rgba, bg: Rgba): Rgba {
  const a = tint[3]
  return [0, 1, 2].map((i) => tint[i] * a + bg[i] * (1 - a)).concat(1) as Rgba
}

/** One sRGB channel (0-255) in linear light. */
function linear(v: number): number {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** OKLab, where the straight distance between two colors tracks how different they look. */
function oklab([r, g, b]: Rgba): [number, number, number] {
  const [R, G, B] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function distance(a: Rgba, b: Rgba): number {
  const [x, y] = [oklab(a), oklab(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** `color-mix(in srgb, color 85%, #000)`, the hover of the filled danger buttons. */
function darkened([r, g, b]: Rgba, keep = 0.85): Rgba {
  return [r * keep, g * keep, b * keep, 1]
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function hue([r, g, b]: Rgba): number {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

function expectContrast(theme: string, token: string, bgToken: string, min: number) {
  const fg = solid(theme, token)
  const bg = solid(theme, bgToken)
  const ratio = contrast(fg, bg)
  expect(
    ratio,
    `${theme}: ${token} ${value(theme, token)} on ${bgToken} ${value(theme, bgToken)} is ${ratio.toFixed(2)}:1`,
  ).toBeGreaterThanOrEqual(min)
}

describe('theme contrast', () => {
  it('reads every theme block, light ones included', () => {
    expect(themeNames.length).toBeGreaterThanOrEqual(14)
    expect(themeNames).toEqual(expect.arrayContaining(['dark', ...LIGHT_THEMES]))
  })

  it.each(themeNames)(
    '%s: Orchestra text colors reach 4.5:1 on the background and on cards',
    (theme) => {
      for (const token of TEXT_TOKENS) {
        for (const [surface, min] of Object.entries(COLORED_TEXT_ON)) {
          expectContrast(theme, token, surface, min)
        }
      }
    },
  )

  it.each(themeNames)('%s: filled danger buttons keep 4.5:1, hovered too', (theme) => {
    expect(own.get(theme)?.['--danger'], `${theme} has no --danger of its own`).toBeDefined()
    expectContrast(theme, '--danger-on', '--danger', 4.5)
    const hover = contrast(solid(theme, '--danger-on'), darkened(solid(theme, '--danger')))
    expect(
      hover,
      `${theme}: hovered danger button is ${hover.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  it.each(themeNames)('%s: a working worker never looks like a failed one', (theme) => {
    const gap = distance(solid(theme, '--agent-claude'), solid(theme, '--status-offline'))
    const min = LIGHT_THEMES.includes(theme) ? WORKING_FAILED_GAP_LIGHT : WORKING_FAILED_GAP
    expect(gap, `${theme}: working and failed are ${gap.toFixed(3)} apart`).toBeGreaterThanOrEqual(
      min,
    )
  })

  it.each(themeNames)(
    '%s: swatch colors and the focus ring reach 3:1 on the background',
    (theme) => {
      for (const token of [...GRAPHIC_TOKENS, '--focus-ring'])
        expectContrast(theme, token, '--bg', 3)
    },
  )

  it.each(LIGHT_THEMES)('%s: declares its own agent, status and focus colors', (theme) => {
    for (const token of LIGHT_OWN_TOKENS) {
      expect(
        own.get(theme)?.[token],
        `${theme} inherits ${token} from the dark theme`,
      ).toBeDefined()
    }
  })

  it.each(LIGHT_THEMES)(
    '%s: every agent and status color reaches 4.5:1 on every surface',
    (theme) => {
      const tokens = [...new Set([...LIGHT_OWN_TOKENS, ...TEXT_TOKENS])].filter(
        (t) => t !== '--focus-ring',
      )
      for (const token of tokens) {
        for (const surface of LIGHT_SURFACES) expectContrast(theme, token, surface, 4.5)
      }
      for (const surface of LIGHT_SURFACES) expectContrast(theme, '--focus-ring', surface, 3)
    },
  )

  it.each(themeNames)('%s: status badges keep 4.5:1 on their own tint', (theme) => {
    for (const [token, surfaces] of Object.entries(BADGES)) {
      for (const surface of surfaces) {
        const chip = over(parse(value(theme, `${token}-soft`)), solid(theme, surface))
        const ratio = contrast(solid(theme, token), chip)
        expect(
          ratio,
          `${theme}: ${token} on ${token}-soft over ${surface} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each(themeNames)('%s: faint text reaches 3:1 wherever text sits', (theme) => {
    for (const surface of TEXT_SURFACES) expectContrast(theme, '--fg-faint', surface, 3)
  })

  it.each(themeNames)('%s: faint text stays fainter than muted text', (theme) => {
    const onBg = (token: string) => contrast(solid(theme, token), solid(theme, '--bg'))
    expect(onBg('--fg-faint'), theme).toBeLessThan(onBg('--fg-muted'))
    expect(onBg('--fg-muted'), theme).toBeLessThan(onBg('--fg'))
    expect(onBg('--text-quaternary'), theme).toBeLessThan(onBg('--fg-faint'))
    // The text-* scale mirrors the fg-* one: tertiary is the faint level.
    expect(value(theme, '--text-tertiary'), theme).toBe(value(theme, '--fg-faint'))
  })

  it('drops movement from the global transitions when the system asks for reduced motion', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start, 'theme.css has no reduced-motion block').toBeGreaterThan(-1)
    let depth = 0
    let end = css.indexOf('{', start)
    for (let i = end; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    const block = css.slice(start, end)
    for (const token of ['--anim-instant', '--anim-fast', '--anim-normal', '--anim-slow']) {
      expect(block, token).toMatch(new RegExp(`${token}\\s*:\\s*[01]m?s\\s*;`))
    }
    const property = block.match(/transition-property\s*:\s*([^;]+);/)?.[1] ?? ''
    expect(property).toMatch(/color/)
    expect(property).not.toMatch(/transform|all/)
  })

  it('never paints a working worker and a blocked one with the same color', () => {
    for (const theme of themeNames) {
      expect(value(theme, '--agent-claude'), theme).not.toBe(value(theme, '--status-waiting'))
    }
    // The light themes darken both toward brown, so they also keep a clear hue gap.
    for (const theme of LIGHT_THEMES) {
      const gap = Math.abs(
        hue(solid(theme, '--agent-claude')) - hue(solid(theme, '--status-waiting')),
      )
      expect(Math.min(gap, 360 - gap), theme).toBeGreaterThanOrEqual(15)
    }
  })
})
