import { Lock, SquareTerminal } from 'lucide-react'
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type AgentState,
  type BusMessage,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
} from '../../../stores/orchestraStore'
import { AgentAlert } from '../AgentAlert'
import { Splitter } from '../canvas/Splitter'
import { usePanelSize } from '../canvas/usePanelSize'
import { ZoomCanvas } from '../canvas/ZoomCanvas'
import { CreativeMark } from '../creative/CreativeMark'
import { isCreativeArea } from '../creative/role'
import { DeliveryMark } from '../DeliveryMark'
import { draftKey, useDraftText } from '../drafts'
import type { hiveEn } from '../i18n/hive'
import { ScribeBadge } from '../scribe/ScribeMarks'
import { useScribeLines } from '../scribe/useScribe'
import { useSession, useSessionActions, useSessionId } from '../sessionContext'
import {
  agentColor,
  areaOf,
  busClock,
  elapsed,
  endedByUserKey,
  isBusy,
  isOrchestrator,
  messagesFor,
  overallProgress,
  processEnded,
  SPINNER,
  stateColor,
  workersOf,
} from '../shared'
import styles from './HiveView.module.css'

type HiveKey = keyof typeof hiveEn
type Params = Record<string, string | number>
type HiveT = (key: HiveKey, params?: Params) => string

/** Keys live in i18n/hive.ts until the shell spreads them into en.ts / pt-BR.ts. */
function useHiveT(): HiveT {
  const t = useT()
  return (key, params) => t(key as string as MessageKey, params)
}

/* ---------- hex geometry (pointy-top, axial coordinates) ---------- */

const SQ3 = Math.sqrt(3)
const R = 64
const RD = R - 4
/** Walk order around a ring, starting at the top-left cell of ring n. */
const WALK: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
]
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]
const NAME_FONT = 10
const CHAR_W = NAME_FONT * 0.6
const AREA_CHARS = 12
const PULSE_SPEED = 260
const EDGE_FADE_MS = 750
const FLASH_MS = 600
const MAX_PULSES = 40
const MAX_NEW_PER_BATCH = 12

type Hex = { q: number; r: number }
type Point = { x: number; y: number }
type Cell = Hex & Point & { id: string; ring: number }

const hexKey = (q: number, r: number) => `${q},${r}`
const toPixel = (q: number, r: number): Point => ({ x: R * SQ3 * (q + r / 2), y: R * 1.5 * r })

const ringCache = new Map<number, Hex[]>()
function ringCells(n: number): Hex[] {
  const cached = ringCache.get(n)
  if (cached) return cached
  const out: Hex[] = []
  let q = 0
  let r = -n
  for (const [dq, dr] of WALK) {
    for (let s = 0; s < n; s++) {
      out.push({ q, r })
      q += dq
      r += dr
    }
  }
  ringCache.set(n, out)
  return out
}

/** Worker index (0-based) to its hex: ring 1 holds 6, ring 2 holds 12, and so on. */
function slotFor(index: number): Hex & { ring: number } {
  let ring = 1
  let offset = index
  while (offset >= 6 * ring) {
    offset -= 6 * ring
    ring++
  }
  return { ...ringCells(ring)[offset], ring }
}

function hexPath(rad: number): string {
  let d = ''
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k + 30)
    d += `${k ? 'L' : 'M'}${(rad * Math.cos(a)).toFixed(2)} ${(rad * Math.sin(a)).toFixed(2)}`
  }
  return `${d}Z`
}
const HEX_D = hexPath(RD)
const HEX_RING_D = hexPath(RD + 0.5)
const HEX_INNER_D = hexPath(RD - 6)

/** Shortest hop path between two occupied cells, walking only through occupied neighbors. */
function route(cells: Map<string, Cell>, from: Cell, to: Cell): Cell[] {
  const byKey = new Map<string, Cell>()
  for (const c of cells.values()) byKey.set(hexKey(c.q, c.r), c)
  const goal = hexKey(to.q, to.r)
  const prev = new Map<string, Cell | null>([[hexKey(from.q, from.r), null]])
  const queue: Cell[] = [from]
  while (queue.length) {
    const cur = queue.shift() as Cell
    if (hexKey(cur.q, cur.r) === goal) break
    for (const [dq, dr] of DIRS) {
      const k = hexKey(cur.q + dq, cur.r + dr)
      const next = byKey.get(k)
      if (next && !prev.has(k)) {
        prev.set(k, cur)
        queue.push(next)
      }
    }
  }
  if (!prev.has(goal)) return [from, to]
  const path: Cell[] = []
  let node: Cell | null | undefined = to
  while (node) {
    path.unshift(node)
    node = prev.get(hexKey(node.q, node.r))
  }
  return path
}

