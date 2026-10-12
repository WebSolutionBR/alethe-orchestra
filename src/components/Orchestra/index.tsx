import {
  ChartGantt,
  FileText,
  Hexagon,
  LayoutDashboard,
  type LucideIcon,
  Orbit,
  Send,
  Square,
  SquareTerminal,
  Workflow,
  X,
} from 'lucide-react'
import {
  type ComponentType,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useShallow } from 'zustand/react/shallow'

import { type MessageKey, useT } from '../../lib/i18n'
import {
  ORCHESTRA_VIEW_MODES,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
  type OrchestraViewMode,
  shownSessionIds,
  useOrchestraStore,
} from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { ErrorBoundary } from '../ErrorBoundary'
import accountStyles from './accounts/Accounts.module.css'
import { AccountsPanel, AccountsRail, SessionAccountChip } from './accounts/AccountsPanel'
import { useAccountsShortcut } from './accounts/hooks'
import { LimitStrip } from './accounts/LimitStrip'
import { AccountSwitchToast } from './accounts/SwitchToast'
import { AgentAlert } from './AgentAlert'
import alertStyles from './AgentAlert.module.css'
import { AgentControls } from './AgentControls'
import { AgentTerminal, TerminalModeToggle } from './AgentTerminal'
import { AttentionLive } from './attention/AttentionLive'
import { CreativeMark } from './creative/CreativeMark'
import { draftKey, useDraftText } from './drafts'
import styles from './Orchestra.module.css'
import { sessionForProject } from './projectFlow'
import { ReportDialog } from './ReportDialog'
import { InterruptedBanner } from './resume/InterruptedBanner'
import { ScribeChip } from './scribe/ScribeChip'
import { askCloseSession, askStopAgents, clockTime } from './sessionActions'
import {
  OrchestraSessionProvider,
  useSession,
  useSessionActions,
  useSessionFocused,
  useSessionGetter,
  useSessionId,
} from './sessionContext'
import { SessionPanes } from './SessionPanes'
import { SessionTabs } from './SessionTabs'
import {
  describeExit,
  elapsed,
  endedByUserKey,
  isFailed,
  overallProgress,
  processEnded,
  stateColor,
  workersOf,
} from './shared'
import { OrchestraStart } from './start/OrchestraStart'
import { useHasTranscript, usePtyGate, useTerminalModeShortcut } from './terminalHooks'
import { AgentIdentity } from './usage/AgentIdentity'
import { UsageBar } from './usage/UsageBar'
import { ConstellationView } from './views/ConstellationView'
import { FlowView } from './views/FlowView'
import { HiveView } from './views/HiveView'
import { MissionControlView } from './views/MissionControlView'
import { TerminalsView } from './views/TerminalsView'
import { TimelineView } from './views/TimelineView'

const MODES: Record<
  OrchestraViewMode,
  { icon: LucideIcon; label: MessageKey; view: ComponentType }
> = {
  constellation: { icon: Orbit, label: 'orchestra.mode.constellation', view: ConstellationView },
  mission: { icon: LayoutDashboard, label: 'orchestra.mode.mission', view: MissionControlView },
  flow: { icon: Workflow, label: 'orchestra.mode.flow', view: FlowView },
  terminals: { icon: SquareTerminal, label: 'orchestra.mode.terminals', view: TerminalsView },
  timeline: { icon: ChartGantt, label: 'orchestra.mode.timeline', view: TimelineView },
  hive: { icon: Hexagon, label: 'orchestra.mode.hive', view: HiveView },
}

const DRAWER_WIDTH_KEY = 'orchestra.drawerWidth'
const DRAWER_MIN = 360
const DRAWER_MAX = 960
const DRAWER_DEFAULT = 520
/** Share of the session body the drawer may take; the `.drawer` max-width in the CSS. */
const DRAWER_MAX_SHARE = 0.7

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Remembered UI preferences are a convenience only.
  }
}

