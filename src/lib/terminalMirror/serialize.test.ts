import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mirror } from './mirror'
import type { MirrorLine, MirrorPalette } from './types'

vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

const PALETTE: MirrorPalette = {
  foreground: '#f0f0f0',
  background: '#101010',
  ansi: Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`),
}

/** First 1379 bytes the orchestrator's PTY recorded: Claude Code's workspace trust dialog. */
const TRUST_DIALOG = readFileSync(
  join(process.cwd(), 'src/lib/terminalMirror/fixtures/trust-dialog.bin'),
).toString('utf8')

const mirrors: Mirror[] = []

function mirror(cols: number, rows: number, scrollback = 200): Mirror {
  const created = new Mirror('serialize', { cols, rows, scrollback })
  mirrors.push(created)
  return created
}

afterEach(() => {
  for (const created of mirrors.splice(0)) created.dispose()
})

function restore(source: Mirror, scrollback = 200): Mirror {
  const snapshot = source.serialize()
  expect(snapshot).not.toBeNull()
  const copy = mirror(source.cols, source.rows, scrollback)
  copy.feed(snapshot!)
  return copy
}

/** Runs without the trailing default blanks (a replay writes never-written cells as spaces). */
function visibleRuns(line: MirrorLine) {
  const runs = line.runs.map((run) => ({ ...run }))
  while (runs.length > 0) {
    const last = runs[runs.length - 1]
    const trimmed = last.bg === null && !last.invisible ? last.text.replace(/ +$/, '') : last.text
    if (trimmed.length === last.text.length) break
    if (trimmed.length === 0) {
      runs.pop()
      continue
    }
    last.cells -= last.text.length - trimmed.length
    last.text = trimmed
    break
  }
  return { index: line.index, wrapped: line.wrapped, runs }
}

function expectSameContent(copy: Mirror, source: Mirror): void {
  expect(copy.bufferType).toBe(source.bufferType)
  expect(copy.length).toBe(source.length)
  expect(copy.baseY).toBe(source.baseY)
  expect(copy.cursor).toEqual(source.cursor)
  expect(copy.modes).toEqual(source.modes)
  expect(copy.getText(0, copy.length)).toBe(source.getText(0, source.length))
  expect(copy.getLines(0, copy.length, PALETTE).map(visibleRuns)).toEqual(
    source.getLines(0, source.length, PALETTE).map(visibleRuns),
  )
}

describe('serializeMirror round trip', () => {
  it('is null until the mirror has received output', () => {
    expect(mirror(20, 5).serialize()).toBeNull()
  })

  it('rebuilds text, colors, explicit spaces and the cursor', () => {
    const source = mirror(30, 6)
    source.feed(
      '\x1b[2G\x1b[38;2;255;193;7m\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\r\n' +
        '\x1b[31mred\x1b[0m \x1b[7minverse\x1b[0m \x1b[48;5;24m bg \x1b[0m\r\n' +
        '中文 and 😀 wide\r\n' +
        '\x1b[3;4;9mstyled\x1b[0m\x1b[44m\x1b[K\x1b[0m\r\n' +
        'cursor here\x1b[2;5H',
    )
    const copy = restore(source)
    expectSameContent(copy, source)
    expect(copy.getText(0, 1)).toBe(' Accessing workspace:')
  })

  it('keeps soft wraps (including empty and wide-char wraps) and the scrollback', () => {
    const source = mirror(8, 4, 50)
    let text = ''
    for (let i = 0; i < 30; i++) text += `line ${i} ${'x'.repeat(i % 12)}\r\n`
    source.feed(text)
    source.feed('abcdefgh' + '\x1b[44m \x1b[0m' + 'tail\r\n')
    source.feed('abcdefg中文\r\n')
    // A wrapped row emptied afterwards still has to exist.
    source.feed('12345678ABCDEFGH\x1b[A\r\x1b[2K\x1b[B\r\nend')
    expect(source.getLines(0, source.length, PALETTE).some((line) => line.wrapped)).toBe(true)
    expectSameContent(restore(source, 50), source)
  })

  it('repaints an active alternate screen over the normal buffer', () => {
    const source = mirror(20, 5)
    source.feed('shell line 1\r\nshell line 2\r\n$ ')
    source.feed(
      '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;33mTUI title\x1b[0m\x1b[3;5Hbody\x1b[5;1H\x1b[7m status \x1b[0m\x1b[2;3H',
    )
    const copy = restore(source)
    expectSameContent(copy, source)
    // Leaving the alternate screen lands on the normal buffer and cursor the program left behind.
    source.feed('\x1b[?1049l')
    copy.feed('\x1b[?1049l')
    expectSameContent(copy, source)
    expect(copy.getText(0, 3)).toBe('shell line 1\nshell line 2\n$')
    // The full-screen session stays in the transcript, right after the prompt it started from.
    expect(copy.getText(3, 4)).toBe('TUI title')
  })

  it('restores the modes, the hidden cursor and the mouse encoding', () => {
    const source = mirror(40, 6)
    source.feed(
      '\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?25lready',
    )
    const copy = restore(source)
    expectSameContent(copy, source)
    expect(copy.modes).toEqual({
      applicationCursorKeys: true,
      bracketedPaste: true,
      mouseTracking: 'any',
      mouseEncoding: 'sgr',
    })
    expect(copy.cursor.visible).toBe(false)
  })

  it('restores the pen and the scroll region the program relies on', () => {
    const source = mirror(20, 6)
    source.feed('top\r\n\x1b[2;4r\x1b[4;1Hin region\x1b[32m')
    const copy = restore(source)
    // The next bytes draw green and scroll inside rows 2-4 only, in both.
    const next = 'X\r\nY\r\nZ\r\nW'
    source.feed(next)
    copy.feed(next)
    expectSameContent(copy, source)
    expect(copy.getText(0, 1)).toBe('top')
    const runs = copy.getLines(0, copy.length, PALETTE).flatMap((line) => line.runs)
    expect(runs.find((run) => run.text === 'W')?.fg).toBe(PALETTE.ansi[2])
  })

  it('writes CRLF only between logical lines and resets SGR before each line feed', () => {
    const source = mirror(6, 4)
    source.feed('\x1b[44mabcdefghi\x1b[0m\r\nnext')
    const snapshot = source.serialize()!
    const body = snapshot.slice(0, snapshot.indexOf('next') + 4)
    expect(body.match(/\r\n/g)).toHaveLength(1)
    expect(body).toContain('\x1b[0m\r\n')
  })
})

describe('real ConPTY bytes (trust dialog)', () => {
  const expected = [
    ' Accessing workspace:',
    ' Quick safety check: Is this a project you created or one you trust?',
    ' (Like your own code, a well-known open source project, or work from',
    ' Enter to confirm · Esc to cancel',
  ]

  it.each([120, 68])('keeps every space at %i columns', (cols) => {
    const source = mirror(cols, 32)
    source.feed(TRUST_DIALOG)
    const text = source.getText(0, source.length)
    for (const line of expected) expect(text).toContain(line)
    expect(text).toContain(' ❯ Yes, I trust this folder')
    expect(text).not.toMatch(/Accessingworkspace|Isthisproject/)
  })

  it.each([120, 68])('survives a serialize round trip at %i columns', (cols) => {
    const source = mirror(cols, 32)
    source.feed(TRUST_DIALOG)
    const copy = restore(source)
    expectSameContent(copy, source)
    for (const line of expected) expect(copy.getText(0, copy.length)).toContain(line)
  })
})