function liquidPaths(level: number, amp: number, now: number, phase: number) {
  const top = RD - level * 2 * RD
  const w = (RD * SQ3) / 2 + 2
  let line = ''
  for (let x = -w; x <= w + 0.1; x += 8) {
    const y =
      top +
      Math.sin(x * 0.075 + now * 0.0022 + phase) * amp +
      Math.sin(x * 0.13 - now * 0.0017) * amp * 0.4
    line += `${x === -w ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(2)}`
  }
  return { fill: `${line}L${w.toFixed(1)} ${RD + 2}L${(-w).toFixed(1)} ${RD + 2}Z`, surface: line }
}

/* ---------- agent presentation helpers ---------- */

function cellColor(agent: OrchestraAgent): string {
  if (isOrchestrator(agent) && !['done', 'blocked', 'exited'].includes(agent.state))
    return agentColor(agent.id)
  return stateColor(agent.state)
}

function staticGlyph(state: AgentState): string {
  switch (state) {
    case 'done':
      return '✓'
    case 'blocked':
      return '‖'
    case 'exited':
      return '×'
    default:
      return '·'
  }
}

function agentLevel(agent: OrchestraAgent, agents: OrchestraAgent[]): number {
  if (isOrchestrator(agent) && workersOf(agents).length > 0) return overallProgress(agents) / 100
  return Math.max(0, Math.min(1, agent.progress / 100))
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/* ---------- imperative animation state ---------- */

type CellAnim = {
  level: number
  phase: number
  liquid: SVGPathElement | null
  surface: SVGPathElement | null
  spinner: SVGTextElement | null
  flash: SVGPathElement | null
  flashAt: number
  flashColor: string
  lastGlyph: string
}

type Pulse = {
  path: Cell[]
  seg: number
  u: number
  color: string
  dots: SVGCircleElement[]
  trail: Array<[number, number]>
  flashed: number
}

type EdgeFlash = { line: SVGLineElement; at: number }

const SVG_NS = 'http://www.w3.org/2000/svg'

export function HiveView() {
  const t = useHiveT()
  const agents = useSession((s) => s.agents)
  const messages = useSession((s) => s.messages)
  const selectedId = useSession((s) => s.selectedId)
  const startedAt = useSession((s) => s.startedAt)
  const { select } = useSessionActions()
  const sessionId = useSessionId()
  const scribeLines = useScribeLines(messages)

  const [size, setSize] = useState({ w: 800, h: 600 })
  const side = usePanelSize('orchestra.hive.sideWidth', 340, 260, 640)
  const [initialIds] = useState(() => new Set(agents.map((a) => a.id)))
  const clipId = `hive-clip-${useId().replace(/:/g, '')}`

  const stageRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const edgesRef = useRef<SVGGElement | null>(null)
  const pulsesRef = useRef<SVGGElement | null>(null)
  const anims = useRef(new Map<string, CellAnim>())
  const pulses = useRef<Pulse[]>([])
  const edges = useRef(new Map<string, EdgeFlash>())
  const lastSeen = useRef<number | null>(null)

  const workers = useMemo(() => workersOf(agents), [agents])
  const hasAgents = agents.length > 0
  const orchestrator = agents.find(isOrchestrator) ?? null

  const cells = useMemo(() => {
    const map = new Map<string, Cell>()
    if (orchestrator)
      map.set(orchestrator.id, { id: orchestrator.id, q: 0, r: 0, x: 0, y: 0, ring: 0 })
    workers.forEach((w, i) => {
      const slot = slotFor(i)
      map.set(w.id, { id: w.id, ...slot, ...toPixel(slot.q, slot.r) })
    })
    return map
  }, [orchestrator, workers])

  const outerRing = workers.length ? slotFor(workers.length - 1).ring : 0

  const ghosts = useMemo(() => {
    const used = new Set([...cells.values()].map((c) => hexKey(c.q, c.r)))
    const out: Point[] = []
    for (let ring = 1; ring <= outerRing + 1; ring++) {
      for (const h of ringCells(ring)) {
        if (!used.has(hexKey(h.q, h.r))) out.push(toPixel(h.q, h.r))
      }
    }
    return out
  }, [cells, outerRing])

  const targetBox = useMemo(() => {
    const n = Math.max(1, outerRing)
    const pad = R * 0.35
    let halfW = n * R * SQ3 + (R * SQ3) / 2 + pad
    let halfH = n * 1.5 * R + R + pad
    const aspect = size.w / Math.max(1, size.h)
    if (halfW / halfH < aspect) halfW = halfH * aspect
    else halfH = halfW / aspect
    return [-halfW, -halfH, halfW * 2, halfH * 2] as const
  }, [outerRing, size])

  // Values the animation loop reads every frame without re-subscribing.
  const live = useRef({
    cells,
    targetBox,
    levels: new Map<string, number>(),
    busy: new Map<string, boolean>(),
  })
  live.current = {
    cells,
    targetBox,
    levels: new Map(agents.map((a) => [a.id, agentLevel(a, agents)])),
    busy: new Map(agents.map((a) => [a.id, isBusy(a.state)])),
  }

  const animFor = (id: string): CellAnim => {
    let anim = anims.current.get(id)
    if (!anim) {
      anim = {
        level: 0,
        phase: Math.random() * 6,
        liquid: null,
        surface: null,
        spinner: null,
        flash: null,
        flashAt: 0,
        flashColor: '',
        lastGlyph: '',
      }
      anims.current.set(id, anim)
    }
    return anim
  }

  // Forget animation state of agents that left (e.g. the session was stopped).
  useEffect(() => {
    for (const id of [...anims.current.keys()]) if (!cells.has(id)) anims.current.delete(id)
  }, [cells])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasAgents])

  // Turn every newly recorded bus message into a pulse hopping along the hive.
  useEffect(() => {
    const lastId = messages.length ? messages[messages.length - 1].id : 0
    if (lastSeen.current === null) {
      lastSeen.current = lastId
      return
    }
    if (lastId < lastSeen.current) lastSeen.current = 0
    const fresh = messages.filter((m) => m.id > (lastSeen.current ?? 0)).slice(-MAX_NEW_PER_BATCH)
    lastSeen.current = lastId
    const layer = pulsesRef.current
    if (!layer) return
    const map = live.current.cells
    for (const message of fresh) {
      const color = agentColor(message.from, areaOf(agents, message.from))
      const targets =
        message.to === 'all'
          ? [...map.values()].filter((c) => c.id !== message.from && c.id !== ORCHESTRATOR_ID)
          : [map.get(message.to)].filter((c): c is Cell => Boolean(c))
      const source = map.get(message.from)
      for (const target of targets) {
        if (!source || source.id === target.id) {
          const anim = anims.current.get(target.id)
          if (anim) {
            anim.flashAt = performance.now()
            anim.flashColor = color
          }
          continue
        }
        if (pulses.current.length >= MAX_PULSES) break
        const dots = [0, 1, 2].map((i) => {
          const dot = document.createElementNS(SVG_NS, 'circle')
          dot.setAttribute('r', String(i ? 3 - i * 0.6 : 4))
          dot.setAttribute('class', styles.pulseDot)
          dot.style.fill = color
          dot.style.opacity = String(i ? 0.55 - i * 0.15 : 1)
          dot.setAttribute('cx', String(source.x))
          dot.setAttribute('cy', String(source.y))
          layer.appendChild(dot)
          return dot
        })
        pulses.current.push({
          path: route(map, source, target),
          seg: 0,
          u: 0,
          color,
          dots,
          trail: [],
          flashed: -1,
        })
      }
    }
    // `agents` only colors new pulses; `lastSeen` keeps a rerun from replaying old messages.
  }, [messages, agents])

  // Single animation loop: liquid levels, spinners, pulses, edge and arrival flashes, viewBox easing.
  useEffect(() => {
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = performance.now()
    const box = [...live.current.targetBox]
    const pulseList = pulses
    const edgeMap = edges.current

    const flashEdge = (a: Cell, b: Cell, color: string, now: number) => {
      const layer = edgesRef.current
      if (!layer) return
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      let edge = edges.current.get(key)
      if (!edge) {
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        const px = -(b.y - a.y) / len
        const py = (b.x - a.x) / len
        const h = RD * 0.46
        const line = document.createElementNS(SVG_NS, 'line')
        line.setAttribute('x1', String(mx - px * h))
        line.setAttribute('y1', String(my - py * h))
        line.setAttribute('x2', String(mx + px * h))
        line.setAttribute('y2', String(my + py * h))
        line.setAttribute('class', styles.edge)
        layer.appendChild(line)
        edge = { line, at: now }
        edges.current.set(key, edge)
      }
      edge.at = now
      edge.line.style.stroke = color
    }

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const { cells: map, levels, busy, targetBox: target } = live.current

      // Ease the viewBox so the hive zooms out smoothly when a new ring opens.
      let moved = false
      for (let i = 0; i < 4; i++) {
        const next = reduced ? target[i] : box[i] + (target[i] - box[i]) * Math.min(1, dt * 5)
        if (Math.abs(next - box[i]) > 0.01) moved = true
        box[i] = Math.abs(target[i] - next) < 0.05 ? target[i] : next
      }
      if (moved || !svgRef.current?.getAttribute('viewBox'))
        svgRef.current?.setAttribute('viewBox', box.map((v) => v.toFixed(2)).join(' '))

      const spin = SPINNER[Math.floor(now / 80) % SPINNER.length]
      for (const [id, anim] of anims.current) {
        if (!map.has(id)) continue
        const goal = levels.get(id) ?? 0
        anim.level = reduced ? goal : anim.level + (goal - anim.level) * Math.min(1, dt * 3)
        if (Math.abs(goal - anim.level) < 0.001) anim.level = goal
        const working = busy.get(id) ?? false
        const amp = reduced || anim.level <= 0.001 || anim.level >= 0.999 ? 0 : working ? 2.4 : 0.5
        if (anim.liquid && anim.surface) {
          const d = liquidPaths(anim.level, amp, now, anim.phase)
          anim.liquid.setAttribute('d', d.fill)
          anim.surface.setAttribute('d', d.surface)
        }
        if (anim.spinner && working) {
          const glyph = reduced ? SPINNER[0] : spin
          if (glyph !== anim.lastGlyph) {
            anim.spinner.textContent = glyph
            anim.lastGlyph = glyph
          }
        }
        if (anim.flash) {
          const k = Math.max(0, 1 - (now - anim.flashAt) / FLASH_MS)
          anim.flash.style.stroke = k > 0 ? anim.flashColor : 'transparent'
          anim.flash.style.strokeOpacity = k.toFixed(3)
        }
      }

      const list = pulses.current
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i]
        const finish = () => {
          p.dots.forEach((d) => d.remove())
          list.splice(i, 1)
        }
        if (p.path.length < 2) {
          finish()
          continue
        }
        let a = p.path[p.seg]
        let b = p.path[p.seg + 1]
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        p.u += reduced ? 1 : (dt * PULSE_SPEED) / len
        if (p.u >= 0.5 && p.flashed !== p.seg) {
          flashEdge(a, b, p.color, now)
          p.flashed = p.seg
        }
        if (p.u >= 1) {
          p.seg++
          p.u = 0
          const hop = anims.current.get(p.path[p.seg].id)
          if (hop) {
            hop.flashAt = now
            hop.flashColor = p.color
          }
          if (p.seg >= p.path.length - 1) {
            finish()
            continue
          }
          a = p.path[p.seg]
          b = p.path[p.seg + 1]
        }
        const u = p.u
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
        p.trail.unshift([a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e])
        if (p.trail.length > 9) p.trail.pop()
        p.dots.forEach((dot, j) => {
          const [x, y] = p.trail[Math.min(p.trail.length - 1, j * 4)]
          dot.setAttribute('cx', x.toFixed(2))
          dot.setAttribute('cy', y.toFixed(2))
        })
      }

      for (const [key, edge] of edges.current) {
        const k = Math.max(0, 1 - (now - edge.at) / EDGE_FADE_MS)
        edge.line.style.opacity = k.toFixed(3)
        if (k === 0) {
          edge.line.remove()
          edges.current.delete(key)
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      for (const p of pulseList.current) p.dots.forEach((d) => d.remove())
      pulseList.current = []
      for (const edge of edgeMap.values()) edge.line.remove()
      edgeMap.clear()
    }
  }, [])

  if (agents.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.layout}>
          <div className={styles.empty}>
            <svg className={styles.emptyMark} viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`} aria-hidden>
              <path d={HEX_D} />
            </svg>
            <h2 className={styles.emptyTitle}>{t('orchestra.hive.emptyTitle')}</h2>
            <p className={styles.emptyBody}>{t('orchestra.hive.emptyBody')}</p>
          </div>
        </div>
      </div>
    )
  }

  // The panel follows the selection, never the pointer: its box (and Enter) must not switch to
  // whatever cell the mouse crosses while the user types.
  const focusId =
    (selectedId && cells.has(selectedId) ? selectedId : null) ?? orchestrator?.id ?? agents[0].id
  const focused = agents.find((a) => a.id === focusId) ?? agents[0]
  const blocked = workers.filter((w) => w.state === 'blocked').length
  const recent = messages.slice(-3)

  const onCellKey = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(id)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.layout} style={{ '--hive-side': `${side.size}px` } as CSSProperties}>
        <section className={styles.stage}>
          <header className={styles.legend}>
            <span className={styles.legendTitle}>{t('orchestra.hive.title')}</span>
            <span className={styles.legendItem}>
              <i className={styles.legendDot} style={{ background: agentColor(ORCHESTRATOR_ID) }} />
              {t('orchestra.hive.legendOrchestrator')}
            </span>
            <span className={styles.legendItem}>
              <i className={styles.legendDot} style={{ background: agentColor('claude-1') }} />
              {t('orchestra.hive.legendWorker')}
            </span>
            <span className={styles.legendItem}>{t('orchestra.hive.legendLevel')}</span>
            <ScribeBadge
              className={styles.legendScribe}
              sessionId={sessionId}
              count={scribeLines.length}
            />
          </header>

          <div className={styles.canvas} ref={stageRef}>
            {/* The SVG viewBox still eases to fit new rings; the canvas adds user zoom and pan. */}
            <ZoomCanvas
              contentWidth={size.w}
              contentHeight={size.h}
              label={t('orchestra.hive.gridLabel')}
              fitPadding={0}
              minZoom={0.4}
              maxZoom={4}
            >
              <svg
                ref={svgRef}
                className={styles.svg}
                width={size.w}
                height={size.h}
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-label={t('orchestra.hive.gridLabel')}
              >
                <defs>
                  <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
                    <path d={HEX_D} />
                  </clipPath>
                </defs>
                <g aria-hidden>
                  {ghosts.map((p) => (
                    <path
                      key={`${p.x.toFixed(1)},${p.y.toFixed(1)}`}
                      d={HEX_D}
                      className={styles.ghost}
                      transform={`translate(${p.x} ${p.y})`}
                    />
                  ))}
                </g>
                <g ref={edgesRef} aria-hidden />
                <g>
                  {agents.map((agent) => {
                    const cell = cells.get(agent.id)
                    if (!cell) return null
                    return (
                      <HexCell
                        key={agent.id}
                        agent={agent}
                        cell={cell}
                        clipId={clipId}
                        born={!initialIds.has(agent.id)}
                        selected={agent.id === selectedId}
                        overall={overallProgress(agents)}
                        hasWorkers={workers.length > 0}
                        blocked={blocked}
                        t={t}
                        anim={animFor(agent.id)}
                        onSelect={select}
                        onKey={onCellKey}
                      />
                    )
                  })}
                </g>
                <g ref={pulsesRef} aria-hidden />
              </svg>
            </ZoomCanvas>
            {workers.length === 0 && (
              <p className={styles.waiting}>{t('orchestra.hive.waitingWorkers')}</p>
            )}
          </div>

          <footer className={styles.bus}>
            <div className={styles.busHead}>
              <span>{t('orchestra.hive.lastMessages')}</span>
              <span className={styles.busCount}>{messages.length}</span>
            </div>
            {recent.length === 0 ? (
              <div className={styles.busEmpty}>{t('orchestra.hive.noMessages')}</div>
            ) : (
              recent.map((m) => (
                <BusLine
                  key={m.id}
                  message={m}
                  agents={agents}
                  startedAt={startedAt}
                  you={t('orchestra.hive.you')}
                />
              ))
            )}
          </footer>
        </section>

        <HiveSide
          agent={focused}
          agents={agents}
          messages={messages}
          startedAt={startedAt}
          t={t}
          splitter={
            <div className={styles.sideSplit}>
              <Splitter panel={side} axis="x" />
            </div>
          }
        />
      </div>
    </div>
  )
}

/* ---------- hex cell ---------- */

type HexCellProps = {
  agent: OrchestraAgent
  cell: Cell
  clipId: string
  born: boolean
  selected: boolean
  overall: number
  hasWorkers: boolean
  blocked: number
  t: HiveT
  anim: CellAnim
  onSelect: (id: string) => void
  onKey: (event: KeyboardEvent<SVGGElement>, id: string) => void
}

function HexCell({
  agent,
  cell,
  clipId,
  born,
  selected,
  overall,
  hasWorkers,
  blocked,
  t,
  anim,
  onSelect,
  onKey,
}: HexCellProps) {
  const orch = isOrchestrator(agent)
  const busy = isBusy(agent.state)
  const color = cellColor(agent)
  const stateLabel = t((endedByUserKey(agent) ?? `orchestra.hive.state.${agent.state}`) as HiveKey)
  const progress = orch && hasWorkers ? overall : Math.round(agent.progress)
  const nameChars = agent.id.length + 2
  const x0 = (-nameChars * CHAR_W) / 2
  const nameY = -26

  return (
    // Position on a plain wrapper: visual-clean.css sets `transform: none` on
    // [role='button']:hover, which overrides an SVG transform attribute and threw the
    // hovered cell to the origin.
    <g transform={`translate(${cell.x} ${cell.y})`}>
      <g
        className={styles.cell}
        style={{ '--hex-c': color } as CSSProperties}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={t('orchestra.hive.cellLabel', {
          id: agent.id,
          area: agent.area,
          state: stateLabel,
          progress,
        })}
        onClick={() => onSelect(agent.id)}
        onKeyDown={(e) => onKey(e, agent.id)}
      >
        <title>{agent.task ? `${agent.id} · ${agent.area}\n${agent.task}` : agent.id}</title>
        <g className={born ? styles.born : undefined}>
          <path d={HEX_D} className={styles.hexBg} />
          <g clipPath={`url(#${clipId})`}>
            <path
              className={styles.liquid}
              ref={(el) => {
                anim.liquid = el
              }}
            />
            <path
              className={styles.surface}
              ref={(el) => {
                anim.surface = el
              }}
            />
          </g>
          {orch && <path d={HEX_INNER_D} className={styles.orchRing} />}
          <path d={HEX_RING_D} className={selected ? styles.selRing : styles.ring} />
          <path
            d={HEX_D}
            className={styles.flash}
            ref={(el) => {
              anim.flash = el
            }}
          />

          {agent.state === 'waiting' ? (
            <Lock
              x={x0 - 0.5}
              y={nameY - 8}
              width={9}
              height={9}
              className={styles.glyphIcon}
              aria-hidden
            />
          ) : busy ? (
            <text
              key="spin"
              x={x0}
              y={nameY}
              className={styles.glyph}
              ref={(el) => {
                anim.spinner = el
                if (el) anim.lastGlyph = ''
              }}
            />
          ) : (
            <text key="static" x={x0} y={nameY} className={styles.glyph}>
              {orch && agent.state !== 'done' && agent.state !== 'blocked'
                ? '◆'
                : staticGlyph(agent.state)}
            </text>
          )}
          <text x={x0 + CHAR_W * 2} y={nameY} className={styles.name}>
            {agent.id}
          </text>

          {orch ? (
            <>
              <text y={2} className={styles.orchPct}>
                {progress}%
              </text>
              <text y={20} className={styles.state}>
                {stateLabel}
              </text>
              {blocked > 0 && (
                <text y={35} className={styles.blockedNote}>
                  {t('orchestra.hive.blockedCount', { count: blocked })}
                </text>
              )}
            </>
          ) : (
            <>
              <text y={0} className={styles.area}>
                {isCreativeArea(agent.area) ? (
                  <tspan style={{ fill: 'var(--agent-creative)' }}>✦ </tspan>
                ) : null}
                {truncate(agent.area, AREA_CHARS)}
              </text>
              <text y={19} className={styles.pct}>
                {progress}%
              </text>
              <text
                y={34}
                className={agent.state === 'blocked' ? styles.blockedNote : styles.state}
              >
                {stateLabel}
              </text>
            </>
          )}
        </g>
      </g>
    </g>
  )
}