/** True when the key event comes from a text field or a terminal, which own their keys. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], .xterm'))
  )
}

export function OrchestraView() {
  const { hasSessions, activeId, shown } = useOrchestraStore(
    useShallow((s) => ({
      hasSessions: s.order.length > 0,
      activeId: s.activeId,
      // Joined so the shallow comparison sees a value, not a fresh array per store update.
      shown: shownSessionIds(s).join(' '),
    })),
  )
  const projectId = useProjectsStore((s) => s.activeProjectId)

  // Opening the view or picking a project in the sidebar shows that project's most recent
  // orchestration, or its start screen; never another project's. The tab strip keeps them all.
  useEffect(() => {
    const state = useOrchestraStore.getState()
    const target = sessionForProject(state, projectId)
    if (target !== undefined && target !== state.activeId) state.setActive(target)
  }, [projectId])

  return (
    <div className={styles.view}>
      <InterruptedBanner />
      {hasSessions ? <SessionTabs /> : null}
      {activeId && shown ? (
        <SessionPanes ids={shown.split(' ')} focusedId={activeId} render={renderSession} />
      ) : (
        <OrchestraStart />
      )}
    </div>
  )
}

/** One pane: everything below is scoped to its session (views, drawer, footer, shortcuts). */
function renderSession(sessionId: string) {
  return (
    <OrchestraSessionProvider sessionId={sessionId}>
      <OrchestraSession />
    </OrchestraSessionProvider>
  )
}

/* ---------------------------------------------------------------- active session */

