import { Columns2, Plus, X } from 'lucide-react'
import { type KeyboardEvent, type MouseEvent, useEffect, type WheelEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useT } from '../../lib/i18n'
import { shownSessionIds, splitPartnerId, useOrchestraStore } from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { showSession } from './navigation'
import { askEndSession } from './sessionActions'
import {
  cycleId,
  folderName,
  forgetUnseen,
  markSeen,
  needsAttention,
  paneElementId,
  tabCycleStep,
  tabElementId,
  type TabSummary,
  tabSummary,
} from './sessionLayout'
import styles from './SessionTabs.module.css'

/** One tab per running orchestration, a button to start another one and the side-by-side toggle. */
export function SessionTabs() {
  const t = useT()
  const { order, activeId, shown, split } = useOrchestraStore(
    useShallow((s) => ({
      order: s.order,
      activeId: s.activeId,
      // Joined so the shallow comparison sees a value, not a fresh array per store update.
      shown: shownSessionIds(s).join(' '),
      split: splitPartnerId(s) !== null,
    })),
  )
  const setActive = useOrchestraStore((s) => s.setActive)
  const toggleSplit = useOrchestraStore((s) => s.toggleSplit)
  const onScreen = shown ? shown.split(' ') : []

  useEffect(() => forgetUnseen(order), [order])

  useEffect(() => {
    if (!activeId) return
    document.getElementById(tabElementId(activeId))?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  // Many tabs scroll sideways; a plain mouse wheel only scrolls vertically.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const list = e.currentTarget
    if (e.deltaY !== 0 && list.scrollWidth > list.clientWidth) list.scrollLeft += e.deltaY
  }

  // Capture phase, so a focused terminal does not also receive the keys.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const step = tabCycleStep(e)
      if (!step) return
      const s = useOrchestraStore.getState()
      const next = cycleId(s.order, s.activeId ?? s.recent[0] ?? null, step)
      if (!next) return
      e.preventDefault()
      e.stopPropagation()
      showSession(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /** Tablist keys: arrows, Home and End move between tabs and show them; Delete ends one. */
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-session-id]')?.dataset
      .sessionId
    if (!current) return
    if (e.key === 'Delete') {
      e.preventDefault()
      void askEndSession(current, t)
      return
    }
    const next =
      e.key === 'ArrowRight'
        ? cycleId(order, current, 1)
        : e.key === 'ArrowLeft'
          ? cycleId(order, current, -1)
          : e.key === 'Home'
            ? order[0]
            : e.key === 'End'
              ? order[order.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    showSession(next)
    document.getElementById(tabElementId(next))?.focus()
  }

  const splitTitle = split
    ? t('orchestra.sessions.splitOff')
    : order.length < 2
      ? t('orchestra.sessions.splitNeedsTwo')
      : t('orchestra.sessions.splitOn')

  return (
    <div className={styles.strip}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label={t('orchestra.sessions.tabs')}
        onKeyDown={onListKey}
        onWheel={onWheel}
      >
        {order.map((id, index) => (
          <SessionTab
            key={id}
            id={id}
            focused={id === activeId}
            onScreen={onScreen.includes(id)}
            tabbable={activeId ? id === activeId : index === 0}
            onSelect={() => showSession(id)}
          />
        ))}
      </div>
      <button
        type="button"
        className={activeId ? styles.action : `${styles.action} ${styles.actionOn}`}
        title={t('orchestra.sessions.newTitle')}
        aria-label={t('orchestra.sessions.new')}
        onClick={() => setActive(null)}
      >
        <Plus size={14} />
      </button>
      <span className={styles.spacer} />
      <button
        type="button"
        className={split ? `${styles.action} ${styles.actionOn}` : styles.action}
        aria-pressed={split}
        disabled={!activeId || order.length < 2}
        title={splitTitle}
        onClick={toggleSplit}
      >
        <Columns2 size={14} />
        <span className={styles.actionText}>{t('orchestra.sessions.split')}</span>
      </button>
    </div>
  )
}

/** The tab's status line: what the session needs, then how far it got. */
function statusText(summary: TabSummary, t: ReturnType<typeof useT>): string {
  const pct = summary.overall
  switch (summary.status) {
    case 'stopped':
      return t('orchestra.sessions.status.stopped', { pct })
    case 'error':
      if (summary.orchestratorDown) return t('orchestra.sessions.status.orchestratorDown', { pct })
      return summary.failed > 0
        ? t('orchestra.sessions.status.error', { count: summary.failed, pct })
        : t('orchestra.sessions.status.launchError', { pct })
    case 'blocked':
      return t('orchestra.sessions.status.blocked', { count: summary.blocked, pct })
    case 'done':
      return t('orchestra.sessions.status.done', { pct })
    default:
      return t('orchestra.sessions.status.working', { pct })
  }
}

function SessionTab({
  id,
  focused,
  onScreen,
  tabbable,
  onSelect,
}: {
  id: string
  focused: boolean
  onScreen: boolean
  tabbable: boolean
  onSelect: () => void
}) {
  const t = useT()
  const summary = useOrchestraStore(useShallow((s) => tabSummary(s.sessions[id])))
  const projectName = useProjectsStore(
    (s) => s.projects.find((p) => p.id === summary.projectId)?.name,
  )
  const name = projectName || folderName(summary.cwd) || t('orchestra.sessions.untitled')
  const attention = needsAttention(id, summary.status, onScreen)

  // What the user saw last; a later block or finish off screen marks the tab until it is shown.
  useEffect(() => {
    if (onScreen) markSeen(id, summary.status)
  }, [id, onScreen, summary.status])

  const status = statusText(summary, t)
  const title = [
    name,
    t('orchestra.sessions.goalLine', { goal: summary.goal || t('orchestra.sessions.noGoal') }),
    summary.cwd ? t('orchestra.sessions.folderLine', { cwd: summary.cwd }) : null,
    status,
    attention ? t('orchestra.sessions.changed') : null,
    t('orchestra.sessions.cycleHint'),
  ]
    .filter(Boolean)
    .join('\n')

  const onMouseDown = (e: MouseEvent) => {
    // Middle button: no autoscroll cursor; its release ends the session like the ✕.
    if (e.button === 1) e.preventDefault()
  }
  const onAuxClick = (e: MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    void askEndSession(id, t)
  }
  // A running orchestration is stopped (and stays readable); only a stopped one is closed.
  const endLabel = t(
    summary.status === 'stopped' ? 'orchestra.sessions.closeStopped' : 'orchestra.sessions.close',
    { name },
  )

  return (
    <div
      className={styles.tab}
      data-session-id={id}
      data-status={summary.status}
      data-focused={focused || undefined}
      data-shown={onScreen || undefined}
      data-attention={attention || undefined}
      onMouseDown={onMouseDown}
      onAuxClick={onAuxClick}
    >
      <button
        type="button"
        id={tabElementId(id)}
        role="tab"
        aria-selected={focused}
        aria-controls={onScreen ? paneElementId(id) : undefined}
        tabIndex={tabbable ? 0 : -1}
        className={styles.tabMain}
        title={title}
        onClick={onSelect}
      >
        {/* A glyph per state, so blocked and failed never depend on color alone. */}
        <span className={styles.marker} aria-hidden="true">
          {summary.status === 'done'
            ? '✓'
            : summary.status === 'error'
              ? '✕'
              : summary.status === 'blocked'
                ? '!'
                : summary.status === 'stopped'
                  ? '■'
                  : null}
        </span>
        <span className={styles.name}>{name}</span>
        {summary.goal ? <span className={styles.goal}>{summary.goal}</span> : null}
        <span className={styles.pct}>{summary.overall}%</span>
        {summary.blocked > 0 ? (
          <span className={styles.badge} aria-hidden="true">
            {summary.blocked}
          </span>
        ) : null}
        {summary.failed > 0 ? (
          <span
            className={`${styles.badge} ${styles.badgeFailed}`}
            aria-hidden="true"
            title={t('orchestra.sessions.failedBadge', { count: summary.failed })}
          >
            ✕{summary.failed}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={styles.close}
        tabIndex={focused ? 0 : -1}
        aria-label={endLabel}
        title={endLabel}
        onClick={() => void askEndSession(id, t)}
      >
        <X size={12} />
      </button>
    </div>
  )
}
