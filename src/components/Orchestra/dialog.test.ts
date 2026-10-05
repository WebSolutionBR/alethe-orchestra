import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ screens: new Map<string, string[]>() }))

vi.mock('../../lib/terminalMirror', () => ({
  getMirror: (ptyId: string) => {
    const lines = mocks.screens.get(ptyId)
    return lines
      ? {
          baseY: 0,
          rows: lines.length,
          modes: { applicationCursorKeys: false },
          getText: () => lines.join('\n'),
        }
      : null
  },
}))

import { chooseOption, type DialogOption, readDialog } from './dialog'

/** A permission request as Claude Code draws it, framed, with long options wrapped. */
const framed = (focused: number) => [
  '╭────────────────────────────────────────────────╮',
  '│ Bash command                                   │',
  '│                                                │',
  '│   npm publish                                  │',
  '│                                                │',
  '│ Do you want to proceed?                        │',
  `│ ${focused === 1 ? '❯' : ' '} 1. Yes                                       │`,
  `│ ${focused === 2 ? '❯' : ' '} 2. Yes, and don't ask again for npm publish  │`,
  '│      commands in C:\\repo                      │',
  `│ ${focused === 3 ? '❯' : ' '} 3. No, and tell Claude what to do            │`,
  '│      differently (esc)                         │',
  '╰────────────────────────────────────────────────╯',
  '  Esc to cancel · Tab to amend',
]

const idlePrompt = [
  '● Here is the plan:',
  '  1. Read the failing test',
  '  2. Fix the parser',
  '',
  '╭──────────────────────────────╮',
  '│ >                            │',
  '╰──────────────────────────────╯',
  '  ? for shortcuts',
]

const trust = [
  ' Accessing workspace:',
  ' C:\\Users\\me\\new-project',
  '',
  ' Claude Code will be able to read, edit, and execute files here.',
  '',
  '  ❯ Yes, I trust this folder',
  '    No, exit',
  '',
  '  Enter to confirm · Esc to cancel',
]

const question = [
  ' Which database should the cache use?',
  '',
  ' ❯ 1. Redis',
  '      Fast, needs a server',
  '   2. SQLite',
  '      A file next to the app',
  '   3. Type something.',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel',
]

describe('readDialog', () => {
  it('reads a permission request: its question, its options and the one Esc picks', () => {
    expect(readDialog(framed(1))).toEqual({
      question: 'Do you want to proceed?',
      permission: true,
      options: [
        { index: 1, label: 'Yes', focused: true, deny: false },
        {
          index: 2,
          label: "Yes, and don't ask again for npm publish commands in C:\\repo",
          focused: false,
          deny: false,
        },
        {
          index: 3,
          label: 'No, and tell Claude what to do differently (esc)',
          focused: false,
          deny: true,
        },
      ],
    })
    expect(readDialog(framed(2))?.options.map((o) => o.focused)).toEqual([false, true, false])
  })

  it('sees no dialog on a prompt, even under a numbered list', () => {
    expect(readDialog(idlePrompt)).toBeNull()
    expect(readDialog([])).toBeNull()
  })

  it('knows a dialog it cannot answer: a select without numbers, a question with options', () => {
    expect(readDialog(trust)).toEqual({ question: '', options: [], permission: false })
    const asked = readDialog(question)
    expect(asked).toMatchObject({
      question: 'Which database should the cache use?',
      permission: false,
    })
    expect(asked?.options.map((o) => o.label)).toEqual([
      'Redis Fast, needs a server',
      'SQLite A file next to the app',
      'Type something.',
    ])
  })
})

describe('chooseOption', () => {
  const PTY = 'pty-dialog'
  afterEach(() => mocks.screens.clear())

  /** A fake terminal: arrows move the dialog's cursor, Enter and Esc close it. */
  function terminal(focused: number, opts: { ignoresArrows?: boolean } = {}) {
    let cursor = focused
    mocks.screens.set(PTY, framed(cursor))
    const pressed: string[] = []
    const press = (keys: string) => {
      pressed.push(keys)
      if (keys === '\x1b[B' && !opts.ignoresArrows) mocks.screens.set(PTY, framed(++cursor))
      else if (keys === '\x1b[A' && !opts.ignoresArrows) mocks.screens.set(PTY, framed(--cursor))
      else if (keys === '\r' || keys === '\x1b') mocks.screens.set(PTY, idlePrompt)
      return Promise.resolve()
    }
    return { pressed, press }
  }
  const option = (index: number): DialogOption => readDialog(framed(1))!.options[index - 1]

  it('moves the cursor to the option and presses Enter only once it is there', async () => {
    const { pressed, press } = terminal(1)
    await expect(chooseOption(PTY, option(2), press)).resolves.toBe(true)
    expect(pressed).toEqual(['\x1b[B', '\r'])
  })

  it('refuses with Esc alone', async () => {
    const { pressed, press } = terminal(2)
    await expect(chooseOption(PTY, option(3), press)).resolves.toBe(true)
    expect(pressed).toEqual(['\x1b'])
  })

  it('never presses Enter when the cursor does not reach the option', async () => {
    vi.useFakeTimers()
    try {
      const { pressed, press } = terminal(1, { ignoresArrows: true })
      const answer = chooseOption(PTY, option(2), press)
      await vi.advanceTimersByTimeAsync(5000)
      await expect(answer).resolves.toBe(false)
      expect(pressed).toEqual(['\x1b[B'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing once the request is gone or no longer offers that option', async () => {
    const pressed: string[] = []
    const press = (keys: string) => Promise.resolve(void pressed.push(keys))
    mocks.screens.set(PTY, idlePrompt)
    await expect(chooseOption(PTY, option(1), press)).resolves.toBe(false)
    mocks.screens.set(PTY, question)
    await expect(chooseOption(PTY, option(1), press)).resolves.toBe(false)
    expect(pressed).toEqual([])
  })
})
