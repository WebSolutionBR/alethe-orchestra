import { Maximize2, Minimize2 } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
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
import { paneForShortcut, paneShortcutDigit, shortcutForPane } from '../a11y/paneShortcuts'
import { AgentAlert } from '../AgentAlert'
import { AgentControls } from '../AgentControls'
import { AgentTerminal, TerminalModeToggle } from '../AgentTerminal'
import { CreativeMark } from '../creative/CreativeMark'
import { DeliveryMark } from '../DeliveryMark'
import { terminalsEn } from '../i18n/terminals'
import { SCRIBE_ID } from '../scribe/identity'
import { ScribeTile } from '../scribe/ScribeMarks'
import { openScribePanel } from '../scribe/ui'
import {
  useSession,
  useSessionActions,
  useSessionFocusGetter,
  useSessionGetter,
  useSessionId,
} from '../sessionContext'
import {
  agentColor,
  areaOf,
  busClock,
  elapsed,
  isBusy,
  isFailed,
  isOrchestrator,
  overallProgress,
  processEnded,
  stateColor,
  workersOf,
} from '../shared'
import {
  focusTerminalIn,
  isTerminalElement,
  useHasTranscript,
  usePtyGate,
  useTerminalModeShortcut,
} from '../terminalHooks'
import { clampSplit, gridLayout, PANE_MIN_H, PANE_MIN_W } from './terminalsLayout'
import styles from './TerminalsView.module.css'

type Key = keyof typeof terminalsEn
type Tr = (key: Key, params?: Record<string, string | number>) => string

/** Typed wrapper so this view only uses its own keys, before and after the shell merges them. */
function useTr(): Tr {
  const t = useT()
  return (key, params) => t(key as string as MessageKey, params)
}

const stateKey = (state: AgentState) => `orchestra.terminals.state.${state}` as Key

const SPLIT_KEY = 'orchestra.terminals.split'
const MAIN_PAD = 8
const SPLITTER_W = 8
/** Height of the scribe tile under the orchestrator's terminal. */
const SCRIBE_TRACK = 'clamp(104px, 30%, 240px)'

function readSplit(): number | null {
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(saved) && saved > 0 ? saved : null
  } catch {
    return null
  }
}

function writeSplit(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(SPLIT_KEY)
    else localStorage.setItem(SPLIT_KEY, String(value))
  } catch {
    // The remembered split is a convenience only.
  }
}

