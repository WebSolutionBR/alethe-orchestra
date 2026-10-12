import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  type BusMessage,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
} from '../../../stores/orchestraStore'
import { Splitter } from '../canvas/Splitter'
import { usePanelSize } from '../canvas/usePanelSize'
import { ZoomCanvas } from '../canvas/ZoomCanvas'
import { CreativeMark } from '../creative/CreativeMark'
import { isCreativeArea } from '../creative/role'
import { isScribeParty } from '../scribe/identity'
import { ScribeLink, ScribeNode } from '../scribe/ScribeMarks'
import { useScribeLines } from '../scribe/useScribe'
import { useSession, useSessionActions, useSessionId } from '../sessionContext'
import {
  areaOf,
  busClock,
  elapsed,
  endedByUserKey,
  isBusy,
  isOrchestrator,
  overallProgress,
  workersOf,
} from '../shared'
import styles from './FlowView.module.css'

const NODE_W = 176
const NODE_H = 88
const ORCH_W = 188
const ORCH_H = 132
const GAP_Y = 18
const PAD_X = 28
const PAD_TOP = 34
const PAD_BOTTOM = 20
/** Column pitch in world pixels; the shared canvas scales the whole graph to the screen. */
const COL_W = NODE_W + 84
/** The Obsidian scribe docks under the orchestrator in its column. */
const SCRIBE_GAP = 16
const SCRIBE_H = 52

type Box = { x: number; y: number; w: number; h: number }
type EdgeKind = 'pending' | 'feeding' | 'handoff' | 'done'
type Edge = {
  from: string
  to: string
  kind: EdgeKind
  orch: boolean
  d: string
  ax: number
  ay: number
  bx: number
  by: number
}
type BusFilter = 'all' | 'handoffs' | 'orchestrator'

const lastText = (agent: OrchestraAgent) =>
  agent.lines.length ? agent.lines[agent.lines.length - 1].text : ''

/** Column per worker: 1 when it has no known worker dependency, else 1 + the deepest dependency (longest path). */
function computeColumns(workers: OrchestraAgent[]): Map<string, number> {
  const byId = new Map(workers.map((w) => [w.id, w]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 1 // Cycle guard: break the loop at the first column.
    visiting.add(id)
    const agent = byId.get(id)
    let col = 1
    for (const dep of agent?.after ?? []) {
      if (byId.has(dep) && dep !== id) col = Math.max(col, visit(dep) + 1)
    }
    visiting.delete(id)
    depth.set(id, col)
    return col
  }
  for (const w of workers) visit(w.id)
  return depth
}

function edgeKind(up: OrchestraAgent, down: OrchestraAgent, fromOrchestrator: boolean): EdgeKind {
  if (down.state === 'done') return 'done'
  // A failed agent feeds nothing and takes nothing in: its edges go quiet, never "feeding".
  if (down.state === 'exited' || up.state === 'exited') return 'pending'
  if (fromOrchestrator) {
    if (down.state === 'starting') return 'handoff'
    return down.state === 'waiting' ? 'pending' : 'feeding'
  }
  if (up.state === 'done' && (isBusy(down.state) || down.state === 'blocked')) return 'handoff'
  if (up.state !== 'waiting') return 'feeding'
  return 'pending'
}

function curve(ax: number, ay: number, bx: number, by: number): string {
  const dx = Math.max(24, (bx - ax) * 0.5)
  return `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`
}

/** Ticks every second until `to` (the session was stopped), where it stays. */
function Clock({ from, to }: { from: number; to: number | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!from || to !== null) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [from, to])
  return <>{from ? elapsed(from, to ?? Date.now()) : '0:00'}</>
}

function activate(event: KeyboardEvent, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    action()
  }
}

