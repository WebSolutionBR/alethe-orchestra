import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mirror } from './mirror'
import type { MirrorPalette } from './types'

vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

const PALETTE: MirrorPalette = {
  foreground: '#f0f0f0',
  background: '#101010',
  ansi: Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`),
}

/**
 * The first 252 801 bytes one Orchestra worker's PTY recorded (Claude Code 2.1.289 through ConPTY,
 * 120x32): it enters the alternate screen at once and repaints rows in place from then on.
 */
const CLAUDE_CODE = readFileSync(
  join(process.cwd(), 'src/lib/terminalMirror/fixtures/claude-code-alt-screen.bin'),
).toString('utf8')

const ROWS = 10
const FOOTER = ['────────────', '❯ type here', '────────────']
const CONVERSATION = Array.from({ length: 60 }, (_, i) => `message ${String(i).padStart(2, '0')}`)

const mirrors: Mirror[] = []

function mirror(cols = 40, rows = ROWS, scrollback = 500): Mirror {
  const created = new Mirror('alt', { cols, rows, scrollback })
  mirrors.push(created)
  created.feed('\x1b[?1049h\x1b[2J\x1b[H')
  return created
}

afterEach(() => {
  for (const created of mirrors.splice(0)) created.dispose()
})

/** One ConPTY-style repaint: cursor hidden, every row placed with CUP, cursor shown on the prompt. */
function paint(rows: string[], colored = false): string {
  let out = '\x1b[?25l\x1b[H'
  rows.forEach((text, row) => {
    const styled = colored && text.startsWith('message') ? `\x1b[32m${text}\x1b[39m` : text
    out += `\x1b[${row + 1};1H${styled}\x1b[K`
  })
  return `${out}\x1b[${rows.length - 1};3H\x1b[?25h`
}

/** The screen of a chat whose newest line is `last`: conversation on top, prompt box below. */
function chat(last: number, rows = ROWS): string[] {
  const height = rows - FOOTER.length
  const visible = CONVERSATION.slice(Math.max(0, last - height), last)
  return [...Array(height - visible.length).fill(''), ...visible, ...FOOTER]
}

function historyText(m: Mirror): string[] {
  return m.getText(0, m.baseY).split('\n')
}

describe('alternate screen history', () => {
  it('turns the rows that scroll out of a full-screen program into scrollback', () => {
    const m = mirror()
    for (let last = 1; last <= 40; last++) m.feed(paint(chat(last), true))
    expect(m.bufferType).toBe('alternate')
    expect(m.baseY).toBe(33)
    expect(m.length).toBe(33 + ROWS)
    expect(historyText(m)).toEqual(CONVERSATION.slice(0, 33))
    expect(m.getText(0, m.length).split('\n').slice(0, 40)).toEqual(CONVERSATION.slice(0, 40))
    // The cursor, the search and the colors follow the shared line space.
    expect(m.cursor.y).toBe(m.baseY + ROWS - 2)
    expect(m.search('message 05')).toEqual([{ line: 5, start: 0, end: 10 }])
    expect(m.getLines(5, 6, PALETTE)[0].runs[0]).toMatchObject({
      text: 'message 05',
      fg: PALETTE.ansi[2],
    })
  })

  it('keeps going across a resize without copying rows twice', () => {
    const m = mirror()
    for (let last = 1; last <= 20; last++) m.feed(paint(chat(last)))
    m.resize(30, 12)
    for (let last = 20; last <= 40; last++) m.feed(paint(chat(last, 12)))
    const history = historyText(m)
    expect(new Set(history).size).toBe(history.length)
    expect(history).toEqual(CONVERSATION.slice(0, history.length))
    expect(history.length).toBeGreaterThanOrEqual(28)
  })

  it('does not copy again what the program scrolled back into view', () => {
    const m = mirror()
    for (let last = 1; last <= 30; last++) m.feed(paint(chat(last)))
    const before = historyText(m)
    for (let last = 29; last >= 15; last -= 2) m.feed(paint(chat(last)))
    for (let last = 17; last <= 30; last += 3) m.feed(paint(chat(last)))
    m.feed(paint(chat(30)))
    expect(historyText(m)).toEqual(before)
  })

  it('keeps what a clear, leaving the alternate screen or a reset wipes', () => {
    const m = mirror()
    for (let last = 1; last <= 12; last++) m.feed(paint(chat(last)))
    m.feed('\x1b[2J')
    expect(historyText(m)).toEqual([...CONVERSATION.slice(0, 12), ...FOOTER])

    m.feed(paint(['after clear', '', '', '', '', '', '', ...FOOTER]))
    m.feed('\x1b[?1049l')
    expect(m.bufferType).toBe('normal')
    // The session stays in the transcript, before the normal screen it started from.
    expect(m.getText(0, 1)).toBe('message 00')
    expect(m.baseY).toBe(CONVERSATION.slice(0, 12).length + FOOTER.length + 2 + FOOTER.length)
    m.feed('\x1b[?1049h')
    expect(m.bufferType).toBe('alternate')
    const history = historyText(m)
    // One blank row between content is kept; the empty rest of the screen is not.
    expect(history.slice(-5)).toEqual(['after clear', '', ...FOOTER])
  })

  it('compares frames on its own when the program never toggles the cursor', async () => {
    const m = mirror()
    const plain = (last: number) =>
      '\x1b[H' +
      chat(last)
        .map((text, row) => `\x1b[${row + 1};1H${text}\x1b[K`)
        .join('')
    m.feed(plain(10))
    await new Promise((resolve) => setTimeout(resolve, 150))
    m.feed(plain(13))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(historyText(m)).toEqual(CONVERSATION.slice(3, 6))
  })

  it('counts the history rows dropped past the scrollback cap in trimmed', () => {
    const m = mirror(40, ROWS, 5)
    for (let last = 1; last <= 20; last++) m.feed(paint(chat(last)))
    expect(m.baseY).toBe(5)
    expect(m.trimmed).toBe(8)
    expect(historyText(m)).toEqual(CONVERSATION.slice(8, 13))
  })

  it('rebuilds a real Claude Code session from its repaints', () => {
    const m = new Mirror('claude-code', { cols: 120, rows: 32, scrollback: 6000 })
    mirrors.push(m)
    for (let i = 0; i < CLAUDE_CODE.length; i += 16_384) m.feed(CLAUDE_CODE.slice(i, i + 16_384))
    expect(m.bufferType).toBe('alternate')
    expect(m.baseY).toBeGreaterThanOrEqual(30)
    const history = historyText(m)
    expect(history[0]).toContain('Claude Code v2.1.289')
    for (let i = 1; i < history.length; i++) {
      if (history[i].trim()) expect(history[i]).not.toBe(history[i - 1])
    }
    const narration =
      '● Li as tarefas e as duas notas obrigatórias do Obsidian. Agora leio a nota da sessão de hoje e o código do repositório.'
    expect(history.filter((line) => line === narration)).toHaveLength(1)
    const found = m.search('Encontrei um ponto crítico')
    expect(found).toHaveLength(1)
    expect(found[0].line).toBeLessThan(m.baseY)
    // The live screen still ends with Claude Code's prompt box.
    expect(m.getText(m.baseY, m.length)).toContain('bypass permissions on')
  })

  it('keeps the full-screen session in the transcript after the program leaves it', () => {
    const m = new Mirror('claude-code-exit', { cols: 120, rows: 32, scrollback: 6000 })
    mirrors.push(m)
    for (let i = 0; i < CLAUDE_CODE.length; i += 16_384) m.feed(CLAUDE_CODE.slice(i, i + 16_384))
    // /exit, a double Ctrl+C or a crash: the program leaves the alternate screen and prints a line.
    m.feed('\x1b[?1049l')
    m.feed('Resume this session with: claude --resume 00000000\r\n')
    expect(m.bufferType).toBe('normal')
    const text = m.getText(0, m.length)
    const narration =
      '● Li as tarefas e as duas notas obrigatórias do Obsidian. Agora leio a nota da sessão de hoje e o código do repositório.'
    expect(text).toContain('Claude Code v2.1.289')
    expect(text.split('\n').filter((line) => line === narration)).toHaveLength(1)
    // The last screen is kept too, and what the shell printed afterwards comes after it.
    expect(text).toContain('bypass permissions on')
    expect(text.indexOf('bypass permissions on')).toBeLessThan(text.indexOf('Resume this session'))
    expect(m.search('Encontrei um ponto crítico')).toHaveLength(1)
    expect(m.getText(m.cursor.y - 1, m.cursor.y)).toBe(
      'Resume this session with: claude --resume 00000000',
    )
  })

  it('splices each full-screen session back where it started, in order', () => {
    const m = new Mirror('sessions', { cols: 40, rows: ROWS, scrollback: 500 })
    mirrors.push(m)
    m.feed('$ ls\r\nfile-a\r\n$ claude\r\n')
    m.feed('\x1b[?1049h\x1b[2J\x1b[H')
    for (let last = 1; last <= 20; last++) m.feed(paint(chat(last)))
    m.feed('\x1b[?1049l')
    m.feed('bye\r\n$ vim\r\n')
    m.feed('\x1b[?1049h\x1b[2J\x1b[H')
    m.feed(paint(['vim buffer', '', '', '', '', '', '', ...FOOTER]))
    m.feed('\x1b[?1049l')
    m.feed('done')
    const lines = m.getText(0, m.length).split('\n')
    const session = [...CONVERSATION.slice(0, 20), ...FOOTER]
    const second = ['vim buffer', '', ...FOOTER]
    expect(lines.slice(0, 3 + session.length + 2 + second.length + 1)).toEqual([
      '$ ls',
      'file-a',
      '$ claude',
      ...session,
      'bye',
      '$ vim',
      ...second,
      'done',
    ])
    expect(m.cursor).toMatchObject({ x: 4, y: 3 + session.length + 2 + second.length })
    // Back on the alternate screen, the kept history leads again.
    m.feed('\x1b[?1049h')
    expect(m.getText(0, 1)).toBe('message 00')
  })
})
