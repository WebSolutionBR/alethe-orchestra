/**
 * The scribe as each Orchestra view shows it. It is never a worker: these marks sit next to
 * the orchestrator, carry Obsidian's purple and crystal, and open the scribe panel on click.
 */
import { type CSSProperties, type KeyboardEvent, type MouseEvent, useRef } from 'react'

import { useT } from '../../../lib/i18n'
import type { BusMessage } from '../../../stores/orchestraStore'
import { useAuthorStatus } from './authorStatus'
import { notePathFor, useScribeConfig } from './config'
import { noteFileName } from './identity'
import { ScribeIdentity } from './ScribeIdentity'
import styles from './ScribeMarks.module.css'
import { openScribePanel } from './ui'
import { useRelativeTime, useScribeView } from './useScribe'

function activate(event: KeyboardEvent, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    action()
  }
}

/** Props that make a mark open the scribe panel of its session (not a hook). */
function openPanelProps(sessionId: string) {
  const open = (event?: MouseEvent) => {
    event?.stopPropagation()
    openScribePanel(sessionId)
  }
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: open,
    onKeyDown: (event: KeyboardEvent) => activate(event, () => open()),
  }
}

/** Count of blocks seen at mount, so marks only pulse for writes that happen while shown. */
function usePulse(count: number): boolean {
  const first = useRef(count)
  return count > first.current
}

/* ---------------------------------------------------------------- constellation */

/** Fixed node docked under the orchestrator; it pulses when a block is written. */
export function ScribeNode({
  sessionId,
  lines,
  x,
  y,
  width,
  height,
}: {
  sessionId: string
  lines: BusMessage[]
  /** Center of the node, in the view's world coordinates. */
  x: number
  y: number
  width: number
  height?: number
}) {
  const t = useT()
  const view = useScribeView(sessionId)
  const relative = useRelativeTime()
  const last = lines.length ? lines[lines.length - 1] : null
  const pulse = usePulse(lines.length)
  return (
    <div
      className={styles.node}
      data-state={view.state}
      style={{ left: x, top: y, width, height }}
      aria-label={t('orchestra.scribe.nodeLabel', { state: view.label, count: lines.length })}
      title={view.reason ?? t('orchestra.scribe.role')}
      {...openPanelProps(sessionId)}
    >
      {pulse ? <i key={lines.length} className={styles.ping} aria-hidden="true" /> : null}
      <div className={styles.nodeRow}>
        <ScribeIdentity size={12} />
        <span className={styles.nodeState} style={{ color: view.color }}>
          {view.label}
        </span>
      </div>
      <div className={styles.nodeMeta}>
        {view.reason ??
          `${t('orchestra.scribe.blocks', { count: lines.length })}${last ? ` · ${relative(last.at)}` : ''}`}
      </div>
    </div>
  )
}

/** Link from the orchestrator to the scribe; a dot travels down it for every written block. */
export function ScribeLink({
  x,
  y1,
  y2,
  count,
}: {
  x: number
  y1: number
  y2: number
  count: number
}) {
  const pulse = usePulse(count)
  return (
    <g className={styles.link}>
      <line x1={x} y1={y1} x2={x} y2={y2} />
      {pulse ? (
        <circle
          key={count}
          className={styles.linkDot}
          cx={x}
          cy={y1}
          r={3}
          style={{ '--travel': `${Math.max(0, y2 - y1)}px` } as CSSProperties}
        />
      ) : null}
    </g>
  )
}

/* ---------------------------------------------------------------- mission control */

export function ScribeCard({ sessionId, lines }: { sessionId: string; lines: BusMessage[] }) {
  const t = useT()
  const view = useScribeView(sessionId)
  const relative = useRelativeTime()
  const config = useScribeConfig()
  const author = useAuthorStatus(sessionId)
  // The session's diary note once the author wrote it; the agents' note until then.
  const note = author.notePath ?? notePathFor(config)
  const last = lines.length ? lines[lines.length - 1] : null
  const pulse = usePulse(lines.length)
  return (
    <section
      className={styles.card}
      data-state={view.state}
      aria-label={t('orchestra.scribe.nodeLabel', { state: view.label, count: lines.length })}
      {...openPanelProps(sessionId)}
    >
      {pulse ? <i key={lines.length} className={styles.ping} aria-hidden="true" /> : null}
      <header className={styles.cardHead}>
        <ScribeIdentity variant="mark" size={13} />
        <span className={styles.cardName}>{t('orchestra.scribe.name')}</span>
        <span className={styles.cardRole}>{t('orchestra.scribe.role')}</span>
        <span className={styles.spacer} />
        <span className={styles.pill} style={{ color: view.color }}>
          <i aria-hidden="true" />
          {view.label}
        </span>
      </header>
      {view.reason ? <p className={styles.warn}>! {view.reason}</p> : null}
      <div className={styles.cardFacts}>
        <span className={styles.notePath} title={note}>
          {note}
        </span>
        <span>{t('orchestra.scribe.blocks', { count: lines.length })}</span>
        <span>{last ? relative(last.at) : t('orchestra.scribe.never')}</span>
      </div>
      {last ? (
        <p className={styles.cardPreview} title={last.text}>
          {last.text}
        </p>
      ) : null}
    </section>
  )
}

