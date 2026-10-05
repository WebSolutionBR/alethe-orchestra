import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ptyExists, resizePty } from '../../lib/tauri'
import {
  ensureMirror,
  getMirror,
  onMirrorRegistry,
  seedMirror,
  type TerminalMirror,
} from '../../lib/terminalMirror'
import { getTerminalSize, rememberTerminalSize } from '../../lib/terminalSizes'
import { claimSize, isSizeOwner, joinSizeOwners, onSizeOwnerChange } from './sizeOwners'

/** The PTY's mirror, following the registry (created later, disposed, recreated). */
export function useMirror(ptyId: string): TerminalMirror | null {
  const [mirror, setMirror] = useState<TerminalMirror | null>(() => getMirror(ptyId))
  useEffect(() => {
    setMirror(getMirror(ptyId))
    return onMirrorRegistry((id) => {
      if (id === ptyId) setMirror(getMirror(ptyId))
    })
  }, [ptyId])
  return mirror
}

/** Bumps on every (frame-coalesced) mirror change. */
export function useMirrorVersion(mirror: TerminalMirror | null): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!mirror) return
    const off = mirror.onChange(() => setVersion((value) => value + 1))
    // Anything written between the render and this subscription would otherwise stay unseen.
    setVersion((value) => value + 1)
    return off
  }, [mirror])
  return version
}

/** Delay before a view creates the mirror itself for a PTY that was born without one. */
export const MIRROR_FALLBACK_MS = 300

/**
 * Orchestra PTYs get their mirror before they spawn. A PTY born without one (a restored pane) gets
 * it here, once, at the size the PTY is known to have — or, for a view that owns the size, at the
 * view's own size, which is then forced onto the PTY so both agree.
 */
export function useMirrorFallback(params: {
  ptyId: string
  mirror: TerminalMirror | null
  ownSize: { cols: number; rows: number } | null
  onCreatedAtOwnSize: () => void
}): void {
  const { ptyId, mirror, ownSize, onCreatedAtOwnSize } = params
  const ownSizeRef = useRef(ownSize)
  ownSizeRef.current = ownSize
  const createdRef = useRef(onCreatedAtOwnSize)
  createdRef.current = onCreatedAtOwnSize
  // A pane that mounts hidden has no size yet: try again once it gets one.
  const hasOwnSize = ownSize !== null

  useEffect(() => {
    if (mirror) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled || getMirror(ptyId)) return
      void ptyExists(ptyId)
        .catch(() => false)
        .then((alive) => {
          if (cancelled || !alive || getMirror(ptyId)) return
          const known = getTerminalSize(ptyId)
          const size = known ?? ownSizeRef.current
          if (!size) return
          ensureMirror(ptyId, size)
          if (!known) createdRef.current()
          void seedMirror(ptyId).catch(() => {})
        })
    }, MIRROR_FALLBACK_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hasOwnSize, mirror, ptyId])
}

export type CellMetrics = { cellWidth: number; rowHeight: number }

/** Used until the probe can be measured (hidden pane, tests). Cascadia Mono 14px is close to it. */
export const FALLBACK_METRICS: CellMetrics = { cellWidth: 8.4, rowHeight: 17 }

export const PROBE_TEXT = '0123456789'.repeat(8)

/**
 * Measures one cell of the terminal font from a hidden probe. Layout sizes are read through the
 * root's transform scale, so a view inside a zoomed canvas still gets unscaled CSS pixels.
 */
export function measureCell(probe: HTMLElement, root: HTMLElement): CellMetrics | null {
  const probeRect = probe.getBoundingClientRect()
  if (!probeRect.width || !probeRect.height) return null
  const rootRect = root.getBoundingClientRect()
  const scale = root.offsetWidth > 0 && rootRect.width > 0 ? rootRect.width / root.offsetWidth : 1
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const cellWidth = probeRect.width / safeScale / PROBE_TEXT.length
  const rowHeight = Math.ceil(probeRect.height / safeScale - 0.01)
  if (!(cellWidth > 0) || !(rowHeight > 0)) return null
  return { cellWidth, rowHeight }
}

