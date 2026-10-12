import { Minus, Plus } from 'lucide-react'
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type ActivityKind,
  type AgentState,
  type BusMessage,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
  type Segment,
} from '../../../stores/orchestraStore'
import { Splitter } from '../canvas/Splitter'
import { usePanelSize } from '../canvas/usePanelSize'
import { CreativeMark } from '../creative/CreativeMark'
import { timelineEn } from '../i18n/timeline'
import { SCRIBE_ID } from '../scribe/identity'
import { ScribeLaneLabel, ScribeLaneSummary, ScribeTick } from '../scribe/ScribeMarks'
import { useScribeLines } from '../scribe/useScribe'
import {
  useSession,
  useSessionActions,
  useSessionFocusGetter,
  useSessionId,
} from '../sessionContext'
import {
  activityColor,
  agentColor,
  areaOf,
  busClock,
  endedByUserKey,
  isOrchestrator,
  stateColor,
  workersOf,
} from '../shared'
import styles from './TimelineView.module.css'

type Key = keyof typeof timelineEn
type Tr = (key: Key, params?: Record<string, string | number>) => string

/** Typed wrapper so this view only uses its own keys, before and after the shell merges them. */
function useTr(): Tr {
  const t = useT()
  return (key, params) => t(key as string as MessageKey, params)
}

const kindKey = (kind: ActivityKind) => `orchestra.timeline.kind.${kind}` as Key
const stateKey = (state: AgentState) => `orchestra.timeline.state.${state}` as Key
/** The view's word for a state; the shared one for an agent the user stopped or cancelled. */
const stateText = (agent: OrchestraAgent, tr: Tr) =>
  tr((endedByUserKey(agent) ?? stateKey(agent.state)) as Key)

const KINDS: ActivityKind[] = [
  'thinking',
  'reading',
  'editing',
  'testing',
  'running',
  'blocked',
  'idle',
]
const RULER_H = 24
const LANE_H = 44
const BLOCK_PAD = 10
const MIN_SPAN = 5_000
const DEFAULT_FOLLOW_SPAN = 120_000
const STEP_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
const NUDGE_MS = 5_000

/** fit: whole session; follow: last `span` ms, live; window: `span` ms ending at `end`, panned. */
type Zoom =
  { mode: 'fit' } | { mode: 'follow'; span: number } | { mode: 'window'; span: number; end: number }

const DRAG_THRESHOLD = 3

type Tip = { kind: 'segment'; segment: Segment } | { kind: 'message'; message: BusMessage }