/* ---------- bus strip ---------- */

function BusLine({
  message,
  agents,
  startedAt,
  you,
}: {
  message: BusMessage
  agents: OrchestraAgent[]
  startedAt: number
  you: string
}) {
  const name = (id: string) => (id === 'you' ? you : id)
  const color = (id: string) => agentColor(id, areaOf(agents, id))
  return (
    <div className={styles.busLine}>
      <span className={styles.busTime}>{busClock(message.at, startedAt)}</span>
      <span style={{ color: color(message.from) }}>{name(message.from)}</span>
      <span className={styles.busArrow}>→</span>
      <span style={{ color: color(message.to) }}>{name(message.to)}</span>
      <span className={styles.busText}>{message.text}</span>
    </div>
  )
}

/* ---------- side panel ---------- */

type HiveSideProps = {
  splitter?: ReactNode
  agent: OrchestraAgent
  agents: OrchestraAgent[]
  messages: BusMessage[]
  startedAt: number
  t: HiveT
}

function HiveSide({ agent, agents, messages, startedAt, t, splitter }: HiveSideProps) {
  const goal = useSession((s) => s.goal)
  const { select, sendTo } = useSessionActions()
  const tAll = useT()
  const sessionId = useSessionId()
  // The same per-agent draft as the agent drawer: text for one agent never goes to another.
  const [draft, setDraft] = useDraftText(draftKey.agent(sessionId, agent.id))
  const inputRef = useRef<HTMLInputElement>(null)
  const [, setTick] = useState(0)
  const running = agent.finishedAt === null && agent.state !== 'exited'

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const orch = isOrchestrator(agent)
  const hasWorkers = workersOf(agents).length > 0
  const progress = orch && hasWorkers ? overallProgress(agents) : Math.round(agent.progress)
  const color = cellColor(agent)
  const own = messagesFor(messages, agent.id)
  const shown = own.slice(-8).reverse()
  const lines = agent.lines.slice(-8)
  const busy = isBusy(agent.state)
  // A worker that has not started takes messages too: they wait in its queue.
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const canSend = !processEnded(agent) && !stopped
  const name = (id: string) => (id === 'you' ? t('orchestra.hive.you') : id)
  const task = orch ? goal : agent.task

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !canSend) return
    void sendTo(agent.id, text)
    setDraft('')
  }

  return (
    <aside className={styles.side} style={{ '--hex-c': color } as CSSProperties}>
      {splitter}
      <div className={styles.sideHead}>
        <div className={styles.sideRow}>
          <span className={styles.sideGlyph}>
            {agent.state === 'waiting' ? (
              <Lock size={12} aria-hidden />
            ) : busy ? (
              SPINNER[0]
            ) : orch && agent.state !== 'done' && agent.state !== 'blocked' ? (
              '◆'
            ) : (
              staticGlyph(agent.state)
            )}
          </span>
          <span className={styles.sideName}>{agent.id}</span>
          {!orch && <CreativeMark area={agent.area} />}
          {!orch && <span className={styles.chip}>{agent.area}</span>}
          <span className={styles.sideState}>
            <i />
            {t((endedByUserKey(agent) ?? `orchestra.hive.state.${agent.state}`) as HiveKey)}
          </span>
        </div>
        <div className={styles.sideProgress}>
          <span className={styles.sideBig}>{progress}%</span>
          <span className={styles.sideSub}>
            {orch ? t('orchestra.hive.overall') : t('orchestra.hive.taskProgress')}
          </span>
          <button
            type="button"
            className={styles.termButton}
            onClick={() => select(agent.id)}
            disabled={!agent.ptyId}
            aria-label={t('orchestra.hive.openTerminalOf', { id: agent.id })}
            title={t('orchestra.hive.openTerminalOf', { id: agent.id })}
          >
            <SquareTerminal size={13} aria-hidden />
            {t('orchestra.hive.openTerminal')}
          </button>
        </div>
        <div className={styles.sideBar}>
          <i style={{ width: `${progress}%` }} />
        </div>
      </div>
      <AgentAlert agent={agent} onReply={canSend ? () => inputRef.current?.focus() : undefined} />

      <div className={styles.sideBody}>
        <section className={styles.sec}>
          <div className={styles.secHead}>
            {orch ? t('orchestra.hive.goal') : t('orchestra.hive.task')}
          </div>
          <p className={styles.task}>{task || t('orchestra.hive.noTask')}</p>
          {agent.state === 'waiting' && agent.after.length > 0 && (
            <p className={styles.waitsFor}>
              <Lock size={11} aria-hidden />
              {t('orchestra.hive.waitsFor', { deps: agent.after.join(', ') })}
            </p>
          )}
        </section>

        {agent.note && (
          <section className={styles.sec}>
            <div className={styles.secHead}>{t('orchestra.hive.note')}</div>
            <p className={styles.note}>{agent.note}</p>
          </section>
        )}

        <section className={styles.sec}>
          <div className={styles.stats}>
            <div>
              <b>{agent.toolCalls}</b>
              <span>{t('orchestra.hive.statTools')}</span>
            </div>
            <div>
              <b>{agent.files.length}</b>
              <span>{t('orchestra.hive.statFiles')}</span>
            </div>
            <div>
              <b>{elapsed(agent.startedAt, agent.finishedAt ?? Date.now())}</b>
              <span>{t('orchestra.hive.statActive')}</span>
            </div>
            <div>
              <b>{own.length}</b>
              <span>{t('orchestra.hive.statMessages')}</span>
            </div>
          </div>
        </section>

        <section className={styles.sec}>
          <div className={styles.secHead}>{t('orchestra.hive.activity')}</div>
          <div className={styles.term}>
            {lines.length === 0 ? (
              <div className={styles.toneNote}>{t('orchestra.hive.noActivity')}</div>
            ) : (
              lines.map((line, i) => (
                <div
                  key={`${line.at}-${i}`}
                  className={`${styles[`tone_${line.tone}`] ?? ''} ${
                    i === lines.length - 1 && busy ? styles.cursor : ''
                  }`}
                  title={line.text}
                >
                  {line.text}
                </div>
              ))
            )}
          </div>
        </section>

        <section className={styles.sec}>
          <div className={styles.secHead}>
            <span>{t('orchestra.hive.messages')}</span>
            <span>{own.length}</span>
          </div>
          {shown.length === 0 ? (
            <div className={styles.emptyLine}>{t('orchestra.hive.noMessages')}</div>
          ) : (
            <ul className={styles.msgList}>
              {shown.map((m) => (
                <li key={m.id} className={styles.msg}>
                  <div className={styles.msgHead}>
                    <span>{busClock(m.at, startedAt)}</span>
                    <span style={{ color: agentColor(m.from, areaOf(agents, m.from)) }}>
                      {name(m.from)}
                    </span>
                    →
                    <span style={{ color: agentColor(m.to, areaOf(agents, m.to)) }}>
                      {name(m.to)}
                    </span>
                    <DeliveryMark message={m} compact />
                  </div>
                  <div className={styles.msgBody}>{m.text}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <form className={styles.composer} onSubmit={submit}>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('orchestra.hive.composerPlaceholder', { id: agent.id })}
          aria-label={t('orchestra.hive.composerLabel', { id: agent.id })}
          disabled={!canSend}
        />
        <button
          type="submit"
          className={styles.send}
          disabled={!canSend || !draft.trim()}
          title={tAll('orchestra.agents.sendTo', { id: agent.id })}
        >
          {tAll('orchestra.agents.sendTo', { id: agent.id })}
        </button>
      </form>
    </aside>
  )
}
