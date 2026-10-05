import { describe, expect, it } from 'vitest'

import { isMenuKey, rightClickAction } from './pointerMenu'

const base = { shiftKey: false, hasSelection: false, overLink: false, readOnly: false }

describe('rightClickAction (parity with the classic terminal and Windows Terminal)', () => {
  it('copies when there is a selection', () => {
    expect(rightClickAction({ ...base, hasSelection: true })).toBe('copy')
    expect(rightClickAction({ ...base, hasSelection: true, overLink: true })).toBe('copy')
  })

  it('pastes when there is no selection', () => {
    expect(rightClickAction(base)).toBe('paste')
  })

  it('opens the link menu over a link', () => {
    expect(rightClickAction({ ...base, overLink: true })).toBe('linkMenu')
  })

  it('opens the full menu with Shift, whatever is under the pointer', () => {
    expect(rightClickAction({ ...base, shiftKey: true })).toBe('fullMenu')
    expect(rightClickAction({ ...base, shiftKey: true, hasSelection: true, overLink: true })).toBe(
      'fullMenu',
    )
  })

  it('offers the menu instead of a paste that cannot happen', () => {
    expect(rightClickAction({ ...base, readOnly: true })).toBe('fullMenu')
    expect(rightClickAction({ ...base, readOnly: true, hasSelection: true })).toBe('copy')
  })
})

describe('isMenuKey', () => {
  const key = (
    k: string,
    mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
  ) => ({
    key: k,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  })

  it('accepts the Menu key and Shift+F10 only', () => {
    expect(isMenuKey(key('ContextMenu'))).toBe(true)
    expect(isMenuKey(key('F10', { shiftKey: true }))).toBe(true)
    expect(isMenuKey(key('F10'))).toBe(false)
    expect(isMenuKey(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
  })
})