function useElementSize(el: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!el) return
    const measure = () => {
      const width = el.clientWidth
      const height = el.clientHeight
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return size
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export function TerminalsView() {
  const tr = useTr()
  const t = useT()
  const agents = useSession((s) => s.agents)
  const cwd = useSession((s) => s.cwd)
  const selectedId = useSession((s) => s.selectedId)
  const { select } = useSessionActions()
  const getSession = useSessionGetter()
  const hasFocus = useSessionFocusGetter()
  const sessionId = useSessionId()
  useTerminalModeShortcut()
  const [maxId, setMaxId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [mainEl, setMainEl] = useState<HTMLDivElement | null>(null)
  const [gridEl, setGridEl] = useState<HTMLElement | null>(null)
  const gridSize = useElementSize(gridEl)
  const [split, setSplit] = useState<number | null>(readSplit)
  const splitDrag = useRef<{ x: number; width: number; total: number } | null>(null)

  const maximized = maxId && agents.some((a) => a.id === maxId) ? maxId : null

  /** Moves keyboard focus into the pane's terminal (live or classic) once the layout settled. */
  const focusPane = useCallback((id: string) => {
    focusTerminalIn(rootRef.current?.querySelector(`[data-pane-id="${CSS.escape(id)}"]`))
  }, [])

  const activate = useCallback(
    (id: string) => {
      if (getSession().selectedId !== id) select(id)
    },
    [getSession, select],
  )

  const toggleMax = useCallback(
    (id: string) => {
      activate(id)
      setMaxId((current) => (current === id ? null : id))
      focusPane(id)
    },
    [activate, focusPane],
  )

  const restore = useCallback(() => {
    setMaxId(null)
    const id = getSession().selectedId
    if (id) focusPane(id)
  }, [focusPane, getSession])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!hasFocus()) return
      // Ctrl+Shift+1..9 focuses a worker's pane and Ctrl+Shift+0 the orchestrator's, even from a
      // terminal; with a pane maximized it switches which one is.
      const digit = paneShortcutDigit(event)
      if (digit !== null) {
        const id = paneForShortcut(getSession().agents, digit)
        if (!id) return
        event.preventDefault()
        event.stopPropagation()
        activate(id)
        if (maximized) setMaxId(id)
        focusPane(id)
        return
      }
      // Ctrl+Shift+Enter toggles the selected pane, even from inside its terminal.
      if (
        event.key === 'Enter' &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey
      ) {
        const id = getSession().selectedId
        if (!id) return
        event.preventDefault()
        event.stopPropagation()
        toggleMax(id)
        return
      }
      if (!maximized || event.key !== 'Escape' || event.defaultPrevented) return
      // Esc inside a terminal belongs to the agent (it interrupts Claude), never to the layout.
      if (isTerminalElement(event.target)) return
      restore()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activate, focusPane, getSession, hasFocus, maximized, toggleMax, restore])

  /** Mini map: switch the maximized pane when one is maximized, otherwise focus the pick. */
  const pick = (id: string) => {
    if (maximized) {
      activate(id)
      setMaxId(id)
    } else activate(id)
    focusPane(id)
  }

  const onSplitStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const orch = rootRef.current?.querySelector(`[data-pane-id="${CSS.escape(ORCHESTRATOR_ID)}"]`)
    if (!mainEl || !orch) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    splitDrag.current = {
      x: event.clientX,
      width: orch.getBoundingClientRect().width,
      total: mainEl.clientWidth - MAIN_PAD * 2 - SPLITTER_W,
    }
  }
  const onSplitMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDrag.current
    if (!drag) return
    setSplit(clampSplit(drag.width + event.clientX - drag.x, drag.total))
  }
  const onSplitEnd = () => {
    if (!splitDrag.current) return
    splitDrag.current = null
    writeSplit(split)
  }
  const resetSplit = () => {
    setSplit(null)
    writeSplit(null)
  }
  /** Keyboard twin of the split drag: arrows move it (Shift for bigger steps), Home/End jump. */
  const onSplitKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const orch = rootRef.current?.querySelector(`[data-pane-id="${CSS.escape(ORCHESTRATOR_ID)}"]`)
    if (!mainEl || !orch) return
    const total = mainEl.clientWidth - MAIN_PAD * 2 - SPLITTER_W
    const width = orch.getBoundingClientRect().width
    const step = event.shiftKey ? 64 : 16
    let next: number
    if (event.key === 'ArrowLeft') next = width - step
    else if (event.key === 'ArrowRight') next = width + step
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = total
    else return
    event.preventDefault()
    const value = clampSplit(next, total)
    setSplit(value)
    writeSplit(value)
  }

  if (agents.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{tr('orchestra.terminals.emptyTitle')}</p>
          <p className={styles.emptyBody}>{tr('orchestra.terminals.emptyBody')}</p>
        </div>
      </div>
    )
  }

  const orchestrator = agents.find((a) => isOrchestrator(a)) ?? null
  const workers = workersOf(agents)
  const { cols, rows, scroll } = gridLayout(workers.length, gridSize.width, gridSize.height)
  const states = new Map(agents.map((a) => [a.id, a.state]))
  const shortcutHint = (id: string) => {
    const n = shortcutForPane(agents, id)
    return n === null ? undefined : t('orchestra.a11y.focusPane', { n })
  }
  // The orchestrator column never squeezes the worker grid below one usable pane.
  const orchTrack = split
    ? `minmax(260px, min(${split}px, calc(100% - ${PANE_MIN_W + SPLITTER_W}px)))`
    : 'minmax(300px, 34%)'

  return (
    <div className={styles.root} ref={rootRef}>
      <header className={styles.top}>
        <Summary agents={agents} tr={tr} />
        <MiniMap agents={agents} selectedId={selectedId} onPick={pick} tr={tr} />
      </header>

      <div
        ref={setMainEl}
        className={`${styles.main} ${maximized ? styles.hasMax : ''}`}
        style={{
          gridTemplateColumns: orchestrator
            ? `${orchTrack} ${SPLITTER_W}px minmax(0, 1fr)`
            : 'minmax(0, 1fr)',
          // The Obsidian scribe's tile docks under the orchestrator's terminal.
          ...(orchestrator
            ? { gridTemplateRows: `minmax(0, 1fr) ${SCRIBE_TRACK}`, rowGap: 8 }
            : {}),
        }}
      >
        {orchestrator ? (
          <>
            <Pane
              agent={orchestrator}
              cwd={cwd}
              maxed={maximized === orchestrator.id}
              selected={selectedId === orchestrator.id}
              shortcutHint={shortcutHint(orchestrator.id)}
              depStates={states}
              onActivate={activate}
              onFocusTerminal={focusPane}
              onToggleMax={toggleMax}
              tr={tr}
            />
            {maximized ? null : (
              <ScribeTile sessionId={sessionId} style={{ gridColumn: 1, gridRow: 2 }} />
            )}
            <div
              className={styles.splitter}
              style={{ gridRow: '1 / -1' }}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={tr('orchestra.terminals.resizeSplit')}
              aria-valuenow={split ?? undefined}
              title={tr('orchestra.terminals.resizeSplit')}
              onPointerDown={onSplitStart}
              onPointerMove={onSplitMove}
              onPointerUp={onSplitEnd}
              onPointerCancel={onSplitEnd}
              onDoubleClick={resetSplit}
              onKeyDown={onSplitKey}
            />
          </>
        ) : null}
        <section
          ref={setGridEl}
          className={styles.grid}
          data-scroll={scroll || undefined}
          style={{
            gridColumn: orchestrator ? 3 : 1,
            gridRow: orchestrator ? '1 / -1' : undefined,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: scroll
              ? `repeat(${rows}, ${PANE_MIN_H}px)`
              : `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {workers.length === 0 ? (
            <div className={styles.gridEmpty}>{tr('orchestra.terminals.noWorkers')}</div>
          ) : (
            workers.map((worker, index) => (
              <Pane
                key={worker.id}
                cell={{ column: (index % cols) + 1, row: Math.floor(index / cols) + 1 }}
                agent={worker}
                cwd={cwd}
                maxed={maximized === worker.id}
                selected={selectedId === worker.id}
                shortcutHint={shortcutHint(worker.id)}
                depStates={states}
                onActivate={activate}
                onFocusTerminal={focusPane}
                onToggleMax={toggleMax}
                tr={tr}
              />
            ))
          )}
        </section>
      </div>

      <BusTicker agents={agents} tr={tr} onPick={select} />
    </div>
  )
}

function Summary({ agents, tr }: { agents: OrchestraAgent[]; tr: Tr }) {
  const goal = useSession((s) => s.goal)
  const startedAt = useSession((s) => s.startedAt)
  const now = useNow(1000)
  const workers = workersOf(agents)
  const overall = overallProgress(agents)
  const running = workers.filter((a) => isBusy(a.state) || a.state === 'blocked').length
  const done = workers.filter((a) => a.state === 'done').length
  const waiting = workers.filter((a) => a.state === 'waiting').length

  return (
    <div className={styles.summary}>
      <div className={styles.goalRow}>
        <span className={styles.goal} title={goal}>
          {goal || tr('orchestra.terminals.noGoal')}
        </span>
        {startedAt ? (
          <span className={styles.elapsed}>
            {tr('orchestra.terminals.elapsed', { time: elapsed(startedAt, now) })}
          </span>
        ) : null}
      </div>
      <div className={styles.statsRow}>
        <span className={styles.statLabel}>{tr('orchestra.terminals.overall')}</span>
        <span className={styles.overallBar}>
          <i style={{ width: `${overall}%` }} />
        </span>
        <span className={styles.overallPct}>{overall}%</span>
        <span className={styles.count} data-kind="running">
          <b>{running}</b> {tr('orchestra.terminals.countRunning')}
        </span>
        <span className={styles.count} data-kind="done">
          <b>{done}</b> {tr('orchestra.terminals.countDone')}
        </span>
        <span className={styles.count} data-kind="waiting">
          <b>{waiting}</b> {tr('orchestra.terminals.countWaiting')}
        </span>
      </div>
    </div>
  )
}

const MAP_W = 132
const MAP_H = 64
const MAP_CX = MAP_W / 2
const MAP_CY = MAP_H / 2

function MiniMap({
  agents,
  selectedId,
  onPick,
  tr,
}: {
  agents: OrchestraAgent[]
  selectedId: string | null
  onPick: (id: string) => void
  tr: Tr
}) {
  const lastMessage = useSession((s) =>
    s.messages.length ? s.messages[s.messages.length - 1] : null,
  )
  const workers = workersOf(agents)

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    map.set(ORCHESTRATOR_ID, { x: MAP_CX, y: MAP_CY })
    workers.forEach((worker, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, workers.length)) * Math.PI * 2
      map.set(worker.id, { x: MAP_CX + Math.cos(angle) * 52, y: MAP_CY + Math.sin(angle) * 22 })
    })
    return map
    // Positions only depend on the worker order, not on their live fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers.map((w) => w.id).join('|')])

  const pulse = (() => {
    if (!lastMessage || Date.now() - lastMessage.at > 4000) return null
    const from = positions.get(lastMessage.from) ?? positions.get(ORCHESTRATOR_ID)
    const to = positions.get(lastMessage.to)
    if (!from || !to || from === to) return null
    return { id: lastMessage.id, from, to, fromOrchestrator: lastMessage.from === ORCHESTRATOR_ID }
  })()

  const ringR = 6.5
  const circumference = 2 * Math.PI * ringR

  return (
    <div className={styles.map}>
      <span className={styles.mapLabel}>{tr('orchestra.terminals.map')}</span>
      <svg
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        role="img"
        aria-label={tr('orchestra.terminals.mapLabel')}
      >
        {workers.map((worker) => {
          const p = positions.get(worker.id)
          return p ? (
            <line
              key={`l-${worker.id}`}
              className={styles.mapLink}
              x1={MAP_CX}
              y1={MAP_CY}
              x2={p.x}
              y2={p.y}
            />
          ) : null
        })}
        {pulse ? (
          <line
            key={`pulse-${pulse.id}`}
            className={styles.mapPulse}
            x1={pulse.from.x}
            y1={pulse.from.y}
            x2={pulse.to.x}
            y2={pulse.to.y}
            style={{
              stroke: pulse.fromOrchestrator ? agentColor(ORCHESTRATOR_ID) : agentColor('worker'),
            }}
          />
        ) : null}
        <g className={styles.mapNode} onClick={() => onPick(ORCHESTRATOR_ID)}>
          <title>{ORCHESTRATOR_ID}</title>
          <circle
            cx={MAP_CX}
            cy={MAP_CY}
            r={6}
            className={styles.mapCore}
            style={{
              stroke: agentColor(ORCHESTRATOR_ID),
              fill: selectedId === ORCHESTRATOR_ID ? agentColor(ORCHESTRATOR_ID) : undefined,
            }}
          />
        </g>
        {workers.map((worker) => {
          const p = positions.get(worker.id)
          if (!p) return null
          const color = stateColor(worker.state)
          return (
            <g key={worker.id} className={styles.mapNode} onClick={() => onPick(worker.id)}>
              <title>{`${worker.id} · ${worker.area} · ${worker.progress}%`}</title>
              <circle cx={p.x} cy={p.y} r={ringR} className={styles.mapRingBg} />
              <circle
                cx={p.x}
                cy={p.y}
                r={ringR}
                className={styles.mapRing}
                style={{ stroke: color }}
                strokeDasharray={`${(circumference * worker.progress) / 100} ${circumference}`}
                transform={`rotate(-90 ${p.x} ${p.y})`}
              />
              <circle
                cx={p.x}
                cy={p.y}
                r={3.2}
                className={styles.mapCore}
                style={{ stroke: color, fill: selectedId === worker.id ? color : undefined }}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

type PaneProps = {
  agent: OrchestraAgent
  /** Fixed grid cell, so maximizing one pane never reflows (and resizes) the others. */
  cell?: { column: number; row: number }
  cwd: string | null
  maxed: boolean
  selected: boolean
  /** "Ctrl+Shift+N focuses this terminal", on the agent's name. */
  shortcutHint?: string
  depStates: Map<string, AgentState>
  /** Marks the agent as selected (pointer or focus anywhere in the pane). */
  onActivate: (id: string) => void
  onFocusTerminal: (id: string) => void
  onToggleMax: (id: string) => void
  tr: Tr
}

function Pane({
  agent,
  cell,
  cwd,
  maxed,
  selected,
  shortcutHint,
  depStates,
  onActivate,
  onFocusTerminal,
  onToggleMax,
  tr,
}: PaneProps) {
  const orchestrator = isOrchestrator(agent)
  const color = stateColor(agent.state)
  const subtitle = orchestrator ? agent.task : agent.task || agent.note
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const hasTerminal = Boolean(agent.ptyId) && !processEnded(agent) && !stopped
  const className = [
    styles.pane,
    orchestrator ? styles.orchestratorPane : '',
    maxed ? styles.maxed : '',
    selected ? styles.selected : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section
      className={className}
      data-state={agent.state}
      data-pane-id={agent.id}
      style={cell && !maxed ? { gridColumn: cell.column, gridRow: cell.row } : undefined}
      onPointerDownCapture={() => onActivate(agent.id)}
      onFocusCapture={() => onActivate(agent.id)}
    >
      {/* Click focuses the terminal; double-click or the icon toggles maximize. */}
      <div
        className={styles.paneHead}
        onClick={() => onFocusTerminal(agent.id)}
        onDoubleClick={() => onToggleMax(agent.id)}
      >
        <span
          className={styles.dot}
          style={{ background: color }}
          data-busy={isBusy(agent.state) || undefined}
        />
        {/* Blocked and failed read without color too. */}
        {agent.state === 'blocked' || isFailed(agent) ? (
          <span className={styles.paneFlag} style={{ color }} aria-hidden="true">
            {agent.state === 'blocked' ? '!' : '✕'}
          </span>
        ) : null}
        <span
          className={styles.paneId}
          style={{ color: agentColor(agent.id, agent.area) }}
          title={shortcutHint}
        >
          {agent.id}
        </span>
        <CreativeMark area={agent.area} />
        {!orchestrator && agent.area && agent.area !== agent.id ? (
          <span className={styles.paneArea}>{agent.area}</span>
        ) : null}
        <span
          className={styles.paneTask}
          title={[agent.task, agent.note].filter(Boolean).join('\n')}
        >
          {subtitle}
        </span>
        <span className={styles.paneState} style={{ color }}>
          {tr(stateKey(agent.state))}
        </span>
        <span className={styles.paneBar}>
          <i style={{ width: `${agent.progress}%`, background: color }} />
        </span>
        <span className={styles.panePct}>{agent.progress}%</span>
        {maxed ? <span className={styles.escHint}>{tr('orchestra.terminals.escHint')}</span> : null}
        <AgentControls agent={agent} buttonClassName={styles.maxIcon} />
        {hasTerminal ? (
          <TerminalModeToggle
            className={styles.maxIcon}
            onToggled={() => onFocusTerminal(agent.id)}
          />
        ) : null}
        <button
          type="button"
          className={styles.maxIcon}
          onClick={(e) => {
            e.stopPropagation()
            onToggleMax(agent.id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          aria-pressed={maxed}
          aria-label={
            maxed
              ? tr('orchestra.terminals.restore')
              : tr('orchestra.terminals.maximize', { id: agent.id })
          }
          title={
            maxed
              ? tr('orchestra.terminals.restore')
              : tr('orchestra.terminals.maximize', { id: agent.id })
          }
        >
          {maxed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <PaneBody agent={agent} cwd={cwd} selected={selected} depStates={depStates} tr={tr} />
    </section>
  )
}

function PaneBody({
  agent,
  cwd,
  selected,
  depStates,
  tr,
}: {
  agent: OrchestraAgent
  cwd: string | null
  /** The selected agent's terminal takes the keyboard when it mounts; the others never do. */
  selected: boolean
  depStates: Map<string, AgentState>
  tr: Tr
}) {
  const ptyId = agent.ptyId
  // Only a PTY confirmed alive gets an interactive view (see usePtyGate).
  const status = usePtyGate(ptyId)
  const hasTranscript = useHasTranscript(ptyId)
  // A stopped orchestration's terminals are gone; their transcripts stay readable.
  const stopped = useSession((s) => Boolean(s.stoppedAt))

  if (!ptyId) {
    if (processEnded(agent) || stopped) return <EndedPlaceholder agent={agent} tr={tr} />
    return <PendingPlaceholder agent={agent} depStates={depStates} tr={tr} />
  }

  if (status === 'checking' && !processEnded(agent) && !stopped) {
    return (
      <div className={styles.placeholder}>
        <span className={styles.placeholderMuted}>{tr('orchestra.terminals.attaching')}</span>
      </div>
    )
  }
  const role = isOrchestrator(agent) ? 'orchestrator' : 'worker'
  // An ended agent keeps its whole transcript readable (and copyable), read-only, in both modes;
  // also one that ended after reporting done, whose PTY may linger a moment.
  if (stopped || status !== 'alive' || processEnded(agent)) {
    // The read-only transcript never sizes the PTY, so the alert above it is safe.
    return hasTranscript ? (
      <>
        <AgentAlert agent={agent} compact />
        <AgentTerminal key={ptyId} ptyId={ptyId} role={role} alive={false} cwd={cwd} />
      </>
    ) : (
      <EndedPlaceholder agent={agent} tr={tr} />
    )
  }

  // Memoized with primitive props: progress/state updates of the agent never re-render it.
  return (
    <AgentTerminal key={ptyId} ptyId={ptyId} role={role} alive cwd={cwd} autoFocus={selected} />
  )
}

function PendingPlaceholder({
  agent,
  depStates,
  tr,
}: {
  agent: OrchestraAgent
  depStates: Map<string, AgentState>
  tr: Tr
}) {
  const waiting = agent.state === 'waiting'
  // Held because a dependency failed: the reason and the ways out replace the title.
  const held = agent.state === 'blocked'
  return (
    <div className={styles.placeholder}>
      {held ? (
        <AgentAlert agent={agent} />
      ) : (
        <span className={styles.placeholderTitle}>
          {waiting
            ? tr('orchestra.terminals.waitingTitle')
            : tr('orchestra.terminals.startingTitle')}
        </span>
      )}
      <p className={styles.placeholderTask}>{agent.task || tr('orchestra.terminals.noTask')}</p>
      {agent.after.length > 0 ? (
        <div className={styles.deps}>
          <span className={styles.placeholderMuted}>{tr('orchestra.terminals.dependsOn')}</span>
          {agent.after.map((dep) => {
            const state = depStates.get(dep)
            return (
              <span key={dep} className={styles.dep}>
                <span
                  className={styles.dot}
                  style={{ background: state ? stateColor(state) : 'var(--fg-faint)' }}
                />
                {dep}
                {state ? <span className={styles.depState}>{tr(stateKey(state))}</span> : null}
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function EndedPlaceholder({ agent, tr }: { agent: OrchestraAgent; tr: Tr }) {
  const lines = agent.lines.slice(-8)
  return (
    <div className={styles.placeholder}>
      {/* How it ended (exit code, launch failure) and its last note. */}
      <AgentAlert agent={agent} />
      <span className={styles.placeholderMuted}>{tr('orchestra.terminals.endedBody')}</span>
      {lines.length ? (
        <ol className={styles.lines}>
          {lines.map((line, index) => (
            <li key={`${line.at}-${index}`} data-tone={line.tone}>
              {line.text}
            </li>
          ))}
        </ol>
      ) : (
        <span className={styles.placeholderMuted}>{tr('orchestra.terminals.noActivity')}</span>
      )}
    </div>
  )
}

const TICKER_SIZE = 40

function BusTicker({
  agents,
  tr,
  onPick,
}: {
  agents: OrchestraAgent[]
  tr: Tr
  onPick: (id: string) => void
}) {
  const messages = useSession((s) => s.messages)
  const startedAt = useSession((s) => s.startedAt)
  const sessionId = useSessionId()
  const latest = useMemo(() => messages.slice(-TICKER_SIZE).reverse(), [messages])

  const who = (id: string) =>
    id === 'you' ? tr('orchestra.terminals.you') : id === 'all' ? tr('orchestra.terminals.all') : id

  return (
    <div className={styles.ticker}>
      <span className={styles.tickerLabel}>
        {tr('orchestra.terminals.bus')} <b>{messages.length}</b>
      </span>
      <div className={styles.tickerTrack}>
        {latest.length === 0 ? (
          <span className={styles.tickerEmpty}>{tr('orchestra.terminals.busEmpty')}</span>
        ) : (
          latest.map((message: BusMessage) => (
            <button
              type="button"
              key={message.id}
              className={styles.tickerItem}
              title={message.text}
              onClick={() =>
                message.from === SCRIBE_ID
                  ? openScribePanel(sessionId)
                  : onPick(message.from === 'you' ? message.to : message.from)
              }
            >
              <span className={styles.tickerTime}>{busClock(message.at, startedAt)}</span>
              <span style={{ color: agentColor(message.from, areaOf(agents, message.from)) }}>
                {who(message.from)}
              </span>
              <span className={styles.tickerArrow}>→</span>
              <span style={{ color: agentColor(message.to, areaOf(agents, message.to)) }}>
                {who(message.to)}
              </span>
              <DeliveryMark message={message} compact actionable={false} />
              <span className={styles.tickerText}>{message.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