/** Elapsed label for the ruler and tooltips: m:ss or h:mm:ss. */
function relLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function spanLabel(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m}m${String(rest).padStart(2, '0')}s` : `${m}m`
}

/** Wall clock that advances while the view is mounted, throttled to a few frames per second. */
function useLiveNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    let last = 0
    const loop = (ts: number) => {
      if (ts - last >= 200) {
        last = ts
        setNow(Date.now())
      }
      frame = window.requestAnimationFrame(loop)
    }
    frame = window.requestAnimationFrame(loop)
    return () => window.cancelAnimationFrame(frame)
  }, [enabled])
  return now
}

function useWidth(ref: RefObject<HTMLElement>, enabled: boolean): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, enabled])
  return width
}

export function TimelineView() {
  const tr = useTr()
  const agents = useSession((s) => s.agents)
  const segments = useSession((s) => s.segments)
  const messages = useSession((s) => s.messages)
  const startedAt = useSession((s) => s.startedAt)
  const goal = useSession((s) => s.goal)
  const selectedId = useSession((s) => s.selectedId)
  const { select } = useSessionActions()
  const hasFocus = useSessionFocusGetter()
  const sessionId = useSessionId()
  const scribeLines = useScribeLines(messages)

  const hasSession = agents.length > 0
  // A stopped session's timeline ends where it was stopped.
  const stoppedAt = useSession((s) => s.stoppedAt ?? null)
  const liveNow = useLiveNow(hasSession && stoppedAt === null)
  const now = stoppedAt ?? liveNow
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' })
  const [pinned, setPinned] = useState<number | null>(null)
  const [hover, setHover] = useState<{ t: number; x: number; y: number } | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const lanesPanel = usePanelSize('orchestra.timeline.lanesHeight', 320, 120, 900)
  const panRef = useRef<{ x: number; end: number; moved: boolean } | null>(null)
  const [panning, setPanning] = useState(false)

  const tlRef = useRef<HTMLDivElement>(null)
  const width = useWidth(tlRef, hasSession)
  const hatchId = `hatch-${useId().replace(/:/g, '')}`

  const lanes = useMemo(() => {
    const orchestrator = agents.find((a) => isOrchestrator(a))
    return orchestrator ? [orchestrator, ...workersOf(agents)] : workersOf(agents)
  }, [agents])
  const laneIndex = useMemo(() => new Map(lanes.map((a, i) => [a.id, i])), [lanes])

  const t0 = startedAt || now
  const tEnd = Math.max(now, t0 + MIN_SPAN)
  const total = tEnd - t0
  const span = zoom.mode === 'fit' ? total : Math.min(zoom.span, total)
  const to = zoom.mode === 'window' ? Math.min(Math.max(zoom.end, t0 + span), tEnd) : tEnd
  const from = zoom.mode === 'fit' ? t0 : to - span
  const plotW = Math.max(1, width - 8)
  const xOf = (t: number) => ((t - from) / (to - from)) * plotW
  const tOf = (x: number) => from + (x / plotW) * (to - from)
  // The Obsidian scribe gets the last lane: one tick per block it wrote.
  const scribeLane = lanes.length
  const height = RULER_H + (lanes.length + 1) * LANE_H
  const cursor = pinned ?? hover?.t ?? null

  // Ctrl+wheel zoom needs a non-passive listener to keep the page from zooming/scrolling.
  const totalRef = useRef(total)
  totalRef.current = total
  useEffect(() => {
    const el = tlRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      setZoom((current) => zoomBy(current, totalRef.current, event.deltaY < 0 ? 1 / 1.25 : 1.25))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasSession])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!hasFocus()) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.xterm, input, textarea, [contenteditable="true"]')) return
      if (event.key === 'Escape' && pinned !== null) {
        setPinned(null)
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && pinned !== null) {
        event.preventDefault()
        const delta = event.key === 'ArrowLeft' ? -NUDGE_MS : NUDGE_MS
        setPinned((p) => (p === null ? p : Math.min(Math.max(p + delta, t0), tEnd)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasFocus, pinned, t0, tEnd])

  if (!hasSession) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{tr('orchestra.timeline.emptyTitle')}</p>
          <p className={styles.emptyBody}>{tr('orchestra.timeline.emptyBody')}</p>
        </div>
      </div>
    )
  }

  const pointer = (event: ReactMouseEvent) => {
    const rect = tlRef.current?.getBoundingClientRect()
    if (!rect) return null
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    return { x, y, t: Math.min(Math.max(tOf(x), t0), tEnd) }
  }

  // Ruler ticks: the smallest step that keeps labels at least ~80px apart.
  const stepMs =
    (STEP_SECONDS.find((s) => ((to - from) / (s * 1000)) * 80 <= plotW) ??
      STEP_SECONDS[STEP_SECONDS.length - 1]) * 1000
  const ticks: number[] = []
  for (let t = Math.ceil((from - t0) / stepMs) * stepMs + t0; t <= to; t += stepMs) ticks.push(t)

  const laneTop = (i: number) => RULER_H + i * LANE_H
  const laneMid = (i: number) => laneTop(i) + LANE_H / 2

  const visibleSegments = segments.filter(
    (s) => (s.end ?? now) >= from && s.start <= to && laneIndex.has(s.agentId),
  )
  const visibleMessages = messages.filter((m) => m.at >= from && m.at <= to)

  const arcTargets = (m: BusMessage): number[] => {
    if (m.to === 'all')
      return lanes
        .filter((a) => !isOrchestrator(a) && a.id !== m.from)
        .map((a) => laneIndex.get(a.id)!)
    const i = laneIndex.get(m.to)
    return i === undefined ? [] : [i]
  }

  const arcColor = (m: BusMessage) =>
    m.from === ORCHESTRATOR_ID
      ? agentColor(ORCHESTRATOR_ID)
      : m.from === 'you'
        ? agentColor('you')
        : agentColor(m.from, areaOf(agents, m.from))

  const who = (id: string) =>
    id === 'you' ? tr('orchestra.timeline.you') : id === 'all' ? tr('orchestra.timeline.all') : id

  const tipNode = (() => {
    if (!tip || !hover) return null
    const style = { left: Math.min(hover.x + 14, Math.max(0, width - 300)), top: hover.y + 14 }
    if (tip.kind === 'segment') {
      const s = tip.segment
      const end = s.end ?? now
      return (
        <div className={styles.tip} style={style}>
          <div className={styles.tipHead}>
            <i style={{ background: activityColor(s.kind) }} />
            {s.agentId} · {tr(kindKey(s.kind))}
          </div>
          <div className={styles.tipRow}>
            <span>{tr('orchestra.timeline.started')}</span>
            <span>{relLabel(s.start - t0)}</span>
          </div>
          <div className={styles.tipRow}>
            <span>{tr('orchestra.timeline.duration')}</span>
            <span>
              {relLabel(end - s.start)}
              {s.end === null ? ` · ${tr('orchestra.timeline.ongoing')}` : ''}
            </span>
          </div>
        </div>
      )
    }
    const m = tip.message
    return (
      <div className={styles.tip} style={style}>
        <div className={styles.tipHead}>
          <i style={{ background: arcColor(m) }} />
          {who(m.from)} → {who(m.to)}
        </div>
        <div className={styles.tipText}>{m.text}</div>
        <div className={styles.tipRow}>
          <span>{tr('orchestra.timeline.at')}</span>
          <span>{busClock(m.at, t0)}</span>
        </div>
      </div>
    )
  })()

  return (
    <div className={styles.root}>
      <header className={styles.toolbar}>
        <span className={styles.goalKey}>{tr('orchestra.timeline.goal')}</span>
        <span className={styles.goal} title={goal}>
          {goal || tr('orchestra.timeline.noGoal')}
        </span>
        {pinned === null ? (
          <span className={styles.pill} data-live>
            <i />
            {tr('orchestra.timeline.live')}
          </span>
        ) : (
          <button
            type="button"
            className={styles.pill}
            onClick={() => setPinned(null)}
            title={tr('orchestra.timeline.backToLive')}
          >
            <i />
            {tr('orchestra.timeline.pinned')}
          </button>
        )}
        <span className={styles.clock}>{busClock(cursor ?? now, t0)}</span>
        <div className={styles.seg} role="group">
          <button
            type="button"
            aria-pressed={zoom.mode === 'fit'}
            title={tr('orchestra.timeline.fitTitle')}
            onClick={() => setZoom({ mode: 'fit' })}
          >
            {tr('orchestra.timeline.fit')}
          </button>
          <button
            type="button"
            aria-pressed={zoom.mode === 'follow'}
            title={tr('orchestra.timeline.followTitle', {
              span: spanLabel(zoom.mode === 'follow' ? zoom.span : DEFAULT_FOLLOW_SPAN),
            })}
            onClick={() =>
              setZoom((z) =>
                z.mode === 'follow'
                  ? z
                  : {
                      mode: 'follow',
                      span:
                        z.mode === 'window'
                          ? z.span
                          : Math.min(DEFAULT_FOLLOW_SPAN, Math.max(MIN_SPAN, total)),
                    },
              )
            }
          >
            {tr('orchestra.timeline.follow')}
            {zoom.mode === 'follow' ? <span className={styles.span}>{spanLabel(span)}</span> : null}
          </button>
        </div>
        <button
          type="button"
          className={styles.iconBtn}
          title={tr('orchestra.timeline.zoomOut')}
          onClick={() => setZoom((z) => zoomBy(z, total, 1.5))}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title={tr('orchestra.timeline.zoomIn')}
          onClick={() => setZoom((z) => zoomBy(z, total, 1 / 1.5))}
        >
          <Plus size={13} />
        </button>
        {pinned !== null ? (
          <button type="button" className={styles.btn} onClick={() => setPinned(null)}>
            {tr('orchestra.timeline.backToLive')}
          </button>
        ) : null}
      </header>

      <section className={styles.seq} style={{ maxHeight: lanesPanel.size }}>
        <div className={styles.labels}>
          <div className={styles.colHead}>{tr('orchestra.timeline.agents')}</div>
          {lanes.map((agent) => (
            <LaneLabel
              key={agent.id}
              agent={agent}
              selected={selectedId === agent.id}
              onSelect={select}
              tr={tr}
            />
          ))}
          <ScribeLaneLabel sessionId={sessionId} className={styles.lane} />
        </div>

        <div
          ref={tlRef}
          className={styles.timeline}
          data-pannable={span < total || undefined}
          data-panning={panning || undefined}
          onMouseDown={(e) => {
            // Drag pans along time when zoomed in; a click without movement still pins.
            if (e.button !== 0 || span >= total) return
            panRef.current = { x: e.clientX, end: to, moved: false }
          }}
          onMouseMove={(e) => {
            const pan = panRef.current
            if (pan && e.buttons & 1) {
              const dx = e.clientX - pan.x
              if (pan.moved || Math.abs(dx) >= DRAG_THRESHOLD) {
                if (!pan.moved) setPanning(true)
                pan.moved = true
                const end = Math.min(Math.max(pan.end - (dx / plotW) * span, t0 + span), tEnd)
                setZoom(end >= tEnd ? { mode: 'follow', span } : { mode: 'window', span, end })
                setTip(null)
                return
              }
            }
            setHover(pointer(e))
          }}
          onMouseUp={() => setPanning(false)}
          onMouseLeave={() => {
            panRef.current = null
            setPanning(false)
            setHover(null)
            setTip(null)
          }}
          onClick={(e) => {
            const pan = panRef.current
            panRef.current = null
            if (pan?.moved) return
            const p = pointer(e)
            if (p) setPinned(p.t)
          }}
        >
          <svg
            width={Math.max(1, width)}
            height={height}
            role="img"
            aria-label={tr('orchestra.timeline.timelineLabel')}
          >
            <defs>
              <pattern
                id={hatchId}
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1="0" y1="0" x2="0" y2="5" className={styles.hatchLine} />
              </pattern>
            </defs>

            {lanes.map((agent, i) => (
              <rect
                key={`bg-${agent.id}`}
                x={0}
                y={laneTop(i)}
                width={Math.max(1, width)}
                height={LANE_H}
                className={`${styles.laneBg} ${i === 0 && isOrchestrator(agent) ? styles.laneOrchestrator : ''} ${selectedId === agent.id ? styles.laneSelected : ''}`}
              />
            ))}
            <rect
              x={0}
              y={laneTop(scribeLane)}
              width={Math.max(1, width)}
              height={LANE_H}
              className={`${styles.laneBg} ${styles.laneScribe}`}
            />

            {ticks.map((t) => {
              const x = xOf(t)
              return (
                <g key={t}>
                  <line x1={x} x2={x} y1={RULER_H - 6} y2={height} className={styles.gridLine} />
                  <text x={x + 4} y={RULER_H - 9} className={styles.tickLabel}>
                    {relLabel(t - t0)}
                  </text>
                </g>
              )
            })}
            <line
              x1={0}
              x2={Math.max(1, width)}
              y1={RULER_H - 0.5}
              y2={RULER_H - 0.5}
              className={styles.rulerLine}
            />

            {lanes.length > 0 && visibleSegments.length === 0
              ? lanes.map((agent, i) => (
                  <text
                    key={`na-${agent.id}`}
                    x={8}
                    y={laneMid(i) + 4}
                    className={styles.noActivity}
                  >
                    {tr('orchestra.timeline.noActivity')}
                  </text>
                ))
              : null}

            {visibleSegments.map((s) => {
              const lane = laneIndex.get(s.agentId)!
              const x1 = Math.max(0, xOf(s.start))
              const x2 = Math.min(plotW, xOf(s.end ?? now))
              const w = Math.max(1, x2 - x1)
              const y = laneTop(lane) + BLOCK_PAD
              const h = LANE_H - BLOCK_PAD * 2
              const color = activityColor(s.kind)
              const hoverProps = {
                onMouseEnter: () => setTip({ kind: 'segment', segment: s }),
                onMouseLeave: () => setTip(null),
              }
              if (s.kind === 'idle') {
                return (
                  <rect
                    key={`${s.agentId}-${s.start}`}
                    x={x1}
                    y={y + 0.5}
                    width={w}
                    height={h - 1}
                    className={styles.blockIdle}
                    style={{ stroke: color }}
                    {...hoverProps}
                  />
                )
              }
              return (
                <g key={`${s.agentId}-${s.start}`} {...hoverProps} className={styles.block}>
                  <rect
                    x={x1}
                    y={y}
                    width={w}
                    height={h}
                    style={s.kind === 'blocked' ? undefined : { fill: color }}
                    fill={s.kind === 'blocked' ? `url(#${hatchId})` : undefined}
                    className={s.kind === 'blocked' ? undefined : styles.blockFill}
                  />
                  <rect x={x1} y={y} width={w} height={2} style={{ fill: color }} />
                </g>
              )
            })}

            {visibleMessages.map((m) => {
              const x = xOf(m.at)
              const fromLane = laneIndex.get(m.from)
              const y1 = fromLane === undefined ? RULER_H : laneMid(fromLane)
              const color = arcColor(m)
              return arcTargets(m).map((target) => {
                if (target === fromLane) return null
                const y2 = laneMid(target)
                const bulge = 8 + Math.min(28, Math.abs(y2 - y1) * 0.22)
                const d = `M ${x} ${y1} Q ${x + bulge} ${(y1 + y2) / 2} ${x} ${y2}`
                const active = tip?.kind === 'message' && tip.message.id === m.id
                return (
                  <g
                    key={`${m.id}-${target}`}
                    onMouseEnter={() => setTip({ kind: 'message', message: m })}
                    onMouseLeave={() => setTip(null)}
                    onClick={(e) => {
                      e.stopPropagation()
                      setPinned(m.at)
                    }}
                    className={styles.arc}
                    data-active={active || undefined}
                  >
                    <path d={d} className={styles.arcHit} />
                    <path d={d} className={styles.arcLine} style={{ stroke: color }} />
                    <circle cx={x} cy={y1} r={2} style={{ fill: color }} />
                    <circle
                      cx={x}
                      cy={y2}
                      r={2.6}
                      className={styles.arcHead}
                      style={{ stroke: color }}
                    />
                  </g>
                )
              })
            })}

            {scribeLines
              .filter((m) => m.at >= from && m.at <= to)
              .map((m) => (
                <ScribeTick
                  key={`scribe-${m.id}`}
                  x={xOf(m.at)}
                  y={laneTop(scribeLane)}
                  height={LANE_H}
                  onEnter={() => setTip({ kind: 'message', message: m })}
                  onLeave={() => setTip(null)}
                  onPick={() => setPinned(m.at)}
                />
              ))}

            {now >= from && now <= to ? (
              <line
                x1={xOf(now)}
                x2={xOf(now)}
                y1={RULER_H}
                y2={height}
                className={styles.nowLine}
              />
            ) : null}
            {cursor !== null && cursor >= from && cursor <= to ? (
              <g className={pinned !== null ? styles.playheadPinned : styles.playhead}>
                <line x1={xOf(cursor)} x2={xOf(cursor)} y1={0} y2={height} />
              </g>
            ) : null}
          </svg>
          {tipNode}
        </div>

        <div className={styles.summary}>
          <div className={styles.colHead}>{tr('orchestra.timeline.progress')}</div>
          {lanes.map((agent) => (
            <LaneSummary key={agent.id} agent={agent} tr={tr} />
          ))}
          <ScribeLaneSummary count={scribeLines.length} className={styles.lane} />
        </div>
      </section>

      <Splitter panel={lanesPanel} axis="y" />

      <Legend tr={tr} />

      <BusLog
        messages={messages}
        agents={agents}
        t0={t0}
        cursor={cursor}
        pinned={pinned !== null}
        onPick={(m) => {
          setPinned(m.at)
          if (m.at < from) setZoom({ mode: 'fit' })
        }}
        who={who}
        tr={tr}
      />
    </div>
  )
}

