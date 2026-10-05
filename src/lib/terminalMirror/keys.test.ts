import { describe, expect, it } from 'vitest'

import { encodeKey, encodeWheel } from './keys'
import type { KeyLike, MirrorModes } from './types'

type Mods = Partial<Pick<KeyLike, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>>

function key(name: string, mods: Mods = {}): KeyLike {
  return { key: name, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }
}

const NORMAL = { applicationCursorKeys: false }
const APP_CURSOR = { applicationCursorKeys: true }

describe('encodeKey', () => {
  const table: Array<[string, KeyLike, string | null]> = [
    // Printable text, shifted characters, astral characters.
    ['letter', key('a'), 'a'],
    ['shifted letter', key('A', { shiftKey: true }), 'A'],
    ['symbol', key('!', { shiftKey: true }), '!'],
    ['space', key(' '), ' '],
    ['accented', key('ç'), 'ç'],
    ['emoji', key('😀'), '😀'],
    // Editing keys.
    ['Enter', key('Enter'), '\r'],
    ['Shift+Enter', key('Enter', { shiftKey: true }), '\r'],
    ['Alt+Enter', key('Enter', { altKey: true }), '\x1b\r'],
    ['Backspace', key('Backspace'), '\x7f'],
    ['Ctrl+Backspace', key('Backspace', { ctrlKey: true }), '\b'],
    ['Alt+Backspace', key('Backspace', { altKey: true }), '\x1b\x7f'],
    ['Tab', key('Tab'), '\t'],
    ['Shift+Tab', key('Tab', { shiftKey: true }), '\x1b[Z'],
    ['Ctrl+Tab (host)', key('Tab', { ctrlKey: true }), null],
    ['Escape', key('Escape'), '\x1b'],
    ['Alt+Escape', key('Escape', { altKey: true }), '\x1b\x1b'],
    // Arrows and navigation.
    ['ArrowUp', key('ArrowUp'), '\x1b[A'],
    ['ArrowDown', key('ArrowDown'), '\x1b[B'],
    ['ArrowRight', key('ArrowRight'), '\x1b[C'],
    ['ArrowLeft', key('ArrowLeft'), '\x1b[D'],
    ['Shift+ArrowUp', key('ArrowUp', { shiftKey: true }), '\x1b[1;2A'],
    ['Ctrl+ArrowLeft', key('ArrowLeft', { ctrlKey: true }), '\x1b[1;5D'],
    ['Alt+ArrowLeft acts as Ctrl', key('ArrowLeft', { altKey: true }), '\x1b[1;5D'],
    ['Ctrl+Shift+ArrowRight', key('ArrowRight', { ctrlKey: true, shiftKey: true }), '\x1b[1;6C'],
    ['Home', key('Home'), '\x1b[H'],
    ['End', key('End'), '\x1b[F'],
    ['Ctrl+Home', key('Home', { ctrlKey: true }), '\x1b[1;5H'],
    ['Shift+End', key('End', { shiftKey: true }), '\x1b[1;2F'],
    ['Insert', key('Insert'), '\x1b[2~'],
    ['Shift+Insert (paste)', key('Insert', { shiftKey: true }), null],
    ['Ctrl+Insert (copy)', key('Insert', { ctrlKey: true }), null],
    ['Delete', key('Delete'), '\x1b[3~'],
    ['Ctrl+Delete', key('Delete', { ctrlKey: true }), '\x1b[3;5~'],
    ['PageUp', key('PageUp'), '\x1b[5~'],
    ['PageDown', key('PageDown'), '\x1b[6~'],
    ['Ctrl+PageUp', key('PageUp', { ctrlKey: true }), '\x1b[5;5~'],
    ['Shift+PageUp (host scroll)', key('PageUp', { shiftKey: true }), null],
    ['Shift+PageDown (host scroll)', key('PageDown', { shiftKey: true }), null],
    // Function keys.
    ['F1', key('F1'), '\x1bOP'],
    ['F4', key('F4'), '\x1bOS'],
    ['Shift+F1', key('F1', { shiftKey: true }), '\x1b[1;2P'],
    ['F5', key('F5'), '\x1b[15~'],
    ['F6', key('F6'), '\x1b[17~'],
    ['F10', key('F10'), '\x1b[21~'],
    ['F11', key('F11'), '\x1b[23~'],
    ['F12', key('F12'), '\x1b[24~'],
    ['Ctrl+F5', key('F5', { ctrlKey: true }), '\x1b[15;5~'],
    // Control characters.
    ['Ctrl+A', key('a', { ctrlKey: true }), '\x01'],
    ['Ctrl+C', key('c', { ctrlKey: true }), '\x03'],
    ['Ctrl+V', key('v', { ctrlKey: true }), '\x16'],
    ['Ctrl+Z', key('z', { ctrlKey: true }), '\x1a'],
    ['Ctrl+letter on a Cyrillic layout', key('ф', { ctrlKey: true, code: 'KeyA' }), '\x01'],
    ['Ctrl+Space', key(' ', { ctrlKey: true }), '\x00'],
    ['Ctrl+@', key('@', { ctrlKey: true, shiftKey: true }), '\x00'],
    ['Ctrl+[', key('[', { ctrlKey: true }), '\x1b'],
    ['Ctrl+\\', key('\\', { ctrlKey: true }), '\x1c'],
    ['Ctrl+]', key(']', { ctrlKey: true }), '\x1d'],
    ['Ctrl+^', key('^', { ctrlKey: true, shiftKey: true }), '\x1e'],
    ['Ctrl+/', key('/', { ctrlKey: true }), '\x1f'],
    ['Ctrl+] by physical key', key('´', { ctrlKey: true, code: 'BracketRight' }), '\x1d'],
    ['Ctrl+1 (nothing)', key('1', { ctrlKey: true }), null],
    ['Ctrl+Shift+C (host copy)', key('C', { ctrlKey: true, shiftKey: true }), null],
    ['Ctrl+Shift+V (host paste)', key('V', { ctrlKey: true, shiftKey: true }), null],
    // The app's own chords, exactly as XTermView keeps them.
    ['Ctrl+B (sidebar)', key('b', { ctrlKey: true }), null],
    ['Ctrl+= (zoom)', key('=', { ctrlKey: true }), null],
    ['Ctrl+- (zoom)', key('-', { ctrlKey: true }), null],
    ['Ctrl+0 (zoom)', key('0', { ctrlKey: true }), null],
    ['Ctrl+NumpadAdd (zoom)', key('+', { ctrlKey: true, code: 'NumpadAdd' }), null],
    // Alt as meta.
    ['Alt+x', key('x', { altKey: true }), '\x1bx'],
    ['Alt+Shift+X', key('X', { altKey: true, shiftKey: true }), '\x1bX'],
    ['Alt+.', key('.', { altKey: true }), '\x1b.'],
    ['Alt+dead key', key('Dead', { altKey: true, code: 'KeyN' }), '\x1bn'],
    ['Ctrl+Alt+A', key('a', { ctrlKey: true, altKey: true }), '\x1b\x01'],
    ['AltGr character (Ctrl+Alt on Windows)', key('@', { ctrlKey: true, altKey: true }), '@'],
    ['AltGr+E (°)', key('°', { ctrlKey: true, altKey: true }), '°'],
    // Not terminal keys.
    ['Meta chord', key('a', { metaKey: true }), null],
    ['Shift alone', key('Shift', { shiftKey: true }), null],
    ['Control alone', key('Control', { ctrlKey: true }), null],
    ['dead key', key('Dead'), null],
    ['IME', key('Process'), null],
    ['unidentified', key('Unidentified'), null],
    ['CapsLock', key('CapsLock'), null],
  ]

  it.each(table)('%s', (_name, event, expected) => {
    expect(encodeKey(event, NORMAL)).toBe(expected)
  })

  it('uses SS3 for unmodified cursor keys in application cursor mode', () => {
    expect(encodeKey(key('ArrowUp'), APP_CURSOR)).toBe('\x1bOA')
    expect(encodeKey(key('ArrowLeft'), APP_CURSOR)).toBe('\x1bOD')
    expect(encodeKey(key('Home'), APP_CURSOR)).toBe('\x1bOH')
    expect(encodeKey(key('End'), APP_CURSOR)).toBe('\x1bOF')
    expect(encodeKey(key('ArrowUp', { ctrlKey: true }), APP_CURSOR)).toBe('\x1b[1;5A')
  })
})

