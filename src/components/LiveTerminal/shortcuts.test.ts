import { describe, expect, it } from 'vitest'

import { classifyKey, isPrintableKey, type KeyEventLike } from './shortcuts'

function key(value: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: value,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  }
}

describe('classifyKey', () => {
  it('copies with Ctrl+C only when something is selected', () => {
    expect(classifyKey(key('c', { ctrlKey: true }), true)).toEqual({ kind: 'copy' })
    expect(classifyKey(key('c', { ctrlKey: true }), false)).toEqual({ kind: 'terminal' })
  })

  it('always treats Ctrl+Shift+C and Ctrl+Insert as copy', () => {
    expect(classifyKey(key('C', { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: 'copy',
    })
    expect(classifyKey(key('Insert', { ctrlKey: true }), false)).toEqual({ kind: 'copy' })
  })

  it('pastes with Ctrl+V, Ctrl+Shift+V and Shift+Insert', () => {
    expect(classifyKey(key('v', { ctrlKey: true }), false)).toEqual({ kind: 'paste' })
    expect(classifyKey(key('V', { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: 'paste',
    })
    expect(classifyKey(key('Insert', { shiftKey: true }), false)).toEqual({ kind: 'paste' })
  })

  it('opens the search with Ctrl+F', () => {
    expect(classifyKey(key('f', { ctrlKey: true }), false)).toEqual({ kind: 'find' })
  })

  it('scrolls with Shift+PageUp/PageDown and Ctrl+Home/End', () => {
    expect(classifyKey(key('PageUp', { shiftKey: true }), false)).toEqual({
      kind: 'scroll',
      to: 'pageUp',
    })
    expect(classifyKey(key('PageDown', { shiftKey: true }), false)).toEqual({
      kind: 'scroll',
      to: 'pageDown',
    })
    expect(classifyKey(key('Home', { ctrlKey: true }), false)).toEqual({
      kind: 'scroll',
      to: 'top',
    })
    expect(classifyKey(key('End', { ctrlKey: true }), false)).toEqual({
      kind: 'scroll',
      to: 'bottom',
    })
    // Plain PageUp belongs to the program (pagers, editors).
    expect(classifyKey(key('PageUp'), false)).toEqual({ kind: 'terminal' })
  })

  it('leaves the app zoom and sidebar shortcuts alone', () => {
    expect(classifyKey(key('=', { ctrlKey: true }), false)).toEqual({ kind: 'app' })
    expect(classifyKey(key('-', { ctrlKey: true }), false)).toEqual({ kind: 'app' })
    expect(classifyKey(key('0', { ctrlKey: true }), false)).toEqual({ kind: 'app' })
    expect(classifyKey(key('b', { ctrlKey: true }), false)).toEqual({ kind: 'app' })
  })

  it('lets printable keys reach the input event (IME, dead keys)', () => {
    expect(classifyKey(key('a'), false)).toEqual({ kind: 'text' })
    expect(classifyKey(key('A', { shiftKey: true }), false)).toEqual({ kind: 'text' })
    expect(classifyKey(key(' '), false)).toEqual({ kind: 'text' })
    expect(classifyKey(key('ç'), false)).toEqual({ kind: 'text' })
  })

  it('treats AltGr characters as text', () => {
    expect(classifyKey(key('/', { ctrlKey: true, altKey: true, altGraph: true }), false)).toEqual({
      kind: 'text',
    })
    // Without the modifier state, Ctrl+Alt with a symbol is taken as AltGr...
    expect(classifyKey(key('@', { ctrlKey: true, altKey: true }), false)).toEqual({ kind: 'text' })
    // ...but Ctrl+Alt+letter stays a terminal chord.
    expect(classifyKey(key('t', { ctrlKey: true, altKey: true }), false)).toEqual({
      kind: 'terminal',
    })
    expect(classifyKey(key('@', { ctrlKey: true, altKey: true, altGraph: false }), false)).toEqual({
      kind: 'terminal',
    })
  })

  it('sends everything else to encodeKey', () => {
    for (const name of ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'F5']) {
      expect(classifyKey(key(name), false)).toEqual({ kind: 'terminal' })
    }
    expect(classifyKey(key('Tab', { shiftKey: true }), false)).toEqual({ kind: 'terminal' })
    expect(classifyKey(key('x', { altKey: true }), false)).toEqual({ kind: 'terminal' })
    expect(classifyKey(key('l', { ctrlKey: true }), false)).toEqual({ kind: 'terminal' })
  })

  it('opens the menu with the Menu key and Shift+F10', () => {
    expect(classifyKey(key('ContextMenu'), false)).toEqual({ kind: 'menu' })
    expect(classifyKey(key('F10', { shiftKey: true }), false)).toEqual({ kind: 'menu' })
  })
})

describe('isPrintableKey', () => {
  it('accepts one character and rejects key names', () => {
    expect(isPrintableKey('a')).toBe(true)
    expect(isPrintableKey('😀')).toBe(true)
    expect(isPrintableKey('Enter')).toBe(false)
    expect(isPrintableKey('Dead')).toBe(false)
    expect(isPrintableKey('')).toBe(false)
  })
})