function zoomBy(current: Zoom, total: number, factor: number): Zoom {
  const span = current.mode === 'fit' ? total : Math.min(current.span, total)
  const next = Math.max(MIN_SPAN, span * factor)
  if (next >= total) return { mode: 'fit' }
  // A panned window zooms around its center and stays where the user left it.
  if (current.mode === 'window')
    return { mode: 'window', span: next, end: current.end - (span - next) / 2 }
  return { mode: 'follow', span: next }
}

function LaneLabel({
  agent,
  selected,
  onSelect,
  tr,
}: {
  agent: OrchestraAgent
  selected: boolean
  onSelect: (id: string) => void
  tr: Tr
}) {
  const orchestrator = isOrchestrator(agent)
  return (
    <button
      type="button"
      className={`${styles.lane} ${styles.label} ${orchestrator ? styles.labelOrchestrator : ''} ${selected ? styles.labelSelected : ''}`}
      onClick={() => onSelect(agent.id)}
      title={tr('orchestra.timeline.selectAgent', { id: agent.id })}
    >
      <span className={styles.dot} style={{ background: stateColor(agent.state) }} />
      <span className={styles.labelText}>
        <span className={styles.labelId} style={{ color: agentColor(agent.id, agent.area) }}>
          {agent.id}
          <CreativeMark area={agent.area} inline />
        </span>
        <span className={styles.labelArea} title={agent.task}>
          {orchestrator ? stateText(agent, tr) : agent.area || agent.task}
        </span>
      </span>
    </button>
  )
}