/** Cell size, re-measured when fonts finish loading, on app zoom and when the probe gets a box. */
export function useCellMetrics(
  rootRef: RefObject<HTMLElement>,
  probeRef: RefObject<HTMLElement>,
): CellMetrics {
  const [metrics, setMetrics] = useState<CellMetrics>(FALLBACK_METRICS)

  const remeasure = useCallback(() => {
    const probe = probeRef.current
    const root = rootRef.current
    if (!probe || !root) return
    const next = measureCell(probe, root)
    if (!next) return
    setMetrics((current) =>
      Math.abs(current.cellWidth - next.cellWidth) < 0.001 && current.rowHeight === next.rowHeight
        ? current
        : next,
    )
  }, [probeRef, rootRef])

  useLayoutEffect(() => {
    remeasure()
  }, [remeasure])

  useEffect(() => {
    let disposed = false
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    void fonts?.ready.then(() => {
      if (!disposed) remeasure()
    })
    fonts?.addEventListener?.('loadingdone', remeasure)
    window.addEventListener('alethe:zoom-changed', remeasure)
    const probe = probeRef.current
    const observer =
      typeof ResizeObserver !== 'undefined' && probe ? new ResizeObserver(() => remeasure()) : null
    if (probe) observer?.observe(probe)
    return () => {
      disposed = true
      fonts?.removeEventListener?.('loadingdone', remeasure)
      window.removeEventListener('alethe:zoom-changed', remeasure)
      observer?.disconnect()
    }
  }, [probeRef, remeasure])

  return metrics
}

export type BoxSize = { width: number; height: number }

/** Client size (no scrollbar, no border) of an element, kept current by a ResizeObserver. */
export function useClientSize(ref: RefObject<HTMLElement>): BoxSize {
  const [size, setSize] = useState<BoxSize>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const read = () => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      )
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** Registers the view as a candidate to size the PTY; `claim` makes it the one that does. */
export function useSizeOwnership(
  ptyId: string,
  enabled: boolean,
): { owner: boolean; claim: () => void } {
  const tokenRef = useRef<symbol | null>(null)
  if (tokenRef.current === null) tokenRef.current = Symbol('live-terminal')
  const token = tokenRef.current
  const [owner, setOwner] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setOwner(false)
      return
    }
    const update = () => setOwner(isSizeOwner(ptyId, token))
    const off = onSizeOwnerChange(ptyId, update)
    const leave = joinSizeOwners(ptyId, token, false)
    update()
    return () => {
      off()
      leave()
    }
  }, [enabled, ptyId, token])

  const claim = useCallback(() => {
    if (enabled) claimSize(ptyId, token)
  }, [enabled, ptyId, token])

  return { owner, claim }
}

/** Delay that lets a drag-resize settle before the PTY is told (each resize repaints a TUI). */
export const FIT_DEBOUNCE_MS = 80

/**
 * Fits the PTY (and, through the pty.ts wrapper, the mirror) to the view's grid. Sends a size only
 * when it differs from the mirror's — the mirror is always the PTY's real size — and never twice
 * in a row, so typing or re-renders can never re-signal the ConPTY.
 */
export function usePtyFit(params: {
  ptyId: string
  mirror: TerminalMirror | null
  enabled: boolean
  cols: number
  rows: number
  /** Send even when the sizes already match (the PTY's real size is unknown). */
  forceRef: { current: boolean }
}): void {
  const { ptyId, mirror, enabled, cols, rows, forceRef } = params
  const pendingRef = useRef<string | null>(null)
  const mirrorCols = mirror?.cols ?? 0
  const mirrorRows = mirror?.rows ?? 0

  useEffect(() => {
    if (!enabled || !mirror || cols < 2 || rows < 1) return
    const force = forceRef.current
    if (!force && cols === mirrorCols && rows === mirrorRows) {
      pendingRef.current = null
      return
    }
    const key = `${cols}x${rows}`
    if (!force && pendingRef.current === key) return
    const timer = window.setTimeout(() => {
      forceRef.current = false
      pendingRef.current = key
      // A restart respawns at this size instead of guessing (see terminalSizes.ts).
      rememberTerminalSize(ptyId, cols, rows)
      void resizePty(ptyId, cols, rows).catch((error) => {
        // Never keep a guard for a size the backend did not apply.
        if (pendingRef.current === key) pendingRef.current = null
        console.warn(`[live-terminal] ${ptyId}: resize to ${key} failed`, error)
      })
    }, FIT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [cols, enabled, forceRef, mirror, mirrorCols, mirrorRows, ptyId, rows])
}
