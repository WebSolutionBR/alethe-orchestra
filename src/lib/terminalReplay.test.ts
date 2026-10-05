import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // xterm probes a 2D canvas when its module loads; jsdom has none and logs an error for it.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

import {
  findReplayAnchor,
  findSafeStart,
  isReplayTailCut,
  prepareReplayForRestore,
  replayModesPreamble,
  scanReplayModes,
} from './terminalReplay'

const ESC = '\x1b'
const CLEAR = `${ESC}[2J`
const HOME = `${ESC}[H`
const ALT_ON = `${ESC}[?1049h`
const ALT_OFF = `${ESC}[?1049l`

/**
 * The opening of Claude Code's trust dialog exactly as ConPTY recorded it at 70
 * columns: every run of spaces between words is a CHA (`CSI n G`), not a space.
 */
const CONPTY_DIALOG =
  `${ESC}[?2004h\r\n${ESC}[38;2;255;193;7m${'─'.repeat(70)}${ESC}[39m\r\n` +
  `${ESC}[2G${ESC}[38;2;255;193;7m${ESC}[1mAccessing${ESC}[12Gworkspace:${ESC}[22m${ESC}[39m\r\n\r\n` +
  `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs${ESC}[25Gthis${ESC}[30Ga` +
  `${ESC}[32Gproject${ESC}[40Gyou${ESC}[44Gcreated${ESC}[52Gor${ESC}[55Gone${ESC}[59Gyou` +
  `${ESC}[63Gtrust?\r\n\r\n${ESC}[2G${ESC}[38;2;153;153;153mSecurity${ESC}[11Gguide${ESC}[39m\r\n`

/** A full-screen agent: alternate screen, mouse tracking and bracketed paste, then frames. */
const FULLSCREEN_AGENT =
  `${ESC}[?2004h${ESC}[?1004h${ALT_ON}${CLEAR}${HOME}${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h` +
  `${ESC}[?1006h${ESC}[?25lfirst frame${ESC}[?25h${ESC}[?25l${CLEAR}${HOME}\r${ESC}[1Blast${ESC}[6Gframe`

function replayInto(cols: number, rows: number, data: string): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 })
  return new Promise((resolve) => terminal.write(data, () => resolve(terminal)))
}

function screenText(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const text = buffer.getLine(y)?.translateToString(true) ?? ''
    if (text.trim()) lines.push(text)
  }
  return lines
}

describe('prepareReplayForRestore', () => {
  it('starts at the last screen clear, where the screen state is known', () => {
    // Restoring from an arbitrary cut replays cursor moves against a screen that
    // is not in the state they were recorded against, which paints text on top
    // of text. From a clear, every move that follows lands where it did.
    const raw = `${ESC}[0mold junk${CLEAR}${HOME}first frame${CLEAR}${HOME}last frame`
    expect(prepareReplayForRestore(raw)).toBe(`${CLEAR}${HOME}last frame`)
  })

  it('treats erasing the scrollback, a full reset and entering the alternate screen as anchors', () => {
    expect(prepareReplayForRestore(`${ESC}[0mnoise${ESC}[3J${HOME}after`)).toBe(
      `${ESC}[3J${HOME}after`,
    )
    expect(prepareReplayForRestore(`${ESC}[0mnoise${ESC}cafter`)).toBe(`${ESC}cafter`)
    expect(prepareReplayForRestore(`${ESC}[0mnoise${ALT_ON}painted`)).toBe(`${ALT_ON}painted`)
  })

  it('keeps the cursor moves ConPTY uses in place of spaces', () => {
    // Stripping them to "text only" is what glued every word of the trust dialog
    // together ("Accessingworkspace:") and stair-stepped its lines to the right.
    const out = prepareReplayForRestore(CONPTY_DIALOG)
    expect(out).toBe(CONPTY_DIALOG)
    expect(out).toContain(`Accessing${ESC}[12Gworkspace:`)
  })

  it('restores the dialog with its spaces when replayed at the PTY width', async () => {
    const terminal = await replayInto(70, 32, prepareReplayForRestore(CONPTY_DIALOG))
    const lines = screenText(terminal)
    expect(lines).toContain(' Accessing workspace:')
    expect(lines).toContain(' Quick safety check: Is this a project you created or one you trust?')
    expect(lines).toContain(' Security guide')
    terminal.dispose()
  })

  it('re-enters the alternate screen and the modes a full-screen agent set before its last clear', async () => {
    // Anchoring on that clear alone dropped the ?1049h, so the restored view sat in
    // the normal buffer and took the wheel for itself: the agent could never scroll.
    const out = prepareReplayForRestore(FULLSCREEN_AGENT)
    expect(out.startsWith(ALT_ON)).toBe(true)
    expect(out).toContain(`${ESC}[?2004h`)
    expect(out).toContain(`${ESC}[?1003h`)
    expect(out).toContain(`${ESC}[?1006h`)
    expect(out.endsWith(`${CLEAR}${HOME}\r${ESC}[1Blast${ESC}[6Gframe`)).toBe(true)

    const terminal = await replayInto(40, 10, out)
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.modes.mouseTrackingMode).toBe('any')
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(screenText(terminal)).toEqual(['last frame'])
    terminal.dispose()
  })

  it('stays in the normal buffer once the program left the alternate screen', () => {
    const raw = `${ESC}[0m${ALT_ON}${CLEAR}tui${ALT_OFF}${ESC}[?1000l$ prompt${CLEAR}after`
    const out = prepareReplayForRestore(raw)
    expect(out).toBe(`${CLEAR}after`)
  })

  it('starts a cut tail at its first clean parse point', () => {
    // The tail is cut on a byte count: parameters of a sequence cut in half would
    // print as text at the top of the history.
    expect(prepareReplayForRestore(`;193;7mtext${ESC}[1mbold`)).toBe(`${ESC}[1mbold`)
    expect(prepareReplayForRestore('tail of a line\nnext line')).toBe('next line')
  })

  it('keeps the first line of a recording that was not cut', () => {
    expect(prepareReplayForRestore('user@host:~$ ls\r\nfile', { cut: false })).toBe(
      'user@host:~$ ls\r\nfile',
    )
  })

  it('leaves an empty replay alone', () => {
    expect(prepareReplayForRestore('')).toBe('')
  })
})