function LaneSummary({ agent, tr }: { agent: OrchestraAgent; tr: Tr }) {
  const color = isOrchestrator(agent) ? agentColor(ORCHESTRATOR_ID) : stateColor(agent.state)
  return (
    <div
      className={`${styles.lane} ${styles.sum} ${isOrchestrator(agent) ? styles.labelOrchestrator : ''}`}
    >
      <span className={styles.sumPct}>{agent.progress}%</span>
      <span className={styles.sumState} style={{ color: stateColor(agent.state) }}>
        {stateText(agent, tr)}
      </span>
      <span className={styles.sumBar}>
        <i style={{ width: `${agent.progress}%`, background: color }} />
      </span>
      <span className={styles.sumMeta}>
        {tr('orchestra.timeline.tools', { count: agent.toolCalls })} ·{' '}
        {tr('orchestra.timeline.files', { count: agent.files.length })}
      </span>
    </div>
  )
}

function Legend({ tr }: { tr: Tr }) {
  const t = useT()
  return (
    <div className={styles.legend}>
      {KINDS.map((kind) => (
        <span key={kind}>
          <i
            className={
              kind === 'idle'
                ? styles.swatchIdle
                : kind === 'blocked'
                  ? styles.swatchBlocked
                  : styles.swatch
            }
            style={{ color: activityColor(kind) }}
          />
          {tr(kindKey(kind))}
        </span>
      ))}
      <span>
        <i className={styles.arcSwatch} style={{ color: agentColor(ORCHESTRATOR_ID) }} />
        {tr('orchestra.timeline.arcOrchestrator')}
      </span>
      <span>
        <i className={styles.arcSwatch} style={{ color: agentColor('worker') }} />
        {tr('orchestra.timeline.arcWorker')}
      </span>
      <span>
        <i className={styles.arcSwatch} style={{ color: agentColor('you') }} />
        {tr('orchestra.timeline.arcUser')}
      </span>
      <span>
        <i className={styles.swatch} style={{ color: agentColor(SCRIBE_ID) }} />
        {t('orchestra.scribe.name')}
      </span>
      <span className={styles.hint}>{tr('orchestra.timeline.hint')}</span>
    </div>
  )
}

