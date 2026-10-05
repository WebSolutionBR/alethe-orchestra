import type { IBufferLine } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

import { AltScreenHistory, detectShift, type FrameRow } from './altScreen'

function row(text: string): FrameRow {
  const line = { isWrapped: false, length: text.length, translateToString: () => text }
  return { text, line: line as unknown as IBufferLine }
}

function frame(texts: string[]): FrameRow[] {
  return texts.map(row)
}

const FOOTER = ['────────', '❯ prompt', '────────']

/** A screen showing `count` conversation lines ending at `last`, padded on top, plus the footer. */
function screen(lines: string[], last: number, height = 8): string[] {
  const visible = lines.slice(Math.max(0, last - height), last)
  return [...Array(height - visible.length).fill(''), ...visible, ...FOOTER]
}

function texts(history: AltScreenHistory): string[] {
  return Array.from({ length: history.length }, (_, i) => history.textAt(i) ?? '')
}

const CONVERSATION = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, '0')}`)

describe('detectShift', () => {
  it('sees content moving up above a fixed footer', () => {
    expect(detectShift(screen(CONVERSATION, 20), screen(CONVERSATION, 22))).toBe(2)
    expect(detectShift(screen(CONVERSATION, 20), screen(CONVERSATION, 25))).toBe(5)
    // One row left in common is too thin to call it scrolling (capture treats it as a burst).
    expect(detectShift(screen(CONVERSATION, 20), screen(CONVERSATION, 27))).toBe(0)
  })

  it('sees content moving down', () => {
    expect(detectShift(screen(CONVERSATION, 20), screen(CONVERSATION, 17))).toBe(-3)
  })

  it('ignores rows redrawn in place and blank screens', () => {
    const before = screen(CONVERSATION, 20)
    const after = [...before]
    after[7] = 'line 19 and more text'
    expect(detectShift(before, after)).toBe(0)
    expect(detectShift(['', '', ''], ['', '', ''])).toBe(0)
  })
})

describe('AltScreenHistory', () => {
  it('keeps every row that scrolls out of the top, once and in order', () => {
    const history = new AltScreenHistory(1000)
    let last = 8
    history.capture(frame(screen(CONVERSATION, last)))
    for (const step of [1, 2, 3, 1, 1, 2, 3, 2, 1, 3, 2, 1, 2, 3, 1, 2]) {
      last = Math.min(CONVERSATION.length, last + step)
      history.capture(frame(screen(CONVERSATION, last)))
    }
    expect(last).toBe(38)
    expect(texts(history)).toEqual(CONVERSATION.slice(0, 30))
    history.flush()
    expect(texts(history)).toEqual([...CONVERSATION.slice(0, 38), ...FOOTER])
  })

  it('does not append twice what the program scrolled back into view', () => {
    const history = new AltScreenHistory(1000)
    history.capture(frame(screen(CONVERSATION, 20)))
    history.capture(frame(screen(CONVERSATION, 24)))
    expect(texts(history)).toEqual(CONVERSATION.slice(12, 16))
    // The program scrolls its own view up 3, then back down 3, then on by 2.
    history.capture(frame(screen(CONVERSATION, 21)))
    history.capture(frame(screen(CONVERSATION, 24)))
    history.capture(frame(screen(CONVERSATION, 26)))
    expect(texts(history)).toEqual(CONVERSATION.slice(12, 18))
  })

  it('recognizes a jump back to old content and does not copy it again on the way down', () => {
    const history = new AltScreenHistory(1000)
    let last = 8
    history.capture(frame(screen(CONVERSATION, last)))
    while (last < 36) {
      last += 2
      history.capture(frame(screen(CONVERSATION, last)))
    }
    const before = texts(history)
    // A page up: nothing in common with the last frame, all of it already in history.
    history.capture(frame(screen(CONVERSATION, 18)))
    for (const end of [20, 23, 27, 30, 33, 36]) history.capture(frame(screen(CONVERSATION, end)))
    expect(texts(history)).toEqual(before)
  })

  it('keeps the rows of a screen that new content replaced at once, without the footer', () => {
    const history = new AltScreenHistory(1000)
    history.capture(frame(screen(CONVERSATION, 8)))
    const fresh = Array.from({ length: 8 }, (_, i) => `new ${i}`)
    history.capture(frame([...fresh, ...FOOTER]))
    expect(texts(history)).toEqual(CONVERSATION.slice(0, 8))
  })

  it('leaves a sparse screen edited in place alone (a spinner under an empty conversation)', () => {
    const history = new AltScreenHistory(1000)
    const spinner = (seconds: number) => [
      '',
      '',
      '',
      `✻ Thinking… (${seconds}s)`,
      '',
      '',
      '',
      '',
      ...FOOTER,
    ]
    for (let s = 1; s < 30; s++) history.capture(frame(spinner(s)))
    expect(history.length).toBe(0)
  })

  it('follows a burst that pushed almost everything out', () => {
    const history = new AltScreenHistory(1000)
    history.capture(frame(screen(CONVERSATION, 10)))
    // Seven of the eight rows scrolled out in one frame; one still lines up at the top.
    history.capture(frame(screen(CONVERSATION, 17)))
    expect(texts(history)).toEqual(CONVERSATION.slice(2, 9))
  })

  it('flushes the screen minus the rows it already has, squeezing blank runs', () => {
    const history = new AltScreenHistory(1000)
    history.capture(frame(['a', '', '', 'b', '', '', '', '', ...FOOTER]))
    history.flush()
    expect(texts(history)).toEqual(['a', '', 'b', '', ...FOOTER])
    // After a flush the next frame starts over: nothing to compare it with.
    history.capture(frame(['c', '', '', '', '', '', '', '', ...FOOTER]))
    expect(history.length).toBe(7)
  })

  it('pays back a scroll up longer than a screen before appending again', () => {
    const history = new AltScreenHistory(1000)
    let last = 8
    history.capture(frame(screen(CONVERSATION, last)))
    while (last < 38) {
      last += 2
      history.capture(frame(screen(CONVERSATION, last)))
    }
    const before = texts(history)
    // The program scrolls its view up 3 rows at a time, 18 rows in all, then all the way back.
    for (let end = 35; end >= 20; end -= 3) history.capture(frame(screen(CONVERSATION, end)))
    for (let end = 23; end <= 38; end += 3) history.capture(frame(screen(CONVERSATION, end)))
    expect(texts(history)).toEqual(before)
  })

  it('drops the oldest rows past its cap and counts them', () => {
    const history = new AltScreenHistory(5)
    history.capture(frame(screen(CONVERSATION, 8)))
    history.capture(frame(screen(CONVERSATION, 16)))
    history.capture(frame(screen(CONVERSATION, 18)))
    expect(texts(history)).toEqual(CONVERSATION.slice(5, 10))
    expect(history.dropped).toBe(5)
  })

  it('across a resize to a taller screen, does not copy again what it shows of the history', () => {
    const history = new AltScreenHistory(1000)
    history.capture(frame(screen(CONVERSATION, 8)))
    history.capture(frame(screen(CONVERSATION, 14)))
    expect(texts(history)).toEqual(CONVERSATION.slice(0, 6))
    history.resizing()
    // 12 rows now: lines 02-13 visible, 02-05 of them already in history.
    history.capture(frame(screen(CONVERSATION, 14, 12)))
    history.capture(frame(screen(CONVERSATION, 20, 12)))
    expect(texts(history)).toEqual(CONVERSATION.slice(0, 8))
  })

  it('across a resize to a narrower screen, matches the content as it re-wraps', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, '0')}`)
    const wide = (from: number) => [
      ...Array.from({ length: 8 }, (_, r) =>
        words.slice((from + r) * 2, (from + r) * 2 + 2).join(' '),
      ),
      ...FOOTER,
    ]
    const history = new AltScreenHistory(1000)
    history.capture(frame(wide(0)))
    history.capture(frame(wide(3)))
    expect(texts(history)).toEqual(['word00 word01', 'word02 word03', 'word04 word05'])
    history.resizing()
    // One word per row now: the screen shows word09 onward; word06-08 were pushed out by the resize.
    const narrow = [...words.slice(9, 17), ...FOOTER]
    history.capture(frame(narrow))
    expect(texts(history)).toEqual([
      'word00 word01',
      'word02 word03',
      'word04 word05',
      'word06 word07',
      'word08 word09',
    ])
  })

  it('does not compare frames across a restart', () => {
    const history = new AltScreenHistory(1000)
    history.capture(frame(screen(CONVERSATION, 10)))
    history.restart()
    history.capture(frame(screen(CONVERSATION, 14)))
    expect(history.length).toBe(0)
    history.capture(frame(screen(CONVERSATION, 15)))
    expect(texts(history)).toEqual(['line 06'])
  })
})
