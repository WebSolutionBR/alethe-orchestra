import { ChevronDown } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useShallow } from 'zustand/react/shallow'

import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type BusMessage,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
} from '../../../stores/orchestraStore'
import { Splitter } from '../canvas/Splitter'
import { usePanelSize } from '../canvas/usePanelSize'
import { ZoomCanvas } from '../canvas/ZoomCanvas'
import { CreativeMark } from '../creative/CreativeMark'
import { SCRIBE_ID } from '../scribe/identity'
import { ScribeLink, ScribeNode } from '../scribe/ScribeMarks'
import { useScribeLines } from '../scribe/useScribe'
import { useSession, useSessionActions, useSessionId } from '../sessionContext'
import {
  agentColor,
  areaOf,
  busClock,
  endedByUserKey,
  isBusy,
  messagesFor,
  overallProgress,
  SPINNER,
  stateColor,
  workersOf,
} from '../shared'
import styles from './ConstellationView.module.css'

type Size = { w: number; h: number }
type Edge = { x0: number; y0: number; x1: number; y1: number }
type Dot = {
  workerId: string
  /** 1 travels orchestrator → worker, -1 worker → orchestrator. */
  dir: 1 | -1
  start: number
  duration: number
  el: SVGGElement
  onArrive?: () => void
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const FALLBACK_ORCH: Size = { w: 260, h: 62 }
const FALLBACK_NODE: Size = { w: 200, h: 58 }
/** Space kept clear at the top of the graph for the legend. */
const TOP_RESERVE = 34
const EDGE_PAD = 6
const MAX_DOTS = 48
/** Smallest world the radial layout is computed in; smaller screens zoom out instead of overlapping. */
const MIN_WORLD: Size = { w: 820, h: 460 }
/** The Obsidian scribe docks under the orchestrator: link length and node size (world px). */
const SCRIBE_GAP = 18
const SCRIBE_W = 220
const SCRIBE_H = 52
const BUS_OPEN_KEY = 'orchestra.constellation.busOpen'

function readBusOpen(): boolean {
  try {
    return localStorage.getItem(BUS_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeBusOpen(open: boolean): void {
  try {
    localStorage.setItem(BUS_OPEN_KEY, open ? '1' : '0')
  } catch {
    // Remembered UI preference only.
  }
}

/** Point where a ray from the rectangle center along (dx, dy) leaves the padded rectangle. */
function rectExit(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  dx: number,
  dy: number,
  pad: number,
): [number, number] {
  const ax = Math.abs(dx) || 1e-6
  const ay = Math.abs(dy) || 1e-6
  const t = Math.min((hw + pad) / ax, (hh + pad) / ay)
  return [cx + dx * t, cy + dy * t]
}

type Layout = {
  center: { x: number; y: number }
  nodes: Map<string, { x: number; y: number }>
  edges: Map<string, Edge>
}

/**
 * Where a ray from the orchestrator's center leaves the orchestrator card or, going down, the
 * scribe docked under it, so no worker edge runs beneath the scribe node.
 */
function hubExit(cx: number, cy: number, orch: Size, ux: number, uy: number): [number, number] {
  const [ox, oy] = rectExit(cx, cy, orch.w / 2, orch.h / 2, ux, uy, EDGE_PAD)
  if (uy <= 0) return [ox, oy]
  const top = orch.h / 2 + SCRIBE_GAP - EDGE_PAD
  const leaveY = (orch.h / 2 + SCRIBE_GAP + SCRIBE_H + EDGE_PAD) / uy
  const leaveX = Math.abs(ux) > 1e-6 ? (SCRIBE_W / 2 + EDGE_PAD) / Math.abs(ux) : Infinity
  const leave = Math.min(leaveY, leaveX)
  if (leave <= top / uy) return [ox, oy]
  const t = Math.max(Math.hypot(ox - cx, oy - cy), leave)
  return [cx + ux * t, cy + uy * t]
}

/**
 * Places workers radially around the orchestrator. Up to eight share one ellipse; beyond that
 * they alternate between an outer and an inner ring so 12 cards still fit without overlapping.
 * Workers below the orchestrator also clear the scribe docked under it.
 */
function computeLayout(size: Size, ids: string[], orch: Size, node: Size): Layout {
  const { w, h } = size
  const cx = w / 2
  const cy = TOP_RESERVE / 2 + h / 2
  const nodes = new Map<string, { x: number; y: number }>()
  const edges = new Map<string, Edge>()
  const count = ids.length
  if (count === 0 || w === 0) return { center: { x: cx, y: cy }, nodes, edges }

  const clearW = orch.w / 2 + node.w / 2 + 18
  const clearH = orch.h / 2 + node.h / 2 + 18
  const rx = Math.max(Math.min(w / 2 - node.w / 2 - 20, 520), clearW)
  const ry = Math.max(Math.min((h - TOP_RESERVE) / 2 - node.h / 2 - 14, 260), clearH)
  const twoRings = count > 8
  const start = count === 1 ? -90 : -90 - 180 / count
  const step = 360 / count

  ids.forEach((id, i) => {
    const angle = ((start + step * i) * Math.PI) / 180
    const ux = Math.cos(angle)
    const uy = Math.sin(angle)
    const scale = twoRings && i % 2 === 1 ? 0.62 : 1
    // Distance to the ellipse along this direction, then pushed out until the card clears the orchestrator.
    const ellipse = 1 / Math.sqrt((ux * ux) / (rx * scale) ** 2 + (uy * uy) / (ry * scale) ** 2)
    const dock = uy > 0 ? SCRIBE_GAP + SCRIBE_H : 0
    const [ex, ey] = rectExit(0, 0, clearW, clearH + dock, ux, uy, 0)
    const dist = Math.max(ellipse, Math.hypot(ex, ey))
    const x = Math.min(Math.max(cx + ux * dist, node.w / 2 + 8), w - node.w / 2 - 8)
    const y = Math.min(Math.max(cy + uy * dist, TOP_RESERVE + node.h / 2), h - node.h / 2 - 8)
    nodes.set(id, { x, y })

    const dx = x - cx
    const dy = y - cy
    const len = Math.hypot(dx, dy) || 1
    const [x0, y0] = hubExit(cx, cy, orch, dx / len, dy / len)
    const [x1, y1] = rectExit(x, y, node.w / 2, node.h / 2, -dx / len, -dy / len, EDGE_PAD)
    edges.set(id, { x0, y0, x1, y1 })
  })
  return { center: { x: cx, y: cy }, nodes, edges }
}

const FILE_OR_REF =
  /(#\d{2,6}\b|[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|rs|py|go|java|kt|cs|css|scss|json|md|sql|toml|ya?ml|html|sh|ps1)\b)/g

/** Highlights PR/issue refs and file names inside a bus message without using innerHTML. */
function decorate(text: string): ReactNode[] {
  const parts = text.split(FILE_OR_REF)
  return parts.map((part, i) => {
    if (i % 2 === 0) return part
    return (
      <span key={i} className={part.startsWith('#') ? styles.ref : styles.file}>
        {part}
      </span>
    )
  })
}

function stateKey(agent: OrchestraAgent): MessageKey {
  return endedByUserKey(agent) ?? (`orchestra.state.${agent.state}` as MessageKey)
}

function glyphFor(agent: OrchestraAgent): string {
  if (agent.state === 'done') return '✓'
  if (agent.state === 'blocked') return '!'
  if (agent.state === 'exited') return '×'
  if (isBusy(agent.state)) return SPINNER[0]
  return '·'
}

export function ConstellationView() {
  const t = useT()
  const { agents, messages, selectedId, startedAt } = useSession(
    useShallow((s) => ({
      agents: s.agents,
      messages: s.messages,
      selectedId: s.selectedId,
      startedAt: s.startedAt,
    })),
  )
  const { select } = useSessionActions()
  const sessionId = useSessionId()
  const scribeLines = useScribeLines(messages)
  const orchestrator = agents.find((a) => a.id === ORCHESTRATOR_ID) ?? null
  const workers = useMemo(() => workersOf(agents), [agents])
  const workerIds = useMemo(() => workers.map((w) => w.id), [workers])
  const overall = overallProgress(agents)

  const rootRef = useRef<HTMLDivElement>(null)
  const dotsRef = useRef<SVGGElement>(null)
  const orchRef = useRef<HTMLDivElement>(null)
  const firstNodeRef = useRef<HTMLDivElement | null>(null)
  const nodeEls = useRef(new Map<string, HTMLDivElement>())
  const logRef = useRef<HTMLDivElement>(null)

  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 })
  const [busOpen, setBusOpen] = useState(readBusOpen)
  const busBody = usePanelSize('orchestra.constellation.busHeight', 220, 80, 520)
  const [orchSize, setOrchSize] = useState<Size>(FALLBACK_ORCH)
  const [nodeSize, setNodeSize] = useState<Size>(FALLBACK_NODE)
  const [follow, setFollow] = useState(true)

  // The world matches the screen when there is room and stays at a minimum otherwise, so the
  // canvas fits it at 100% on large monitors and zooms out (instead of overlapping) on small ones.
  const extra = Math.max(0, workerIds.length - 6)
  const minW = MIN_WORLD.w + extra * 40
  const minH = MIN_WORLD.h + extra * 24 + SCRIBE_GAP + SCRIBE_H
  const size = useMemo<Size>(
    () =>
      viewport.w > 0
        ? { w: Math.max(viewport.w, minW), h: Math.max(viewport.h, minH) }
        : { w: 0, h: 0 },
    [viewport.w, viewport.h, minW, minH],
  )
  const onViewportSize = useCallback(
    (next: Size) => setViewport((prev) => (prev.w === next.w && prev.h === next.h ? prev : next)),
    [],
  )

  // Card sizes depend on fonts and the compact breakpoint; measure instead of guessing.
  useLayoutEffect(() => {
    const o = orchRef.current
    if (o && (o.offsetWidth !== orchSize.w || o.offsetHeight !== orchSize.h) && o.offsetWidth > 0) {
      setOrchSize({ w: o.offsetWidth, h: o.offsetHeight })
    }
    const n = firstNodeRef.current
    if (n && (n.offsetWidth !== nodeSize.w || n.offsetHeight !== nodeSize.h) && n.offsetWidth > 0) {
      setNodeSize({ w: n.offsetWidth, h: n.offsetHeight })
    }
  }, [orchSize, nodeSize, size, workerIds])

  const layout = useMemo(
    () => computeLayout(size, workerIds, orchSize, nodeSize),
    [size, workerIds, orchSize, nodeSize],
  )
  const edgesRef = useRef(layout.edges)
  edgesRef.current = layout.edges

  /* ---------- traveling dots ---------- */
  const dots = useRef<Dot[]>([])
  const frame = useRef<number | null>(null)
  const reducedMotion = useRef(false)

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    reducedMotion.current = Boolean(media?.matches)
    const onChange = (e: MediaQueryListEvent) => {
      reducedMotion.current = e.matches
    }
    media?.addEventListener?.('change', onChange)
    return () => {
      media?.removeEventListener?.('change', onChange)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      for (const dot of dots.current) dot.el.remove()
      dots.current = []
    }
  }, [])

  const ping = (id: string) => {
    const el = id === ORCHESTRATOR_ID ? orchRef.current : nodeEls.current.get(id)
    if (!el) return
    el.classList.remove(styles.ping)
    void el.offsetWidth
    el.classList.add(styles.ping)
  }

  const tick = (now: number) => {
    const alive: Dot[] = []
    const arrived: Dot[] = []
    for (const dot of dots.current) {
      const edge = edgesRef.current.get(dot.workerId)
      const p = Math.min(1, (now - dot.start) / dot.duration)
      if (!edge || p >= 1) {
        dot.el.remove()
        if (edge) arrived.push(dot)
        continue
      }
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
      const k = dot.dir === 1 ? eased : 1 - eased
      const x = edge.x0 + (edge.x1 - edge.x0) * k
      const y = edge.y0 + (edge.y1 - edge.y0) * k
      dot.el.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`)
      alive.push(dot)
    }
    dots.current = alive
    for (const dot of arrived) dot.onArrive?.()
    frame.current = dots.current.length > 0 ? requestAnimationFrame(tick) : null
  }

  const spawnDot = (workerId: string, dir: 1 | -1, color: string, onArrive?: () => void) => {
    const edge = edgesRef.current.get(workerId)
    const group = dotsRef.current
    if (!edge || !group || reducedMotion.current || dots.current.length >= MAX_DOTS) {
      onArrive?.()
      return
    }
    const g = document.createElementNS(SVG_NS, 'g')
    const halo = document.createElementNS(SVG_NS, 'circle')
    halo.setAttribute('r', '5.5')
    halo.style.fill = color
    halo.style.fillOpacity = '0.18'
    const core = document.createElementNS(SVG_NS, 'circle')
    core.setAttribute('r', '2.6')
    core.style.fill = color
    g.append(halo, core)
    g.setAttribute('transform', 'translate(-20,-20)')
    group.appendChild(g)
    const length = Math.hypot(edge.x1 - edge.x0, edge.y1 - edge.y0)
    dots.current.push({
      workerId,
      dir,
      start: performance.now(),
      duration: Math.min(1400, Math.max(520, length * 3.2)),
      el: g,
      onArrive,
    })
    if (frame.current === null) frame.current = requestAnimationFrame(tick)
  }

  const animateMessage = (message: BusMessage, workerSet: Set<string>) => {
    const { from, to } = message
    // The scribe's own lines animate its docked node and link instead.
    if (from === SCRIBE_ID) return
    const isWorker = (id: string) => workerSet.has(id)
    const targets = (id: string, exclude: string) =>
      id === 'all' ? [...workerSet].filter((w) => w !== exclude) : [id]

    if (from === ORCHESTRATOR_ID) {
      const color = agentColor(ORCHESTRATOR_ID)
      for (const target of targets(to, from)) {
        if (isWorker(target)) spawnDot(target, 1, color, () => ping(target))
      }
      return
    }
    if (isWorker(from)) {
      const color = agentColor(from, areaOf(agents, from))
      if (to === ORCHESTRATOR_ID) {
        spawnDot(from, -1, color, () => ping(ORCHESTRATOR_ID))
        return
      }
      const relay = targets(to, from).filter(isWorker)
      // Worker-to-worker traffic routes through the hub, like the reference.
      spawnDot(from, -1, color, () => {
        if (relay.length === 0) ping(ORCHESTRATOR_ID)
        for (const target of relay) spawnDot(target, 1, color, () => ping(target))
      })
      return
    }
    // Typed by the user straight into a terminal: no edge to travel, just flash the recipient.
    for (const target of targets(to, from)) ping(target)
  }

  const lastSeen = useRef<{ startedAt: number; id: number } | null>(null)
  useEffect(() => {
    const newest = messages.length > 0 ? messages[messages.length - 1].id : 0
    const seen = lastSeen.current
    // First render or a new session: remember the backlog without replaying it.
    if (!seen || seen.startedAt !== startedAt || newest < seen.id) {
      lastSeen.current = { startedAt, id: newest }
      return
    }
    const fresh = messages.filter((m) => m.id > seen.id).slice(-12)
    lastSeen.current = { startedAt, id: newest }
    if (fresh.length === 0) return
    const workerSet = new Set(workerIds)
    for (const message of fresh) animateMessage(message, workerSet)
    // animateMessage/spawnDot only touch refs; depending on them would replay messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, startedAt])

  /* ---------- spinner glyphs (imperative, avoids re-rendering every card ~11x/s) ---------- */
  const anyBusy = agents.some((a) => isBusy(a.state))
  useEffect(() => {
    if (!anyBusy) return
    let i = 0
    const timer = window.setInterval(() => {
      // Reduced motion: the glyph rests on its first frame, as in the Hive.
      const next = reducedMotion.current ? 0 : (i + 1) % SPINNER.length
      if (next === i) return
      i = next
      rootRef.current?.querySelectorAll<HTMLElement>('[data-spin]').forEach((el) => {
        el.textContent = SPINNER[i]
      })
    }, 90)
    return () => window.clearInterval(timer)
  }, [anyBusy])

  /* ---------- bus log ---------- */
  const visibleMessages = useMemo(() => messagesFor(messages, selectedId), [messages, selectedId])
  useLayoutEffect(() => {
    const log = logRef.current
    if (log && follow) log.scrollTop = log.scrollHeight
  }, [visibleMessages, follow, busOpen])
  useEffect(() => setFollow(true), [selectedId])

  const onLogScroll = () => {
    const log = logRef.current
    if (!log) return
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30
    if (atBottom !== follow) setFollow(atBottom)
  }

  const toggle = (id: string) => select(selectedId === id ? null : id)
  const onNodeKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      toggle(id)
    }
  }

  const toggleBus = () => {
    setBusOpen((open) => {
      writeBusOpen(!open)
      return !open
    })
  }
  const latest = visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1] : null
  const who = (id: string) => (id === 'you' ? t('orchestra.constellation.you') : id)

  const selectedWorker = selectedId && selectedId !== ORCHESTRATOR_ID ? selectedId : null
  const measured = size.w > 0
  const compact = workers.length > 6

  return (
    <div ref={rootRef} className={styles.root}>
      <section className={styles.graph}>
        <ZoomCanvas
          contentWidth={Math.max(1, size.w)}
          contentHeight={Math.max(1, size.h)}
          label={t('orchestra.constellation.graph')}
          fitPadding={0}
          minZoom={0.3}
          onViewportSize={onViewportSize}
          onBackgroundClick={() => {
            if (selectedId) select(null)
          }}
          overlay={
            <>
              <div className={styles.legend}>
                <span>
                  <i style={{ background: agentColor(ORCHESTRATOR_ID) }} />
                  {t('orchestra.constellation.legendOrch')}
                </span>
                <span>
                  <i style={{ background: agentColor('claude-1') }} />
                  {t('orchestra.constellation.legendWorker')}
                </span>
                <span>
                  <i style={{ background: agentColor(SCRIBE_ID) }} />
                  {t('orchestra.scribe.name')}
                </span>
              </div>
              <div className={styles.hint}>{t('orchestra.constellation.hint')}</div>
            </>
          }
        >
          <svg
            className={styles.svg}
            width={Math.max(1, size.w)}
            height={Math.max(1, size.h)}
            viewBox={`0 0 ${Math.max(1, size.w)} ${Math.max(1, size.h)}`}
            aria-hidden="true"
          >
            <g>
              {workers.map((worker) => {
                const edge = layout.edges.get(worker.id)
                if (!edge) return null
                const cls = [
                  styles.edge,
                  worker.state === 'done' || worker.state === 'exited' ? styles.edgeDone : '',
                  selectedWorker === worker.id ? styles.edgeSel : '',
                  selectedWorker && selectedWorker !== worker.id ? styles.edgeDim : '',
                ].join(' ')
                return (
                  <line
                    key={worker.id}
                    className={cls}
                    x1={edge.x0}
                    y1={edge.y0}
                    x2={edge.x1}
                    y2={edge.y1}
                  />
                )
              })}
            </g>
            {orchestrator && measured ? (
              <ScribeLink
                x={layout.center.x}
                y1={layout.center.y + orchSize.h / 2 + 1}
                y2={layout.center.y + orchSize.h / 2 + SCRIBE_GAP - 1}
                count={scribeLines.length}
              />
            ) : null}
            <g ref={dotsRef} />
          </svg>

          {orchestrator ? (
            <div
              ref={orchRef}
              className={[
                styles.node,
                styles.orch,
                selectedId === ORCHESTRATOR_ID ? styles.orchSel : '',
              ].join(' ')}
              style={{
                left: layout.center.x,
                top: layout.center.y,
                visibility: measured ? 'visible' : 'hidden',
              }}
              role="button"
              tabIndex={0}
              aria-pressed={selectedId === ORCHESTRATOR_ID}
              aria-label={t('orchestra.constellation.nodeLabel', {
                id: orchestrator.id,
                area: t('orchestra.orchestrator'),
                state: t(stateKey(orchestrator)),
                progress: overall,
              })}
              onClick={(e) => {
                e.stopPropagation()
                toggle(ORCHESTRATOR_ID)
              }}
              onKeyDown={(e) => onNodeKey(e, ORCHESTRATOR_ID)}
            >
              <div className={styles.inner}>
                <div className={styles.row1}>
                  <span className={styles.ast}>✻</span>
                  <span className={styles.name}>{orchestrator.id}</span>
                  <span className={styles.who}>· {t('orchestra.constellation.you')}</span>
                  <span
                    className={styles.spin}
                    data-spin={isBusy(orchestrator.state) ? '' : undefined}
                  >
                    {glyphFor(orchestrator)}
                  </span>
                </div>
                <div className={styles.row2}>
                  <span>
                    {workers.length === 1
                      ? t('orchestra.workerCountOne')
                      : t('orchestra.workerCount', { count: workers.length })}
                  </span>
                  <span className={styles.who}>·</span>
                  <span className={styles.lead} title={orchestrator.note || undefined}>
                    {orchestrator.note || t(stateKey(orchestrator))}
                  </span>
                  <span className={styles.pct}>{overall}%</span>
                </div>
              </div>
              <div className={styles.bar}>
                <i style={{ width: `${overall}%` }} />
              </div>
            </div>
          ) : null}

          {orchestrator && measured ? (
            <ScribeNode
              sessionId={sessionId}
              lines={scribeLines}
              x={layout.center.x}
              y={layout.center.y + orchSize.h / 2 + SCRIBE_GAP + SCRIBE_H / 2}
              width={SCRIBE_W}
              height={SCRIBE_H}
            />
          ) : null}

          {workers.map((worker, index) => {
            const pos = layout.nodes.get(worker.id)
            const cls = [
              styles.node,
              compact ? styles.compact : '',
              worker.state === 'done' ? styles.done : '',
              worker.state === 'exited' ? styles.exited : '',
              worker.state === 'blocked' ? styles.blocked : '',
              worker.state === 'waiting' ? styles.waiting : '',
              selectedWorker === worker.id ? styles.sel : '',
              selectedWorker && selectedWorker !== worker.id ? styles.dim : '',
            ].join(' ')
            return (
              <div
                key={worker.id}
                ref={(el) => {
                  if (el) nodeEls.current.set(worker.id, el)
                  else nodeEls.current.delete(worker.id)
                  if (index === 0) firstNodeRef.current = el
                }}
                className={cls}
                style={{
                  left: pos?.x ?? 0,
                  top: pos?.y ?? 0,
                  visibility: pos && measured ? 'visible' : 'hidden',
                }}
                role="button"
                tabIndex={0}
                aria-pressed={selectedWorker === worker.id}
                aria-label={t('orchestra.constellation.nodeLabel', {
                  id: worker.id,
                  area: worker.area,
                  state: t(stateKey(worker)),
                  progress: worker.progress,
                })}
                title={worker.task || undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(worker.id)
                }}
                onKeyDown={(e) => onNodeKey(e, worker.id)}
              >
                <div className={styles.inner}>
                  <div className={styles.row1}>
                    <span className={styles.ast}>✻</span>
                    <span className={styles.name}>{worker.id}</span>
                    <span className={styles.spin} data-spin={isBusy(worker.state) ? '' : undefined}>
                      {glyphFor(worker)}
                    </span>
                  </div>
                  <div className={styles.row2}>
                    <CreativeMark area={worker.area} />
                    <span className={styles.task}>{worker.area}</span>
                    <span
                      className={styles.state}
                      style={{ color: stateColor(worker.state) }}
                      title={worker.note || undefined}
                    >
                      {t(stateKey(worker))}
                    </span>
                    <span className={styles.pct}>{worker.progress}%</span>
                  </div>
                </div>
                <div className={styles.bar}>
                  <i style={{ width: `${worker.progress}%` }} />
                </div>
              </div>
            )
          })}

          {workers.length === 0 && measured ? (
            <div
              className={styles.empty}
              style={{ top: layout.center.y + orchSize.h / 2 + SCRIBE_GAP + SCRIBE_H + 24 }}
            >
              <strong>{t('orchestra.constellation.emptyTitle')}</strong>
              <span>{t('orchestra.constellation.emptyBody')}</span>
            </div>
          ) : null}
        </ZoomCanvas>
      </section>

      <section
        className={styles.bus}
        data-open={busOpen || undefined}
        aria-label={t('orchestra.constellation.busTitle')}
      >
        {busOpen && <Splitter panel={busBody} axis="y" />}
        <div className={styles.busHead}>
          <button
            type="button"
            className={styles.busToggle}
            aria-expanded={busOpen}
            title={busOpen ? t('orchestra.canvas.busCollapse') : t('orchestra.canvas.busExpand')}
            onClick={toggleBus}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <span className={styles.busTitle}>
            {t('orchestra.constellation.busTitle')} · <b>{ORCHESTRATOR_ID}</b> ⇄{' '}
            {t('orchestra.constellation.busAgents', { count: workers.length })}
          </span>
          {selectedId ? (
            <button
              type="button"
              className={styles.chip}
              title={t('orchestra.constellation.clearFilter')}
              aria-label={t('orchestra.constellation.clearFilter')}
              onClick={() => select(null)}
            >
              {t('orchestra.constellation.filter')}: {selectedId}
              <span aria-hidden="true">✕</span>
            </button>
          ) : null}
          {!busOpen && latest ? (
            <button type="button" className={styles.peek} title={latest.text} onClick={toggleBus}>
              <span style={{ color: agentColor(latest.from) }}>{who(latest.from)}</span>
              <span className={styles.arrow}>→</span>
              <span style={{ color: agentColor(latest.to) }}>{who(latest.to)}</span>
              <span className={styles.peekText}>{decorate(latest.text)}</span>
            </button>
          ) : (
            <span className={styles.spacer} />
          )}
          {busOpen ? (
            <span className={follow ? styles.follow : `${styles.follow} ${styles.followOff}`}>
              {follow ? t('orchestra.constellation.follow') : t('orchestra.constellation.paused')}
            </span>
          ) : null}
          <span>{t('orchestra.constellation.msgCount', { count: visibleMessages.length })}</span>
        </div>
        {busOpen ? (
          <div
            ref={logRef}
            className={styles.log}
            style={{ height: busBody.size }}
            role="log"
            aria-live="off"
            onScroll={onLogScroll}
          >
            {visibleMessages.length === 0 ? (
              <div className={styles.busEmpty}>
                {selectedId
                  ? t('orchestra.constellation.busEmptyFilter', { id: selectedId })
                  : t('orchestra.constellation.busEmpty')}
              </div>
            ) : (
              visibleMessages.map((message) => (
                <div key={message.id} className={styles.line}>
                  <span className={styles.ts}>{busClock(message.at, startedAt)}</span>
                  <span className={styles.route}>
                    <span
                      style={{
                        color:
                          message.from === 'all'
                            ? undefined
                            : agentColor(message.from, areaOf(agents, message.from)),
                      }}
                    >
                      {who(message.from)}
                    </span>
                    <span className={styles.arrow}>→</span>
                    <span
                      style={{
                        color:
                          message.to === 'all'
                            ? undefined
                            : agentColor(message.to, areaOf(agents, message.to)),
                      }}
                    >
                      {who(message.to)}
                    </span>
                  </span>
                  <span
                    className={
                      message.text.startsWith('done ·') ? `${styles.msg} ${styles.ok}` : styles.msg
                    }
                    title={message.text}
                  >
                    {decorate(message.text)}
                  </span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}