function BusLog({
  messages,
  agents,
  t0,
  cursor,
  pinned,
  onPick,
  who,
  tr,
}: {
  messages: BusMessage[]
  agents: OrchestraAgent[]
  t0: number
  cursor: number | null
  pinned: boolean
  onPick: (m: BusMessage) => void
  who: (id: string) => string
  tr: Tr
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)

  // Last message at or before the cursor; it is highlighted and kept in view.
  let currentId: number | null = null
  if (cursor !== null) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].at <= cursor) {
        currentId = messages[i].id
        break
      }
    }
  }

  // Live: stick to the newest message. With a cursor: keep the current message in view.
  const live = cursor === null
  const scrollKey = live ? messages.length : currentId
  useEffect(() => {
    if (live) {
      const el = logRef.current
      if (el) el.scrollTop = el.scrollHeight
    } else {
      currentRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [scrollKey, live])

  return (
    <section className={styles.bus}>
      <div className={styles.busHead}>
        {tr('orchestra.timeline.bus')} <span className={styles.busCount}>{messages.length}</span>
        <span className={styles.busSync}>
          {cursor !== null || pinned
            ? tr('orchestra.timeline.syncedCursor')
            : tr('orchestra.timeline.syncedLive')}
        </span>
      </div>
      <div className={styles.log} ref={logRef}>
        {messages.length === 0 ? (
          <div className={styles.busEmpty}>{tr('orchestra.timeline.busEmpty')}</div>
        ) : (
          messages.map((m) => {
            const current = m.id === currentId
            const future = cursor !== null && m.at > cursor
            return (
              <button
                type="button"
                key={m.id}
                ref={current ? currentRef : undefined}
                className={`${styles.line} ${current ? styles.lineCurrent : ''} ${future ? styles.lineFuture : ''}`}
                onClick={() => onPick(m)}
                title={m.text}
              >
                <span className={styles.lineTime}>{busClock(m.at, t0)}</span>
                <span
                  className={styles.lineWho}
                  style={{ color: agentColor(m.from, areaOf(agents, m.from)) }}
                >
                  {who(m.from)}
                </span>
                <span className={styles.lineArrow}>→</span>
                <span
                  className={styles.lineWho}
                  style={{ color: agentColor(m.to, areaOf(agents, m.to)) }}
                >
                  {who(m.to)}
                </span>
                <span className={styles.lineText}>{m.text}</span>
              </button>
            )
          })
        )}
      </div>
    </section>
  )
}
