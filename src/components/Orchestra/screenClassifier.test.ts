import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mirror } from '../../lib/terminalMirror/mirror'
import { classifyScreen, lastLines, looksBusy, resetTime } from './screenClassifier'

vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

const screen = (name: string) =>
  readFileSync(join(process.cwd(), 'src/components/Orchestra/fixtures/screens', name), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')

const mirrors: Mirror[] = []
afterEach(() => {
  for (const m of mirrors.splice(0)) m.dispose()
})

// 12/10/2026, 14:05 local time.
const NOW = new Date(2026, 9, 12, 14, 5)

describe('classifyScreen', () => {
  it.each([
    ['trust.txt', 'trust'],
    ['login-expired.txt', 'login'],
    ['login-method.txt', 'login'],
    ['onboarding.txt', 'onboarding'],
    ['mcp-approval.txt', 'mcp'],
    ['press-enter.txt', 'press-enter'],
    ['proceed.txt', 'proceed'],
    ['usage-limit.txt', 'usage-limit'],
    ['usage-limit-menu.txt', 'usage-limit'],
  ])('%s is %s', (file, kind) => {
    expect(classifyScreen(screen(file), NOW)?.kind).toBe(kind)
  })

  it('reads the real trust dialog the orchestrator PTY recorded', async () => {
    const bytes = readFileSync(
      join(process.cwd(), 'src/lib/terminalMirror/fixtures/trust-dialog.bin'),
    ).toString('utf8')
    const mirror = new Mirror('classifier', { cols: 100, rows: 30, scrollback: 100 })
    mirrors.push(mirror)
    await mirror.feed(bytes)
    const lines = mirror.getText(mirror.baseY, mirror.baseY + mirror.rows).split('\n')
    expect(classifyScreen(lines, NOW)?.kind).toBe('trust')
  })

  it('says nothing about a working agent or an unknown screen', () => {
    expect(looksBusy(screen('working.txt'))).toBe(true)
    expect(classifyScreen(screen('working.txt'), NOW)).toBeNull()
    expect(classifyScreen(screen('unknown.txt'), NOW)).toBeNull()
  })

  it('quotes the last lines without frames', () => {
    const verdict = classifyScreen(screen('login-expired.txt'), NOW)
    expect(verdict?.text).toContain('Login expired · Please run /login')
    expect(verdict?.text).not.toMatch(/[╭╰│]/)
    expect(verdict?.text.split('\n').length).toBeLessThanOrEqual(8)
    expect(lastLines(screen('unknown.txt'))).toContain('56%')
  })

  it('takes the usage limit reset time from the screen', () => {
    const at = new Date(classifyScreen(screen('usage-limit.txt'), NOW)!.resetAt!)
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([12, 15, 0])
    const menu = new Date(classifyScreen(screen('usage-limit-menu.txt'), NOW)!.resetAt!)
    expect([menu.getHours(), menu.getMinutes()]).toEqual([18, 30])
  })
})

describe('resetTime', () => {
  it('rolls over to tomorrow when the hour already passed', () => {
    const at = new Date(resetTime('resets 9am', NOW)!)
    expect([at.getDate(), at.getHours()]).toEqual([13, 9])
  })

  it('understands 12am, 12pm and a 24 h clock, and refuses nonsense', () => {
    expect(new Date(resetTime('resets 12am', NOW)!).getHours()).toBe(0)
    expect(new Date(resetTime('resets at 12pm', NOW)!).getHours()).toBe(12)
    expect(new Date(resetTime('resets 17:45', NOW)!).getHours()).toBe(17)
    expect(resetTime('resets 13pm', NOW)).toBeNull()
    expect(resetTime('no time here', NOW)).toBeNull()
  })
})
