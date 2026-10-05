/**
 * Right-click behaves like the classic terminal (XTermView) and Windows Terminal, so switching
 * between the two views never changes what the mouse does: with a selection it copies, without one
 * it pastes. Over a link it opens the link's own menu, and the full menu (copy / paste / select
 * all / find) is one Shift+right-click (or the Menu key / Shift+F10) away.
 */
export type RightClickInput = {
  shiftKey: boolean
  hasSelection: boolean
  overLink: boolean
  /** Read-only or ended terminal: nothing can be pasted. */
  readOnly: boolean
}

export type RightClickAction = 'copy' | 'paste' | 'linkMenu' | 'fullMenu'

export function rightClickAction(input: RightClickInput): RightClickAction {
  if (input.shiftKey) return 'fullMenu'
  if (input.hasSelection) return 'copy'
  if (input.overLink) return 'linkMenu'
  // Pasting is impossible here, so the click still does something useful.
  if (input.readOnly) return 'fullMenu'
  return 'paste'
}

/** Keyboard route to the full menu: the Menu key or Shift+F10. */
export function isMenuKey(event: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}): boolean {
  if (event.key === 'ContextMenu') return true
  return event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
}
