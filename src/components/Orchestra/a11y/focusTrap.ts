const TABBABLE =
  'a[href], button, input, select, textarea, iframe, [tabindex], [contenteditable="true"]'

/** Elements Tab can reach inside `root`, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
}

type TabKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>

/**
 * Keeps Tab inside a modal: Tab on the last element wraps to the first and Shift+Tab on the first
 * wraps to the last, so the focus never reaches the page behind the backdrop.
 */
export function trapTab(root: HTMLElement, event: TabKey): void {
  if (event.key !== 'Tab') return
  const items = tabbables(root)
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = root.ownerDocument.activeElement
  const outside = !active || !root.contains(active)
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault()
    first.focus()
  }
}
