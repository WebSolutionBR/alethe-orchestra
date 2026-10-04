import { describe, expect, it } from 'vitest'

import { sanitizeReplay, sliceReplayForRestore } from './terminalReplay'

const ESC = ''
const CLEAR = `${ESC}[2J`
const HOME = `${ESC}[H`
const RED = `${ESC}[31m`
const RESET_SGR = `${ESC}[0m`

describe('sliceReplayForRestore', () => {
  it('starts at the last screen clear, where the screen state is known', () => {
    // Restoring from an arbitrary cut replays cursor moves against a screen that
    // is not in the state they were recorded against, which paints text on top
    // of text. From a clear, every move that follows lands where it did.
    const raw = `old junk${CLEAR}${HOME}first frame${CLEAR}${HOME}last frame`
    expect(sliceReplayForRestore(raw)).toBe(`${CLEAR}${HOME}last frame`)
  })

  it('treats erasing the scrollback as an anchor too', () => {
    const raw = `noise${ESC}[3J${HOME}after`
    expect(sliceReplayForRestore(raw)).toBe(`${ESC}[3J${HOME}after`)
  })

  it('anchors on entering the alternate screen', () => {
    const raw = `noise${ESC}[?1049hpainted`
    expect(sliceReplayForRestore(raw)).toBe(`${ESC}[?1049hpainted`)
  })

  it('falls back to sanitizing when the tail carries no anchor', () => {
    const raw = `line one\n${ESC}[3Aline two`
    const out = sliceReplayForRestore(raw)
    expect(out).not.toContain(`${ESC}[3A`)
    expect(out).toContain('line one')
    expect(out).toContain('line two')
  })

  it('leaves an empty replay alone', () => {
    expect(sliceReplayForRestore('')).toBe('')
  })
})

describe('sanitizeReplay', () => {
  it('keeps colours, which carry meaning and move nothing', () => {
    expect(sanitizeReplay(`${RED}error${RESET_SGR}`)).toBe(`${RED}error${RESET_SGR}`)
  })

  it('drops cursor movement and erase sequences', () => {
    expect(sanitizeReplay(`a${ESC}[2Ab${ESC}[Kc${ESC}[10;5Hd`)).toBe('abcd')
  })

  it('drops OSC sequences such as the window title', () => {
    expect(sanitizeReplay(`${ESC}]0;a titletext`)).toBe('text')
    expect(sanitizeReplay(`${ESC}]8;;http://x${ESC}\\link`)).toBe('link')
  })

  it('collapses a line rewritten in place, the way a terminal shows it', () => {
    // A spinner repaints the same line with a carriage return. Without this the
    // history would list every frame it ever drew.
    expect(sanitizeReplay('working .\rworking ..\rworking ...\ndone')).toBe('working ...\ndone')
  })

  it('keeps ordinary line breaks', () => {
    expect(sanitizeReplay('one\ntwo\r\nthree')).toBe('one\ntwo\nthree')
  })

  it('drops two-character escapes that move the cursor', () => {
    expect(sanitizeReplay(`a${ESC}Mb${ESC}7c${ESC}8d`)).toBe('abcd')
  })
})