function WorkerNode({
  agent,
  box,
  selected,
  onSelect,
}: {
  agent: OrchestraAgent
  box: Box
  selected: boolean
  onSelect: (id: string) => void
}) {
  const t = useT()
  const open = () => onSelect(agent.id)
  // The label only names the action; state and progress are read as its description.
  const stateId = useId()
  const pctId = useId()
  const waiting = agent.state === 'waiting'
  const meta = waiting
    ? t('orchestra.flow.waitsFor', { deps: agent.after.join(', ') })
    : agent.note || lastText(agent) || t('orchestra.flow.noActivity')
  return (
    <div
      className={styles.node}
      data-state={agent.state}
      data-busy={isBusy(agent.state) || undefined}
      data-selected={selected || undefined}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      role="button"
      tabIndex={0}
      aria-label={t('orchestra.flow.openTerminal', { id: agent.id })}
      aria-describedby={`${stateId} ${pctId}`}
      aria-pressed={selected}
      onClick={open}
      onKeyDown={(e) => activate(e, open)}
      title={agent.task}
    >
      <div className={styles.nodeHead}>
        <span className={styles.mark} aria-hidden="true">
          {waiting ? '⌧' : '✻'}
        </span>
        <span className={styles.nodeId}>{agent.id}</span>
        <CreativeMark area={agent.area} />
        <span className={styles.nodeState} id={stateId}>
          <span className={styles.glyph} aria-hidden="true" />
          {t(endedByUserKey(agent) ?? `orchestra.flow.state.${agent.state}`)}
        </span>
      </div>
      <div className={styles.nodeTitle}>{agent.area}</div>
      <div className={styles.nodeMeta}>
        <span className={styles.nodeAct}>{meta}</span>
        <span className={styles.pct} id={pctId}>
          {agent.progress}%
        </span>
      </div>
      <div className={styles.bar}>
        <i style={{ width: `${agent.progress}%` }} />
      </div>
    </div>
  )
}

function OrchestratorNode({
  agent,
  agents,
  goal,
  startedAt,
  box,
  selected,
  onSelect,
}: {
  agent: OrchestraAgent
  agents: OrchestraAgent[]
  goal: string
  startedAt: number
  box: Box
  selected: boolean
  onSelect: (id: string) => void
}) {
  const t = useT()
  const stoppedAt = useSession((s) => s.stoppedAt ?? null)
  const open = () => onSelect(ORCHESTRATOR_ID)
  const statsId = useId()
  const workers = workersOf(agents)
  const active = workers.filter((w) => isBusy(w.state)).length
  const line = agent.note || lastText(agent)
  return (
    <div
      className={styles.orch}
      data-selected={selected || undefined}
      data-busy={isBusy(agent.state) || undefined}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      role="button"
      tabIndex={0}
      aria-label={t('orchestra.flow.openTerminal', { id: ORCHESTRATOR_ID })}
      aria-describedby={statsId}
      aria-pressed={selected}
      onClick={open}
      onKeyDown={(e) => activate(e, open)}
      title={goal}
    >
      <div className={styles.nodeHead}>
        <span className={styles.mark} aria-hidden="true">
          ✻
        </span>
        <span>{ORCHESTRATOR_ID}</span>
        <span className={styles.you}>{t('orchestra.flow.you')}</span>
      </div>
      <div className={styles.orchGoal}>{goal || t('orchestra.flow.noGoal')}</div>
      <div className={styles.orchStats} id={statsId}>
        <span>
          {t('orchestra.flow.workers')}{' '}
          <b>
            {active}/{workers.length}
          </b>
        </span>
        <span>
          {t('orchestra.flow.overall')} <b>{overallProgress(agents)}%</b>
        </span>
        <span>
          {t('orchestra.flow.elapsed')}{' '}
          <b>
            <Clock from={startedAt} to={stoppedAt} />
          </b>
        </span>
      </div>
      {line && <div className={styles.orchLine}>{line}</div>}
    </div>
  )
}

function roleOf(id: string, area?: string): 'orch' | 'you' | 'scribe' | 'creative' | 'worker' {
  if (id === ORCHESTRATOR_ID) return 'orch'
  if (id === 'you') return 'you'
  if (isScribeParty(id)) return 'scribe'
  if (isCreativeArea(area)) return 'creative'
  return 'worker'
}

function isHandoff(m: BusMessage) {
  return (m.from === ORCHESTRATOR_ID && m.to !== 'you') || m.text.startsWith('done ·')
}