describe('findReplayAnchor', () => {
  it('returns the last anchor of any kind, or -1', () => {
    expect(findReplayAnchor('no anchor here')).toBe(-1)
    expect(findReplayAnchor(`a${CLEAR}b${ALT_ON}c`)).toBe(2 + CLEAR.length)
  })
})

describe('isReplayTailCut', () => {
  it('tells a whole recording from a tail cut at the byte limit', () => {
    expect(isReplayTailCut('short', 1024)).toBe(false)
    expect(isReplayTailCut('x'.repeat(1024), 1024)).toBe(true)
    // Moved forward to a character boundary: up to three bytes short of the limit.
    expect(isReplayTailCut('x'.repeat(1021), 1024)).toBe(true)
    // Counted in UTF-8 bytes, like the backend: '─' is three of them.
    expect(isReplayTailCut('─'.repeat(342), 1024)).toBe(true)
  })
})

describe('findSafeStart', () => {
  it('keeps a stream that starts on a sequence', () => {
    expect(findSafeStart(`${ESC}[?9001htext`)).toBe(0)
  })

  it('gives up on a tail with no escape or line break near its start', () => {
    expect(findSafeStart('plain text')).toBe(0)
  })
})

describe('scanReplayModes', () => {
  it('lets the last mouse protocol win and a reset turn tracking off', () => {
    const on = scanReplayModes(`${ESC}[?1003h${ESC}[?1000h`, 100)
    expect(on.mouseProtocol).toBe(1000)
    const off = scanReplayModes(`${ESC}[?1003h${ESC}[?1006h${ESC}[?1000l`, 100)
    expect(off.mouseProtocol).toBeNull()
    expect(off.mouseEncoding).toBe(1006)
  })

  it('reads combined parameters and forgets everything before a full reset', () => {
    expect(scanReplayModes(`${ESC}[?1;2004h`, 100).switches).toEqual(
      new Map([
        [1, true],
        [2004, true],
      ]),
    )
    const afterReset = scanReplayModes(`${ESC}[?2004h${ALT_ON}${ESC}cplain`, 100)
    expect(afterReset.altScreen).toBe(false)
    expect(afterReset.switches.size).toBe(0)
  })

  it('only looks at what came before the replay start', () => {
    const raw = `${ESC}[?2004hx${ESC}[?2004l`
    expect(scanReplayModes(raw, raw.indexOf('x')).switches.get(2004)).toBe(true)
  })

  it('keeps the scroll margins of the buffer that is active', () => {
    expect(scanReplayModes(`${ESC}[3;20r${ALT_ON}`, 100).scrollRegion).toBeNull()
    expect(scanReplayModes(`${ALT_ON}${ESC}[3;20r`, 100).scrollRegion).toBe('3;20')
    expect(scanReplayModes(`${ESC}[3;20r${ESC}[r`, 100).scrollRegion).toBeNull()
  })
})

describe('replayModesPreamble', () => {
  it('writes only what differs from a freshly reset terminal', () => {
    expect(
      replayModesPreamble({
        altScreen: false,
        mouseProtocol: null,
        mouseEncoding: null,
        switches: new Map([
          [7, true],
          [25, false],
          [2004, true],
        ]),
        scrollRegion: null,
      }),
    ).toBe(`${ESC}[?25l${ESC}[?2004h`)
  })
})
