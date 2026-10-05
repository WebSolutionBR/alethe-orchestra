import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { useT } from '../../../lib/i18n'
import {
  centerAt,
  constrainView,
  fitView,
  type Size,
  snap,
  type View,
  wheelPixels,
  wheelZoomFactor,
  ZOOM_STEP,
  zoomAt,
} from './viewport'
import styles from './ZoomCanvas.module.css'

/** Elements that keep their own pointer behavior; a drag starting on them does not pan. */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [data-no-pan]'
const DRAG_THRESHOLD = 3
const KEEP_VISIBLE = 48

type Drag = { id: number; x: number; y: number; vx: number; vy: number; moved: boolean }

type Props = {
  /** Logical size of the world drawn by `children`, in CSS pixels at zoom 1. */
  contentWidth: number
  contentHeight: number
  children: ReactNode
  /** Rendered over the viewport, unaffected by zoom (legends, hints). */
  overlay?: ReactNode
  label: string
  className?: string
  minZoom?: number
  maxZoom?: number
  /** Auto-fit never scales above this, so small graphs are not blown up. */
  maxFitZoom?: number
  fitPadding?: number
  /** Called for a click on empty canvas that was not the end of a pan. */
  onBackgroundClick?: () => void
  /** Reports the measured viewport, for views that lay out to the available space. */
  onViewportSize?: (size: Size) => void
}

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const media = window.matchMedia?.(`(resolution: ${dpr}dppx)`)
    const onChange = () => setDpr(window.devicePixelRatio || 1)
    media?.addEventListener?.('change', onChange)
    return () => media?.removeEventListener?.('change', onChange)
  }, [dpr])
  return dpr
}

/**
 * Pan/zoom viewport shared by the Orchestra canvases: Ctrl+wheel or buttons zoom around the
 * pointer, dragging empty space pans, and it fits the content to the screen until the user
 * takes over (the fit button hands control back).
 */
export function ZoomCanvas({
  contentWidth,
  contentHeight,
  children,
  overlay,
  label,
  className,
  minZoom = 0.2,
  maxZoom = 3,
  maxFitZoom = 1,
  fitPadding = 24,
  onBackgroundClick,
  onViewportSize,
}: Props) {
  const t = useT()
  const dpr = useDevicePixelRatio()
  const rootRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [auto, setAuto] = useState(true)
  const [panning, setPanning] = useState(false)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)

  const content = { w: contentWidth, h: contentHeight }
  const latest = useRef({ content, viewport, view, minZoom, maxZoom })
  latest.current = { content, viewport, view, minZoom, maxZoom }

  const onSizeRef = useRef(onViewportSize)
  onSizeRef.current = onViewportSize

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = () => {
      const next = { w: el.clientWidth, h: el.clientHeight }
      setViewport((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
      onSizeRef.current?.(next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Auto-fit follows every change of content or viewport size until the user pans or zooms.
  useLayoutEffect(() => {
    if (!auto) return
    setView(
      fitView(
        { w: contentWidth, h: contentHeight },
        viewport,
        fitPadding,
        minZoom,
        Math.min(maxFitZoom, maxZoom),
      ),
    )
  }, [auto, contentWidth, contentHeight, viewport, fitPadding, minZoom, maxZoom, maxFitZoom])

  const apply = useCallback((next: View) => {
    const { content: c, viewport: v } = latest.current
    setAuto(false)
    setView(constrainView(next, c, v, KEEP_VISIBLE))
  }, [])

  const zoomBy = useCallback(
    (factor: number, px?: number, py?: number) => {
      const { view: cur, viewport: v, minZoom: lo, maxZoom: hi } = latest.current
      apply(zoomAt(cur, factor, px ?? v.w / 2, py ?? v.h / 2, lo, hi))
    },
    [apply],
  )

  const fit = () => setAuto(true)
  const reset = () => apply(centerAt(content, viewport, 1))

  // Wheel needs a non-passive listener so Ctrl+wheel does not zoom the whole webview.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      const rect = el.getBoundingClientRect()
      const dy = wheelPixels(event.deltaY, event.deltaMode, rect.height)
      const dx = wheelPixels(event.deltaX, event.deltaMode, rect.width)
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoomBy(wheelZoomFactor(dy), event.clientX - rect.left, event.clientY - rect.top)
        return
      }
      const cur = latest.current.view
      apply(
        event.shiftKey ? { ...cur, x: cur.x - dy - dx } : { ...cur, x: cur.x - dx, y: cur.y - dy },
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply, zoomBy])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const middle = event.button === 1
    if (event.button !== 0 && !middle) return
    if (!middle && (event.target as HTMLElement).closest(INTERACTIVE)) return
    if (middle) event.preventDefault()
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      vx: view.x,
      vy: view.y,
      moved: false,
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      d.moved = true
      setPanning(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    apply({ x: d.vx + dx, y: d.vy + dy, k: latest.current.view.k })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    drag.current = null
    if (!d.moved) return
    suppressClick.current = true
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const step = 48
    const cur = view
    const actions: Record<string, () => void> = {
      '+': () => zoomBy(ZOOM_STEP),
      '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP),
      '0': reset,
      f: fit,
      ArrowLeft: () => apply({ ...cur, x: cur.x + step }),
      ArrowRight: () => apply({ ...cur, x: cur.x - step }),
      ArrowUp: () => apply({ ...cur, y: cur.y + step }),
      ArrowDown: () => apply({ ...cur, y: cur.y - step }),
    }
    const action = actions[event.key]
    if (action) {
      event.preventDefault()
      action()
    }
  }

  const measured = viewport.w > 0 && viewport.h > 0

  return (
    <div
      ref={rootRef}
      className={className ? `${styles.viewport} ${className}` : styles.viewport}
      data-panning={panning || undefined}
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-roledescription={t('orchestra.canvas.roledescription')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onClickCapture={(event) => {
        if (!suppressClick.current) return
        suppressClick.current = false
        event.stopPropagation()
        event.preventDefault()
      }}
      onClick={(event) => {
        if (!onBackgroundClick) return
        if ((event.target as HTMLElement).closest(INTERACTIVE)) return
        onBackgroundClick()
      }}
    >
      <div
        className={styles.stage}
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: `translate(${snap(view.x, dpr)}px, ${snap(view.y, dpr)}px) scale(${view.k})`,
          visibility: measured ? 'visible' : 'hidden',
        }}
      >
        {children}
      </div>
      {overlay}
      <div
        className={styles.controls}
        data-no-pan
        role="toolbar"
        aria-label={t('orchestra.canvas.controls')}
      >
        <button
          type="button"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={view.k <= minZoom + 1e-6}
          title={t('orchestra.canvas.zoomOut')}
          aria-label={t('orchestra.canvas.zoomOut')}
        >
          <Minus size={13} />
        </button>
        <span className={styles.pct} aria-live="polite" title={t('orchestra.canvas.zoomHint')}>
          {Math.round(view.k * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={view.k >= maxZoom - 1e-6}
          title={t('orchestra.canvas.zoomIn')}
          aria-label={t('orchestra.canvas.zoomIn')}
        >
          <Plus size={13} />
        </button>
        <span className={styles.sep} aria-hidden="true" />
        <button
          type="button"
          onClick={fit}
          aria-pressed={auto}
          title={t('orchestra.canvas.fit')}
          aria-label={t('orchestra.canvas.fit')}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          onClick={reset}
          title={t('orchestra.canvas.reset')}
          aria-label={t('orchestra.canvas.reset')}
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  )
}
