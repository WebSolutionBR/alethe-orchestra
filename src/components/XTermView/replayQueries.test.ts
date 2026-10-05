import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // xterm probes a 2D canvas when its module loads; jsdom has none and logs an error for it.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

import { isFocusReport, swallowReplayedQueries } from './replayQueries'

const ESC = '\x1b'

/** What xterm sends back to the PTY while parsing `data`. */
async function answersTo(
  data: string,
  replaying: boolean,
): Promise<{ sent: string; terminal: Terminal }> {
  const terminal = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
  swallowReplayedQueries(terminal, () => replaying)
  const sent: string[] = []
  terminal.onData((chunk) => sent.push(chunk))
  await new Promise<void>((resolve) => terminal.write(data, resolve))
  return { sent: sent.join(''), terminal }
}

describe('swallowReplayedQueries', () => {
  it('lets a live program get its answers', async () => {
    const attributes = await answersTo(`${ESC}[c`, false)
    expect(attributes.sent).toBe(`${ESC}[?1;2c`)
    const cursor = await answersTo(`${ESC}[6n`, false)
    expect(cursor.sent).toBe(`${ESC}[1;1R`)
    attributes.terminal.dispose()
    cursor.terminal.dispose()
  })

  it('answers none of the queries a replayed history carries', async () => {
    // Re-answering them typed "[?1;2c" and friends into the agent every time its
    // terminal was reopened.
    const queries = [
      `${ESC}[c`,
      `${ESC}[0c`,
      `${ESC}[>c`,
      `${ESC}[=c`,
      `${ESC}[>0q`,
      `${ESC}[5n`,
      `${ESC}[6n`,
      `${ESC}[?6n`,
      `${ESC}[?2004$p`,
      `${ESC}[4$p`,
      `${ESC}P$qm${ESC}\\`,
      `${ESC}]10;?${ESC}\\`,
      `${ESC}]11;?\x07`,
      `${ESC}]4;1;?\x07`,
    ]
    const { sent, terminal } = await answersTo(queries.join(''), true)
    expect(sent).toBe('')
    terminal.dispose()
  })

  it('still applies everything a replay sets', async () => {
    const { terminal } = await answersTo(`${ESC}[?2004h${ESC}[?1h`, true)
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(terminal.modes.applicationCursorKeysMode).toBe(true)
    terminal.dispose()
  })
})

describe('isFocusReport', () => {
  it('recognises focus in and focus out, and nothing a key produces', () => {
    expect(isFocusReport(`${ESC}[I`)).toBe(true)
    expect(isFocusReport(`${ESC}[O`)).toBe(true)
    expect(isFocusReport(`${ESC}OA`)).toBe(false)
    expect(isFocusReport('I')).toBe(false)
  })
})