/* ---------------------------------------------------------------- terminals */

/**
 * The scribe's tile in the terminals grid, instead of a terminal: the session's note, what the
 * author is doing and what its last synthesis wrote.
 */
export function ScribeTile({ sessionId, style }: { sessionId: string; style?: CSSProperties }) {
  const t = useT()
  const view = useScribeView(sessionId)
  const relative = useRelativeTime()
  const author = useAuthorStatus(sessionId)
  const others = author.notes.filter((note) => note !== author.notePath)

  const openProps = openPanelProps(sessionId)
  return (
    <section className={styles.tile} data-state={view.state} style={style}>
      <div
        className={styles.tileHead}
        {...openProps}
        aria-label={t('orchestra.scribe.nodeLabel', { state: view.label, count: author.syntheses })}
      >
        <span className={styles.tileDot} style={{ background: view.color }} />
        <ScribeIdentity size={12} />
        <span className={styles.tileState} style={{ color: view.color }}>
          {view.label}
        </span>
        <span className={styles.spacer} />
        <span className={styles.tileCount}>
          {t('orchestra.scribe.blocks', { count: author.syntheses })}
        </span>
      </div>
      <div className={styles.tileBody}>
        {view.reason ? <p className={styles.warn}>! {view.reason}</p> : null}
        {author.lastAt === null ? (
          <p className={styles.tileEmpty}>{t('orchestra.scribe.tileEmpty')}</p>
        ) : (
          <article className={styles.block}>
            <span className={styles.blockTime}>{relative(author.lastAt)}</span>
            {author.notePath ? (
              <span className={styles.blockHead}>{noteFileName(author.notePath)}</span>
            ) : null}
            {author.summary ? <span className={styles.blockLine}>{author.summary}</span> : null}
            {others.map((note) => (
              <span key={note} className={styles.blockLine}>
                {noteFileName(note)}
              </span>
            ))}
          </article>
        )}
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- flow / hive */

/** Compact mark for legends and docks: crystal, name, blocks written for the session. */
export function ScribeBadge({
  sessionId,
  count,
  className,
}: {
  sessionId: string
  count: number
  className?: string
}) {
  const t = useT()
  const view = useScribeView(sessionId)
  const pulse = usePulse(count)
  return (
    <span
      className={className ? `${styles.badge} ${className}` : styles.badge}
      data-state={view.state}
      aria-label={t('orchestra.scribe.nodeLabel', { state: view.label, count })}
      title={view.reason ?? t('orchestra.scribe.role')}
      {...openPanelProps(sessionId)}
    >
      {pulse ? <i key={count} className={styles.ping} aria-hidden="true" /> : null}
      <ScribeIdentity size={12} />
      <span className={styles.badgeMeta} style={{ color: view.color }}>
        {view.state === 'listening' ? t('orchestra.scribe.blocks', { count }) : view.label}
      </span>
    </span>
  )
}

/* ---------------------------------------------------------------- timeline */

export function ScribeLaneLabel({
  sessionId,
  className,
}: {
  sessionId: string
  className?: string
}) {
  const t = useT()
  const view = useScribeView(sessionId)
  return (
    <div
      className={className ? `${styles.laneLabel} ${className}` : styles.laneLabel}
      title={view.reason ?? t('orchestra.scribe.role')}
      {...openPanelProps(sessionId)}
    >
      <span className={styles.tileDot} style={{ background: view.color }} />
      <span className={styles.laneText}>
        <ScribeIdentity size={11} />
        <span className={styles.laneSub}>{t('orchestra.scribe.lane')}</span>
      </span>
    </div>
  )
}

export function ScribeLaneSummary({ count, className }: { count: number; className?: string }) {
  const t = useT()
  const view = useScribeView()
  return (
    <div className={className ? `${styles.laneSummary} ${className}` : styles.laneSummary}>
      <span className={styles.laneCount}>{t('orchestra.scribe.blocks', { count })}</span>
      <span style={{ color: view.color }}>{view.label}</span>
    </div>
  )
}

/** One tick per written block on the timeline's scribe lane (SVG). */
export function ScribeTick({
  x,
  y,
  height,
  onEnter,
  onLeave,
  onPick,
}: {
  x: number
  y: number
  height: number
  onEnter: () => void
  onLeave: () => void
  onPick: () => void
}) {
  return (
    <g
      className={styles.tick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(event) => {
        event.stopPropagation()
        onPick()
      }}
    >
      <rect x={x - 5} y={y} width={10} height={height} className={styles.tickHit} />
      <line x1={x} x2={x} y1={y + 3} y2={y + height - 3} />
      <circle cx={x} cy={y + height / 2} r={3} />
    </g>
  )
}