function OrchestraSession() {
  const t = useT()
  const {
    goal,
    startedAt,
    mode,
    agents,
    messageCount,
    selectedId,
    autonomous,
    cwd,
    error,
    stoppedAt,
  } = useSession(
    useShallow((s) => ({
      goal: s.goal,
      startedAt: s.startedAt,
      mode: s.mode,
      agents: s.agents,
      messageCount: s.messages.length,
      selectedId: s.selectedId,
      autonomous: s.autonomous,
      cwd: s.cwd,
      error: s.error,
      stoppedAt: s.stoppedAt ?? null,
    })),
  )
  const [reportOpen, setReportOpen] = useState(false)
  // The accounts panel on the session's side rail (Alt+A); closing it returns the focus.
  const [accountsOpen, setAccountsOpen] = useState(false)
  const accountsButton = useRef<HTMLButtonElement>(null)
  const closeAccounts = () => {
    setAccountsOpen(false)
    accountsButton.current?.focus()
  }
  const toggleAccounts = () => (accountsOpen ? closeAccounts() : setAccountsOpen(true))
  useAccountsShortcut(toggleAccounts)
  const { setMode, select } = useSessionActions()
  const getSession = useSessionGetter()
  const sessionId = useSessionId()
  const focused = useSessionFocused()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Alt+1..6 switches view (capture phase so a focused terminal does not receive it); Esc clears
  // the selection unless a field or terminal owns the key (Esc interrupts Claude in its terminal).
  // Side by side, only the focused pane listens.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-6]$/.test(e.code)) {
        const next = ORCHESTRA_VIEW_MODES[Number(e.code.slice(5)) - 1]
        if (next) {
          e.preventDefault()
          e.stopPropagation()
          setMode(next)
        }
        return
      }
      if (e.key === 'Escape' && !isTypingTarget(e.target) && getSession().selectedId) {
        select(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [focused, getSession, select, setMode])

  const workers = workersOf(agents)
  const overall = overallProgress(agents)
  const blocked = workers.filter((w) => w.state === 'blocked').length
  // A worker that failed is not done: "all done" means every worker reported done.
  const failed = workers.filter(isFailed).length
  const allDone = workers.length > 0 && workers.every((w) => w.state === 'done')
  const orchestrator = agents.find((a) => a.id === ORCHESTRATOR_ID)
  const orchestratorDown = orchestrator && isFailed(orchestrator) ? orchestrator : null
  const selected = agents.find((a) => a.id === selectedId) ?? null
  const showDrawer = Boolean(selected) && mode !== 'terminals'
  const View = MODES[mode].view

  // Stop ends the agents and keeps the session readable; Close forgets a stopped session. The
  // tab's ✕ asks the same questions (see sessionActions).
  const onStop = () => void askStopAgents(sessionId, t)
  const onClose = () => void askCloseSession(sessionId, t)

  return (
    <div className={styles.session}>
      <header className={styles.topBar}>
        <div className={styles.brand}>
          <span className={styles.markSmall} aria-hidden="true">
            ✻
          </span>
          {t('orchestra.start.title')}
        </div>
        <span className={styles.vsep} />
        <nav className={styles.modes} aria-label={t('orchestra.modes')}>
          {ORCHESTRA_VIEW_MODES.map((id, index) => {
            const { icon: Icon, label } = MODES[id]
            return (
              <button
                key={id}
                type="button"
                className={mode === id ? `${styles.mode} ${styles.modeOn}` : styles.mode}
                aria-pressed={mode === id}
                title={t('orchestra.modeShortcut', { label: t(label), n: index + 1 })}
                onClick={() => setMode(id)}
              >
                <Icon size={13} />
                <span className={styles.modeLabel}>{t(label)}</span>
              </button>
            )
          })}
        </nav>
        <div className={styles.goal} title={goal || undefined}>
          <span className={styles.k}>{t('orchestra.goal')}</span>
          <span className={goal ? styles.v : `${styles.v} ${styles.vEmpty}`}>
            {goal || t('orchestra.noGoal')}
          </span>
        </div>
        <div className={styles.usage}>
          <UsageBar />
        </div>
        <SessionAccountChip onOpen={() => setAccountsOpen(true)} />
        <div className={styles.meta}>
          <span className={styles.metaElapsed}>
            {t('orchestra.elapsed')} <b>{elapsed(startedAt, stoppedAt ?? now)}</b>
          </span>
          <span>
            {t('orchestra.overall')} <b>{overall}%</b>
          </span>
          <span className={styles.metaWorkers}>
            <b>
              {workers.length === 1
                ? t('orchestra.workerCountOne')
                : t('orchestra.workerCount', { count: workers.length })}
            </b>
          </span>
        </div>
        <ScribeChip />
        <button
          type="button"
          className={selectedId === ORCHESTRATOR_ID ? `${styles.btn} ${styles.btnOn}` : styles.btn}
          title={t('orchestra.orchestratorTitle')}
          aria-label={t('orchestra.orchestrator')}
          onClick={() => select(selectedId === ORCHESTRATOR_ID ? null : ORCHESTRATOR_ID)}
        >
          <span className={styles.orchMark}>✻</span>
          <span className={styles.btnText}>{t('orchestra.orchestrator')}</span>
        </button>
        {/* Always on screen: the goal (which also showed it) gives way first in a narrow pane. */}
        <span
          className={autonomous ? styles.tagWarn : styles.tag}
          title={
            autonomous
              ? t('orchestra.agents.modeTagTitle')
              : t('orchestra.agents.modeTagSupervisedTitle')
          }
        >
          {autonomous ? t('orchestra.autonomousTag') : t('orchestra.supervisedTag')}
        </span>
        <button
          type="button"
          className={styles.btn}
          title={t('orchestra.report.openTitle')}
          aria-label={t('orchestra.report.open')}
          onClick={() => setReportOpen(true)}
        >
          <FileText size={12} />
          <span className={styles.btnText}>{t('orchestra.report.open')}</span>
        </button>
        {stoppedAt ? (
          <>
            <span className={styles.tag} title={t('orchestra.session.stoppedTitle')}>
              {t('orchestra.session.stoppedAt', { time: clockTime(stoppedAt) })}
            </span>
            <button
              type="button"
              className={styles.btn}
              title={t('orchestra.session.closeTitle')}
              aria-label={t('orchestra.session.close')}
              onClick={onClose}
            >
              <X size={12} />
              <span className={styles.btnText}>{t('orchestra.session.close')}</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            title={t('orchestra.stop')}
            aria-label={t('orchestra.stop')}
            onClick={onStop}
          >
            <Square size={11} />
            <span className={styles.btnText}>{t('orchestra.stop')}</span>
          </button>
        )}
      </header>
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />

      <div className={accountStyles.strips}>
        {error || orchestratorDown ? (
          // The launch error names its agent and can be dismissed; a stopped orchestrator stays
          // on screen for as long as it is down.
          <div className={styles.errorStrip} role="alert">
            <div className={alertStyles.stripRow}>
              <span className={alertStyles.stripText}>
                {error
                  ? t('common.errorPrefix', { message: error })
                  : orchestratorDown
                    ? t('orchestra.agents.orchestratorDown', {
                        reason: describeExit(t, orchestratorDown),
                      })
                    : null}
              </span>
              {error ? (
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={t('orchestra.agents.dismiss')}
                  title={t('orchestra.agents.dismiss')}
                  onClick={() => useOrchestraStore.getState().dismissError(sessionId)}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <LimitStrip now={now} onSwitch={() => setAccountsOpen(true)} />
      </div>

      <div className={`${styles.body} ${accountStyles.host}`}>
        <main className={styles.main}>
          <ErrorBoundary key={mode} label="orchestra">
            <View />
          </ErrorBoundary>
        </main>
        {showDrawer && selected ? (
          <AgentDrawer key={selected.id} agent={selected} cwd={cwd} onClose={() => select(null)} />
        ) : null}
        {accountsOpen ? <AccountsPanel onClose={closeAccounts} /> : null}
        <AccountsRail open={accountsOpen} onToggle={toggleAccounts} buttonRef={accountsButton} />
        <AccountSwitchToast />
      </div>

      <footer className={styles.footer}>
        <AttentionLive sessionId={sessionId} />
        <span
          className={
            failed > 0 || orchestratorDown
              ? alertStyles.dotFail
              : allDone
                ? styles.dotDone
                : blocked > 0
                  ? styles.dotWarn
                  : styles.dot
          }
        >
          ●
        </span>
        <span className={styles.footCounts}>
          <b>
            {agents.length === 1
              ? t('orchestra.footer.agentsOne')
              : t('orchestra.footer.agents', { count: agents.length })}
          </b>
          {' · '}
          {t('orchestra.footer.messages', { count: messageCount })}
          {allDone ? ` · ${t('orchestra.footer.allDone')}` : ''}
          {blocked > 0 ? (
            <span className={styles.footWarn}>
              {' '}
              · {t('orchestra.footer.blocked', { count: blocked })}
            </span>
          ) : null}
          {failed > 0 ? (
            <span className={alertStyles.footFail}>
              {' '}
              · {t('orchestra.agents.footerFailed', { count: failed })}
            </span>
          ) : null}
        </span>
        <span className={styles.footCwd} title={cwd ?? undefined}>
          {cwd}
        </span>
        <span className={styles.spacer} />
        <span className={styles.footKeys}>{t('orchestra.footer.shortcuts')}</span>
      </footer>
    </div>
  )
}

/* ---------------------------------------------------------------- agent drawer */

function AgentDrawer({
  agent,
  cwd,
  onClose,
}: {
  agent: OrchestraAgent
  cwd: string | null
  onClose: () => void
}) {
  const t = useT()
  const { sendTo } = useSessionActions()
  const sessionId = useSessionId()
  const [width, setWidth] = useState(() => {
    const saved = Number(readStorage(DRAWER_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= DRAWER_MIN
      ? Math.min(saved, DRAWER_MAX)
      : DRAWER_DEFAULT
  })
  // Per agent: text typed for claude-1 never goes to claude-2 after a click elsewhere.
  const [draft, setDraft] = useDraftText(draftKey.agent(sessionId, agent.id))
  const inputRef = useRef<HTMLInputElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const asideRef = useRef<HTMLElement>(null)

  /** Widest drag: DRAWER_MAX, and never past the CSS max-width, which would leave a dead zone. */
  const widest = () => {
    const body = asideRef.current?.parentElement?.clientWidth ?? 0
    return body > 0 ? Math.min(DRAWER_MAX, Math.floor(body * DRAWER_MAX_SHARE)) : DRAWER_MAX
  }

  const onResizeStart = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    // From the width on screen: a narrow pane can show less than the remembered one.
    drag.current = { x: e.clientX, width: asideRef.current?.offsetWidth || width }
  }
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const next = drag.current.width + (drag.current.x - e.clientX)
    setWidth(Math.min(widest(), Math.max(DRAWER_MIN, next)))
  }
  const onResizeEnd = () => {
    if (!drag.current) return
    drag.current = null
    writeStorage(DRAWER_WIDTH_KEY, String(width))
  }
  const resizeTo = (next: number) => {
    const clamped = Math.min(widest(), Math.max(DRAWER_MIN, Math.round(next)))
    setWidth(clamped)
    writeStorage(DRAWER_WIDTH_KEY, String(clamped))
  }
  /** Keyboard twin of the drag, as on the side-by-side divider. The handle is the left edge. */
  const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const shown = asideRef.current?.offsetWidth || width
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') resizeTo(shown + step)
    else if (e.key === 'ArrowRight') resizeTo(shown - step)
    else if (e.key === 'Home') resizeTo(DRAWER_MIN)
    else if (e.key === 'End') resizeTo(widest())
    else return
    e.preventDefault()
  }

  // A stopped orchestration is read-only: its terminals are gone, their transcripts stay.
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  // Only a process still running, confirmed by the backend, gets an interactive terminal: the
  // classic view would start a stray `claude` for a PTY that is gone (a worker that ended after
  // reporting done). Any other keeps its transcript, read-only.
  const ended = processEnded(agent) || stopped
  const gate = usePtyGate(ended ? null : agent.ptyId)
  const live = Boolean(agent.ptyId) && !ended && gate === 'alive'
  const attaching = Boolean(agent.ptyId) && !ended && gate === 'checking'
  // No terminal yet: waiting for its dependencies (or held because one failed), or launching.
  const waitsForDeps =
    !stopped && (agent.state === 'waiting' || (agent.state === 'blocked' && !agent.ptyId))
  const booting =
    !stopped && (agent.state === 'starting' || (!agent.ptyId && agent.state !== 'exited'))
  // A worker that has not started yet takes messages too: they wait in its queue.
  const canMessage = !ended
  // An ended agent keeps its whole transcript readable (and copyable) while the session runs.
  const hasTranscript = useHasTranscript(agent.ptyId)
  useTerminalModeShortcut()
  const send = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !canMessage) return
    void sendTo(agent.id, text)
    setDraft('')
  }

  const isOrch = agent.id === ORCHESTRATOR_ID
  const role = isOrch ? 'orchestrator' : 'worker'
  const stateLabel = t(endedByUserKey(agent) ?? (`orchestra.state.${agent.state}` as MessageKey))

  return (
    <aside ref={asideRef} className={styles.drawer} style={{ width }} aria-label={agent.id}>
      <div
        className={styles.resizer}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('orchestra.drawer.resize')}
        aria-valuenow={width}
        aria-valuemin={DRAWER_MIN}
        aria-valuemax={DRAWER_MAX}
        title={t('orchestra.a11y.drawerResizeHint')}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => resizeTo(DRAWER_DEFAULT)}
        onKeyDown={onResizeKey}
      />
      <header className={styles.drawerHead}>
        <span className={isOrch ? styles.orchMark : styles.workerMark}>✻</span>
        <span className={styles.drawerId}>{agent.id}</span>
        {!isOrch ? <span className={styles.drawerArea}>· {agent.area}</span> : null}
        {!isOrch ? <CreativeMark area={agent.area} /> : null}
        <AgentIdentity account={agent.account} model={agent.model} effort={agent.effort} />
        <span className={styles.drawerState} style={{ color: stateColor(agent.state) }}>
          {stateLabel}
        </span>
        {!isOrch ? <span className={styles.drawerPct}>{agent.progress}%</span> : null}
        <span className={styles.spacer} />
        <AgentControls agent={agent} buttonClassName={styles.iconBtn} />
        {live ? <TerminalModeToggle className={styles.iconBtn} /> : null}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onClose}
          aria-label={t('orchestra.drawer.close')}
          title={t('orchestra.drawer.close')}
        >
          <X size={14} />
        </button>
      </header>
      {!isOrch ? (
        <div className={styles.drawerBar}>
          <i style={{ width: `${agent.progress}%`, background: stateColor(agent.state) }} />
        </div>
      ) : null}
      {agent.task && !isOrch ? (
        <div className={styles.drawerTask} title={agent.task}>
          <span className={styles.k}>{t('orchestra.drawer.task')}</span> {agent.task}
        </div>
      ) : null}
      {agent.note && !isFailed(agent) ? (
        <div className={styles.drawerNote}>◆ {agent.note}</div>
      ) : null}
      {/* Not above a live terminal: that would resize the PTY mid-dialog, and the terminal
          already shows the question. */}
      {!live ? (
        <AgentAlert
          agent={agent}
          onReply={canMessage ? () => inputRef.current?.focus() : undefined}
        />
      ) : null}

      <div className={styles.drawerTerm}>
        {live && agent.ptyId ? (
          <AgentTerminal
            key={agent.ptyId}
            sessionId={sessionId}
            agentId={agent.id}
            ptyId={agent.ptyId}
            role={role}
            alive
            cwd={cwd}
            autoFocus
          />
        ) : attaching ? (
          <p className={styles.drawerEmpty}>{t('orchestra.terminals.attaching')}</p>
        ) : waitsForDeps ? (
          <p className={styles.drawerEmpty}>
            {t('orchestra.drawer.waitingFor', { deps: agent.after.join(', ') })}
          </p>
        ) : booting ? (
          <p className={styles.drawerEmpty}>{t('orchestra.drawer.starting')}</p>
        ) : agent.ptyId && hasTranscript ? (
          <AgentTerminal
            key={agent.ptyId}
            sessionId={sessionId}
            agentId={agent.id}
            ptyId={agent.ptyId}
            role={role}
            alive={false}
            cwd={cwd}
          />
        ) : (
          <div className={styles.drawerLines}>
            <p className={styles.drawerEmpty}>{t('orchestra.drawer.exited')}</p>
            {agent.lines.length === 0 ? (
              <p className={styles.drawerEmpty}>{t('orchestra.drawer.noActivity')}</p>
            ) : (
              agent.lines.slice(-30).map((line, i) => (
                <div key={`${line.at}-${i}`} className={styles[`tone_${line.tone}`]}>
                  {line.text}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <form className={styles.sendBox} onSubmit={send}>
        <input
          ref={inputRef}
          className={styles.sendInput}
          value={draft}
          disabled={!canMessage}
          placeholder={t('orchestra.drawer.sendPlaceholder', { id: agent.id })}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className={styles.btn}
          disabled={!canMessage || !draft.trim()}
          title={t('orchestra.agents.sendTo', { id: agent.id })}
        >
          <Send size={12} />
          {t('orchestra.drawer.send')}
        </button>
      </form>
    </aside>
  )
}
