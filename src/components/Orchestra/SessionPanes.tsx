import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { useT } from '../../lib/i18n'
import { useOrchestraStore } from '../../stores/orchestraStore'
import splitterStyles from './canvas/Splitter.module.css'
import { showSession } from './navigation'
import {
  clampSplitRatio,
  paneElementId,
  readSplitRatio,
  SPLIT_DEFAULT,
  tabElementId,
  writeSplitRatio,
} from './sessionLayout'
import styles from './SessionPanes.module.css'

/** A click in a pane or a Tab press this recent (ms) makes a focus change the user's own. */
const INTENT_MS = 800

type Props = {
  /** Sessions on screen from left to right: one, or two side by side. */
  ids: string[]
  /** The session that owns the keyboard. */
  focusedId: string
  render: (sessionId: string) => ReactNode
}

/**
 * The session panes of the Orchestra view. Side by side, a draggable divider shares the width
 * (the ratio is remembered) and the pane last clicked or tabbed into is the focused one: it owns
 * the keyboard shortcuts and shows a subtle outline. Panes are keyed by session, so turning the
 * split on or off and moving the focus never remounts the session that stays on screen.
 */
export function SessionPanes({ ids, focusedId, render }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(readSplitRatio)
  const [width, setWidth] = useState<number | null>(null)
  const intent = useRef({ pane: '', at: 0, tab: 0 })
  const split = ids.length === 2

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !split) return
    const measure = () => setWidth(root.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [split])

  useEffect(() => {
    if (!split) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab') intent.current.tab = performance.now()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [split])

  const focusPane = (id: string) => {
    if (useOrchestraStore.getState().activeId !== id) showSession(id)
  }

  const onPointerDown = (id: string) => {
    intent.current.pane = id
    intent.current.at = performance.now()
    if (split) focusPane(id)
  }

  // Terminals focus themselves when they mount, so a worker spawning in the other pane would
  // take the keyboard from the one the user is typing in. Only a click or Tab moves it there.
  const onFocusIn = (id: string, e: FocusEvent<HTMLDivElement>) => {
    if (!split || useOrchestraStore.getState().activeId === id) return
    const now = performance.now()
    const { pane, at, tab } = intent.current
    if ((pane === id && now - at < INTENT_MS) || now - tab < INTENT_MS) {
      focusPane(id)
      return
    }
    const back = e.relatedTarget
    const stray = e.target
    queueMicrotask(() => {
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true })
      else if (stray instanceof HTMLElement) stray.blur()
    })
  }

  const setShare = (value: number, persist = false) => {
    setRatio(value)
    if (persist) writeSplitRatio(value)
  }
  const share = clampSplitRatio(ratio, width)

  return (
    <div ref={rootRef} className={styles.panes}>
      {ids.flatMap((id, index) => {
        const pane = (
          <div
            key={id}
            id={paneElementId(id)}
            role="tabpanel"
            aria-labelledby={tabElementId(id)}
            className={styles.pane}
            data-focused={split && id === focusedId ? true : undefined}
            style={split && index === 0 ? { flex: `0 0 ${share * 100}%` } : undefined}
            onPointerDownCapture={() => onPointerDown(id)}
            onFocusCapture={(e) => onFocusIn(id, e)}
          >
            {render(id)}
          </div>
        )
        const divider = (
          <SplitDivider
            key="divider"
            rootRef={rootRef}
            width={width}
            share={share}
            onShare={setShare}
          />
        )
        return index === 1 ? [divider, pane] : [pane]
      })}
    </div>
  )
}

/**
 * The handle between the two panes, styled like the canvas splitters. Drag it, move it with the
 * arrow keys (Shift for bigger steps), Home/End for the bounds; a double-click splits evenly.
 */
function SplitDivider({
  rootRef,
  width,
  share,
  onShare,
}: {
  rootRef: RefObject<HTMLDivElement | null>
  /** Measured width of the panes, in px; null until laid out. */
  width: number | null
  share: number
  onShare: (value: number, persist?: boolean) => void
}) {
  const t = useT()
  const dragging = useRef(false)
  const bounded = (value: number) => clampSplitRatio(value, width)
  const fromPointer = (e: PointerEvent) => {
    const box = rootRef.current?.getBoundingClientRect()
    return box && box.width > 0 ? bounded((e.clientX - box.left) / box.width) : share
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) onShare(fromPointer(e))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    onShare(fromPointer(e), true)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.08 : 0.02
    if (e.key === 'ArrowLeft') onShare(bounded(share - step), true)
    else if (e.key === 'ArrowRight') onShare(bounded(share + step), true)
    else if (e.key === 'Home') onShare(bounded(0), true)
    else if (e.key === 'End') onShare(bounded(1), true)
    else return
    e.preventDefault()
  }

  return (
    <div
      className={`${splitterStyles.splitter} ${styles.divider}`}
      data-axis="x"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('orchestra.sessions.resize')}
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={Math.round(bounded(0) * 100)}
      aria-valuemax={Math.round(bounded(1) * 100)}
      title={t('orchestra.sessions.resizeHint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onShare(SPLIT_DEFAULT, true)}
      onKeyDown={onKeyDown}
    />
  )
}
