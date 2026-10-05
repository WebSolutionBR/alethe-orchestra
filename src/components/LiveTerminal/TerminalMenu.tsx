import type { KeyboardEvent, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import styles from './LiveTerminal.module.css'

export type MenuEntry = {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  run: () => void
}

export type TerminalMenuProps = {
  /** Viewport coordinates of the pointer (or of the cursor, when opened from the keyboard). */
  x: number
  y: number
  label: string
  /** Optional header line, e.g. the link the menu acts on. */
  heading?: string
  entries: MenuEntry[]
  onClose: () => void
}

const MARGIN = 8
const OFFSET = 4

/** Small context menu in a portal, so no transformed ancestor can misplace it. */
export function TerminalMenu({ x, y, label, heading, entries, onClose }: TerminalMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x + OFFSET, top: y + OFFSET })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const left = Math.max(MARGIN, Math.min(x + OFFSET, window.innerWidth - width - MARGIN))
    const below = y + OFFSET
    const top =
      below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, y - height - OFFSET)
    setPosition((current) =>
      current.left === left && current.top === top ? current : { left, top },
    )
  }, [x, y, entries.length])

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    )
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: position.left, top: position.top }}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {heading ? (
        <div className={styles.menuHeading} title={heading}>
          {heading}
        </div>
      ) : null}
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          className={styles.menuItem}
          disabled={entry.disabled}
          onClick={() => {
            onClose()
            entry.run()
          }}
        >
          {entry.icon}
          <span>{entry.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