describe('encodeWheel', () => {
  const base: MirrorModes = {
    applicationCursorKeys: false,
    bracketedPaste: false,
    mouseTracking: 'none',
  }

  it('sends one SGR wheel report per call, 1-based', () => {
    const modes: MirrorModes = { ...base, mouseTracking: 'any', mouseEncoding: 'sgr' }
    expect(encodeWheel(-3, modes, { col: 4, row: 2 })).toBe('\x1b[<64;5;3M')
    expect(encodeWheel(1, modes, { col: 0, row: 0 })).toBe('\x1b[<65;1;1M')
    expect(encodeWheel(2, { ...modes, mouseTracking: 'vt200' }, { col: 300, row: 90 })).toBe(
      '\x1b[<65;301;91M',
    )
  })

  it('falls back to the X10 byte encoding, within its range', () => {
    const modes: MirrorModes = { ...base, mouseTracking: 'drag' }
    expect(encodeWheel(-1, modes, { col: 4, row: 2 })).toBe(
      `\x1b[M${String.fromCharCode(96, 37, 35)}`,
    )
    expect(encodeWheel(1, { ...modes, mouseEncoding: 'default' }, { col: 0, row: 0 })).toBe(
      `\x1b[M${String.fromCharCode(97, 33, 33)}`,
    )
    expect(encodeWheel(1, modes, { col: 300, row: 0 })).toBe('')
  })

  it('sends arrows when the program does not track the wheel', () => {
    expect(encodeWheel(-3, base, { col: 0, row: 0 })).toBe('\x1b[A\x1b[A\x1b[A')
    expect(encodeWheel(2, base, { col: 0, row: 0 })).toBe('\x1b[B\x1b[B')
    expect(encodeWheel(2, { ...base, applicationCursorKeys: true }, { col: 0, row: 0 })).toBe(
      '\x1bOB\x1bOB',
    )
    // X10 tracking never reports the wheel.
    expect(
      encodeWheel(-1, { ...base, mouseTracking: 'x10', mouseEncoding: 'sgr' }, { col: 0, row: 0 }),
    ).toBe('\x1b[A')
    expect(encodeWheel(0, { ...base, mouseTracking: 'any' }, { col: 0, row: 0 })).toBe('')
    expect(encodeWheel(0.4, base, { col: 0, row: 0 })).toBe('')
  })
})