function BusDrawer({
  messages,
  agents,
  startedAt,
}: {
  messages: BusMessage[]
  agents: OrchestraAgent[]
  startedAt: number
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const body = usePanelSize('orchestra.flow.busHeight', 196, 72, 560)
  const [filter, setFilter] = useState<BusFilter>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  const visible = useMemo(() => {
    if (filter === 'handoffs') return messages.filter(isHandoff)
    if (filter === 'orchestrator')
      return messages.filter((m) => m.from === ORCHESTRATOR_ID || m.to === ORCHESTRATOR_ID)
    return messages
  }, [messages, filter])

  useEffect(() => {
    const el = listRef.current
    if (el && open && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [visible, open])

  const label = (id: string) => (id === 'you' ? t('orchestra.flow.you') : id)
  const filters: Array<[BusFilter, string]> = [
    ['all', t('orchestra.flow.filterAll')],
    ['handoffs', t('orchestra.flow.filterHandoffs')],
    ['orchestrator', t('orchestra.flow.filterOrchestrator')],
  ]

  return (
    <section
      className={styles.drawer}
      data-open={open || undefined}
      aria-label={t('orchestra.flow.bus')}
    >
      {open && <Splitter panel={body} axis="y" />}
      <div className={styles.drawerHead}>
        <button
          type="button"
          className={styles.drawerToggle}
          aria-expanded={open}
          title={t('orchestra.flow.busToggle')}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={styles.chev} aria-hidden="true">
            ▾
          </span>
          <span className={styles.drawerTitle}>{t('orchestra.flow.bus')}</span>
          <span className={styles.drawerCount}>{messages.length}</span>
          <span className={styles.faint}>{t('orchestra.flow.busMessages')}</span>
        </button>
        <div className={styles.filters} role="group">
          {filters.map(([id, text]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {text}
            </button>
          ))}
        </div>
        <span className={styles.live}>● {t('orchestra.flow.live')}</span>
      </div>
      <div className={styles.drawerBody} style={open ? { height: body.size } : undefined}>
        <div
          className={styles.busList}
          ref={listRef}
          role="log"
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {visible.length === 0 ? (
            <div className={styles.busEmpty}>{t('orchestra.flow.busEmpty')}</div>
          ) : (
            visible.map((m) => (
              <div
                key={m.id}
                className={styles.row}
                data-handoff={(m.from === ORCHESTRATOR_ID && m.to !== 'you') || undefined}
                data-done={m.text.startsWith('done ·') || undefined}
              >
                <span className={styles.faint}>{busClock(m.at, startedAt)}</span>
                <span className={styles.rowFrom}>
                  <span data-role={roleOf(m.from, areaOf(agents, m.from))}>{label(m.from)}</span> →{' '}
                  <span data-role={roleOf(m.to, areaOf(agents, m.to))}>{label(m.to)}</span>
                </span>
                <span className={styles.rowText} title={m.text}>
                  {m.text}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

export function FlowView() {
  const t = useT()
  const agents = useSession((s) => s.agents)
  const messages = useSession((s) => s.messages)
  const goal = useSession((s) => s.goal)
  const startedAt = useSession((s) => s.startedAt)
  const selectedId = useSession((s) => s.selectedId)
  const { select } = useSessionActions()
  const sessionId = useSessionId()
  const scribeLines = useScribeLines(messages)

  const orchestrator = agents.find(isOrchestrator)
  const workers = useMemo(() => workersOf(agents), [agents])

  const layout = useMemo(() => {
    const columns = computeColumns(workers)
    const colCount = Math.max(1, ...Array.from(columns.values())) + 1
    const groups: OrchestraAgent[][] = Array.from({ length: colCount }, () => [])
    for (const w of workers) groups[columns.get(w.id) ?? 1].push(w)
    const maxRows = Math.max(1, ...groups.map((g) => g.length))

    // World coordinates only: the graph no longer depends on the viewport, which used to pin it
    // to the top whenever the measured height lagged. The canvas centers and fits it instead.
    const colW = COL_W
    // The orchestrator and the scribe docked under it are centered as one block.
    const hubH = ORCH_H + SCRIBE_GAP + SCRIBE_H
    const contentH = Math.max(hubH, maxRows * (NODE_H + GAP_Y) - GAP_Y)
    const width = PAD_X * 2 + Math.max(ORCH_W, (colCount - 1) * colW + NODE_W)
    const height = PAD_TOP + contentH + PAD_BOTTOM
    const midY = PAD_TOP + contentH / 2

    const boxes = new Map<string, Box>()
    const orchY = midY - hubH / 2
    boxes.set(ORCHESTRATOR_ID, { x: PAD_X, y: orchY, w: ORCH_W, h: ORCH_H })
    const scribe: Box = { x: PAD_X, y: orchY + ORCH_H + SCRIBE_GAP, w: ORCH_W, h: SCRIBE_H }
    groups.forEach((group, col) => {
      const total = group.length * (NODE_H + GAP_Y) - GAP_Y
      group.forEach((w, row) => {
        boxes.set(w.id, {
          x: PAD_X + col * colW,
          y: midY - total / 2 + row * (NODE_H + GAP_Y),
          w: NODE_W,
          h: NODE_H,
        })
      })
    })

    const byId = new Map(agents.map((a) => [a.id, a]))
    const edges: Edge[] = []
    const link = (from: string, to: string) => {
      const a = boxes.get(from)
      const b = boxes.get(to)
      const up = byId.get(from)
      const down = byId.get(to)
      if (!a || !b || !up || !down) return
      const ax = a.x + a.w
      const ay = a.y + a.h / 2
      const bx = b.x
      const by = b.y + b.h / 2
      const orch = from === ORCHESTRATOR_ID
      edges.push({
        from,
        to,
        kind: edgeKind(up, down, orch),
        orch,
        d: curve(ax, ay, bx, by),
        ax,
        ay,
        bx,
        by,
      })
    }
    for (const w of workers) {
      const deps = w.after.filter((dep) => columns.has(dep) && dep !== w.id)
      if (deps.length === 0) {
        if (orchestrator) link(ORCHESTRATOR_ID, w.id)
      } else {
        for (const dep of deps) link(dep, w.id)
      }
    }

    return { boxes, scribe, edges, colCount, colW, width, height }
  }, [agents, workers, orchestrator])

  const orchBox = layout.boxes.get(ORCHESTRATOR_ID)
  const scribeBox = layout.scribe

  return (
    <div className={styles.root}>
      <div className={styles.canvasWrap}>
        <div className={styles.canvas}>
          <ZoomCanvas
            contentWidth={layout.width}
            contentHeight={layout.height}
            label={t('orchestra.flow.canvasLabel')}
            minZoom={0.25}
            maxFitZoom={1.25}
          >
            <div className={styles.stage} style={{ width: layout.width, height: layout.height }}>
              {Array.from({ length: layout.colCount }, (_, col) => (
                <div
                  key={col}
                  className={styles.column}
                  style={{ left: PAD_X + col * layout.colW }}
                >
                  <span className={styles.colHead}>
                    {col === 0
                      ? t('orchestra.flow.columnOrchestrator')
                      : t('orchestra.flow.column', { n: col })}
                  </span>
                </div>
              ))}
              <svg
                className={styles.edges}
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                {layout.edges.map((e) => (
                  <g
                    key={`${e.from}>${e.to}`}
                    className={styles.edge}
                    data-kind={e.kind}
                    data-orch={e.orch || undefined}
                  >
                    <path className={styles.edgeBase} d={e.d} />
                    <path className={styles.edgeFlow} d={e.d} />
                    <circle className={styles.port} cx={e.ax} cy={e.ay} r={3} />
                    <circle className={styles.port} cx={e.bx} cy={e.by} r={3} />
                  </g>
                ))}
                {orchestrator && orchBox ? (
                  <ScribeLink
                    x={scribeBox.x + scribeBox.w / 2}
                    y1={orchBox.y + orchBox.h + 1}
                    y2={scribeBox.y - 1}
                    count={scribeLines.length}
                  />
                ) : null}
              </svg>
              {orchestrator && orchBox && (
                <OrchestratorNode
                  agent={orchestrator}
                  agents={agents}
                  goal={goal}
                  startedAt={startedAt}
                  box={orchBox}
                  selected={selectedId === ORCHESTRATOR_ID}
                  onSelect={select}
                />
              )}
              {orchestrator ? (
                <ScribeNode
                  sessionId={sessionId}
                  lines={scribeLines}
                  x={scribeBox.x + scribeBox.w / 2}
                  y={scribeBox.y + scribeBox.h / 2}
                  width={scribeBox.w}
                  height={scribeBox.h}
                />
              ) : null}
              {workers.map((w) => {
                const box = layout.boxes.get(w.id)
                return box ? (
                  <WorkerNode
                    key={w.id}
                    agent={w}
                    box={box}
                    selected={selectedId === w.id}
                    onSelect={select}
                  />
                ) : null
              })}
            </div>
          </ZoomCanvas>
        </div>

        {workers.length === 0 && (
          <div className={styles.empty}>
            <h2>{t('orchestra.flow.emptyTitle')}</h2>
            <p>{t('orchestra.flow.emptyBody')}</p>
            {orchestrator && (
              <button
                type="button"
                className={styles.emptyAction}
                onClick={() => select(ORCHESTRATOR_ID)}
              >
                {t('orchestra.flow.emptyAction')}
              </button>
            )}
          </div>
        )}

        <div className={styles.legend} aria-hidden="true">
          <span>
            <svg width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" className={styles.legendPending} />
            </svg>
            {t('orchestra.flow.legendPending')}
          </span>
          <span>
            <svg width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" className={styles.legendHandoff} />
            </svg>
            {t('orchestra.flow.legendHandoff')}
          </span>
          <span>
            <svg width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" className={styles.legendDone} />
            </svg>
            {t('orchestra.flow.legendDone')}
          </span>
          <span>
            <svg width="10" height="10">
              <circle cx="5" cy="5" r="3" className={styles.legendOrch} />
            </svg>
            {t('orchestra.flow.legendOrchestrator')}
          </span>
        </div>
      </div>
      <BusDrawer messages={messages} agents={agents} startedAt={startedAt} />
    </div>
  )
}
