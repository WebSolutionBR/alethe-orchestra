import { describe, expect, it } from 'vitest'

import { seedReplay } from './seed'

describe('seedReplay', () => {
  it('replays from the last screen clear, keeping the private modes set before it', () => {
    const raw =
      'old frame\x1b[?2004h\x1b[?1049h\x1b[2Jfirst\x1b[?25l more\x1b[?1006h\x1b[2J\x1b[Hlatest frame'
    expect(seedReplay(raw)).toBe(
      '\x1b[?2004h\x1b[?1049h\x1b[?25l\x1b[?1006h\x1b[2J\x1b[Hlatest frame',
    )
  })

  it('treats entering the alternate screen and clearing the scrollback as anchors', () => {
    expect(seedReplay('junk\x1b[?1000h\x1b[?1049hTUI')).toBe('\x1b[?1000h\x1b[?1049hTUI')
    expect(seedReplay('junk\x1b[3J\x1b[Hafter')).toBe('\x1b[3J\x1b[Hafter')
  })

  it('replays the recording raw when it has no anchor, keeping CHA-encoded spaces', () => {
    const raw = '\x1b[2GAccessing\x1b[12Gworkspace:\r\n'
    expect(seedReplay(raw)).toBe(raw)
    expect(seedReplay('\x1b[2Jfrom the start')).toBe('\x1b[2Jfrom the start')
    expect(seedReplay('')).toBe('')
  })
})
