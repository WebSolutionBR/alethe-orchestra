import { describe, expect, it } from 'vitest'

import type { OrchestraAgent } from '../../../stores/orchestraStore'
import { paneForShortcut, paneShortcutDigit, shortcutForPane } from './paneShortcuts'

const agents = ['orchestrator', 'claude-1', 'claude-2', 'claude-3'].map(
  (id) => ({ id }) as OrchestraAgent,
)

const chord = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
  code,
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('pane shortcuts', () => {
  it('reads the digit from the physical key, whatever symbol Shift produced', () => {
    expect(paneShortcutDigit(chord('Digit1'))).toBe(1)
    expect(paneShortcutDigit(chord('Digit0'))).toBe(0)
    expect(paneShortcutDigit(chord('Digit9', { ctrlKey: false, metaKey: true }))).toBe(9)
  })

  it('leaves every other chord alone', () => {
    // Ctrl+1..9 without Shift belongs to the app; Alt and the numpad are not this shortcut.
    expect(paneShortcutDigit(chord('Digit1', { shiftKey: false }))).toBeNull()
    expect(paneShortcutDigit(chord('Digit1', { ctrlKey: false }))).toBeNull()
    expect(paneShortcutDigit(chord('Digit1', { altKey: true }))).toBeNull()
    expect(paneShortcutDigit(chord('Numpad1'))).toBeNull()
    expect(paneShortcutDigit(chord('KeyL'))).toBeNull()
  })

  it('maps 0 to the orchestrator and 1..9 to the workers in grid order', () => {
    expect(paneForShortcut(agents, 0)).toBe('orchestrator')
    expect(paneForShortcut(agents, 1)).toBe('claude-1')
    expect(paneForShortcut(agents, 3)).toBe('claude-3')
    expect(paneForShortcut(agents, 4)).toBeNull()
    expect(paneForShortcut([], 0)).toBeNull()
  })

  it('names the shortcut of each pane, and none past the ninth worker', () => {
    const many = [
      { id: 'orchestrator' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `claude-${i + 1}` })),
    ] as OrchestraAgent[]
    expect(shortcutForPane(many, 'orchestrator')).toBe(0)
    expect(shortcutForPane(many, 'claude-1')).toBe(1)
    expect(shortcutForPane(many, 'claude-9')).toBe(9)
    expect(shortcutForPane(many, 'claude-10')).toBeNull()
    expect(shortcutForPane(many, 'nobody')).toBeNull()
  })
})
