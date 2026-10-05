import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef } from 'react'

import { useT } from '../../../lib/i18n'
import { handlePlacement, panelLimit } from './panelGeometry'
import styles from './Splitter.module.css'
import type { PanelSize } from './usePanelSize'

type Props = {
  panel: PanelSize
  /** 'y' resizes a panel above or below the handle, 'x' one to its left or right. */
  axis: 'x' | 'y'
  label?: string
}

type Drag = { start: number; size: number; sign: number; moved: boolean }

/**
 * Drag handle between a canvas and a panel. As the first element of a bottom or right panel it
 * grows that panel when moved toward the canvas; placed right after a top or left panel it resizes
 * that one instead. The panel never takes more than its container minus a minimum canvas, and is
 * re-clamped whenever the container resizes. Arrow keys move the handle, Home/End jump to the
 * bounds, double-click restores the default size.
 */
export function Splitter({ panel, axis, label }: Props) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const { setLimit } = panel

  useLayoutEffect(() => {
    const handle = ref.current
    if (!handle) return
    const { container, panelBefore } = handlePlacement(handle)
    if (!container) return
    const y = axis === 'y'
    const measure = () => {
      if (!panelBefore) {
        setLimit(panelLimit(y ? container.clientHeight : container.clientWidth))
        return
      }
      // A panel before the handle shares the space from its own leading edge to the far edge of
      // the container, and never grows past its content (it may be sized with a max-height).
      const box = container.getBoundingClientRect()
      const own = panelBefore.getBoundingClientRect()
      const room = y ? box.bottom - own.top : box.right - own.left
      const content = y
        ? panelBefore.scrollHeight + panelBefore.offsetHeight - panelBefore.clientHeight
        : panelBefore.scrollWidth + panelBefore.offsetWidth - panelBefore.clientWidth
      setLimit(panelLimit(room, content))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    if (panelBefore) observer.observe(panelBefore)
    return () => observer.disconnect()
  }, [axis, setLimit])

  /** +1 when the panel grows as the handle moves down or right, -1 when it grows moving up or left. */
  const growSign = () => (ref.current && handlePlacement(ref.current).panelBefore ? 1 : -1)
  const pos = (e: PointerEvent) => (axis === 'y' ? e.clientY : e.clientX)
  const dragged = (d: Drag, e: PointerEvent) => d.size + (pos(e) - d.start) * d.sign

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { start: pos(e), size: panel.size, sign: growSign(), moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || pos(e) === d.start) return
    d.moved = true
    panel.setSize(dragged(d, e))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    // A plain click must not store a size the window squeezed the panel to.
    if (d.moved) panel.setSize(dragged(d, e), true)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const forward = axis === 'y' ? 'ArrowDown' : 'ArrowRight'
    const back = axis === 'y' ? 'ArrowUp' : 'ArrowLeft'
    const step = (e.shiftKey ? 64 : 16) * growSign()
    if (e.key === forward) panel.setSize(panel.size + step, true)
    else if (e.key === back) panel.setSize(panel.size - step, true)
    else if (e.key === 'Home') panel.setSize(panel.min, true)
    else if (e.key === 'End') panel.setSize(panel.max, true)
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={ref}
      className={styles.splitter}
      data-axis={axis}
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
      aria-label={label ?? t('orchestra.canvas.resize')}
      aria-valuenow={Math.round(panel.size)}
      aria-valuemin={panel.min}
      aria-valuemax={panel.max}
      title={t('orchestra.canvas.resizeHint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={panel.reset}
      onKeyDown={onKeyDown}
    />
  )
}
