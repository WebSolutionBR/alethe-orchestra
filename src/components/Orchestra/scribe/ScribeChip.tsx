import {
  Copy,
  ExternalLink,
  FileText,
  Gem,
  NotebookPen,
  Power,
  RotateCw,
  Settings,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { intlLocale, type MessageKey, useT } from '../../../lib/i18n'
import { writeClipboardText } from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useSessionId } from '../sessionContext'
import { type AuthorStatus, useAuthorStatus } from './authorStatus'
import { authorMaxBudget, authorMaxTurns, notePathFor, useScribeConfig } from './config'
import { useSessionContext } from './contextStore'
import { noteFileName, vaultName } from './identity'
import styles from './ScribeChip.module.css'
import { ScribeContextSection } from './ScribeContext'
import { ScribeIdentity } from './ScribeIdentity'
import {
  checkScribe,
  scribeDiscardFailed,
  scribeEnableAuthor,
  scribeRetryNow,
  scribeWriteNow,
  useScribeStatus,
} from './service'
import { openScribeNote, openScribeSettings, panelOpenFor, useScribePanel } from './ui'
import { useRelativeTime, useScribeView } from './useScribe'

const PANEL_W = 360
const MAX_ISSUES = 3

/** The session the chip sits in, when it is mounted inside an `OrchestraSessionProvider`. */
function useOptionalSessionId(): string | null {
  try {
    return useSessionId()
  } catch {
    return null
  }
}

/**
 * The scribe in the session top bar: crystal, name and state (listening, writing, note
 * scheduled, N pending, failing, off). Opens a panel with the session's note and its author.
 */
export function ScribeChip() {
  const t = useT()
  const sessionId = useOptionalSessionId()
  const key = `chip:${useId()}`
  const open = useScribePanel((s) => panelOpenFor(s.open, key, sessionId))
  const view = useScribeView(sessionId)
  const syntheses = useAuthorStatus(sessionId).syntheses
  // The author spends usage, so it waits for the owner: the chip says how to turn it on.
  const authorOff = useScribeConfig((s) => s.enabled && !s.authorEnabled)
  // The session started without its Obsidian context: the chip says so until it ends.
  const contextFailed = useSessionContext(sessionId)?.status === 'failed'
  const anchorRef = useRef<HTMLButtonElement>(null)
  const title = [
    t('orchestra.scribe.chipTitle', { state: view.label }),
    authorOff ? t('orchestra.scribe.author.chipOff') : '',
    contextFailed ? t('orchestra.scribe.context.chipFailed') : '',
  ]
    .filter(Boolean)
    .join(' ')

  const onClick = () => {
    if (open) useScribePanel.getState().close()
    else useScribePanel.getState().toggle(key)
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={styles.chip}
        data-state={view.state}
        data-context={contextFailed ? 'failed' : undefined}
        style={{ '--scribe-tone': view.color } as CSSProperties}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={onClick}
      >
        {view.state === 'failing' || contextFailed ? (
          <TriangleAlert size={12} className={styles.icon} aria-hidden="true" />
        ) : (
          <Gem size={12} className={styles.icon} aria-hidden="true" />
        )}
        <span className={styles.name}>{t('orchestra.scribe.name')}</span>
        <span className={styles.state}>
          <i
            key={syntheses}
            className={styles.dot}
            data-pulse={syntheses > 0 || undefined}
            aria-hidden="true"
          />
          <span className={styles.stateText}>{view.label}</span>
        </span>
      </button>
      {open
        ? createPortal(<ScribePanel anchor={anchorRef} sessionId={sessionId} />, document.body)
        : null}
    </>
  )
}

/** One line on what the session's author is doing, in the user's language. */
function useAuthorLine(author: AuthorStatus): string {
  const t = useT()
  const relative = useRelativeTime()
  const locale = useProjectsStore((s) => s.preferences.language)
  const clock = useMemo(
    () => new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )
  const enabled = useScribeConfig((s) => s.enabled && s.authorEnabled)
  const onWorkerDone = useScribeConfig((s) => s.authorOnWorkerDone)
  if (!enabled) return t('orchestra.scribe.author.phase.off')
  switch (author.phase) {
    case 'scheduled':
      return t('orchestra.scribe.author.phase.scheduled', {
        when: author.dueAt ? relative(author.dueAt) : '',
      })
    case 'queued':
      return t('orchestra.scribe.author.phase.queued')
    case 'writing':
      return t('orchestra.scribe.author.phase.writing', {
        time: clock.format(author.since ?? Date.now()),
      })
    case 'saving':
      return t('orchestra.scribe.author.phase.saving')
    case 'ready':
      return t('orchestra.scribe.author.phase.ready', {
        when: author.lastAt ? relative(author.lastAt) : '',
      })
    case 'failed':
      return t('orchestra.scribe.author.phase.failed', {
        reason: author.failure
          ? t(`orchestra.scribe.author.failure.${author.failure}` as MessageKey)
          : '',
      })
    default:
      return onWorkerDone
        ? t('orchestra.scribe.author.phase.idleWorkers')
        : t('orchestra.scribe.author.phase.idle')
  }
}

function ScribePanel({
  anchor,
  sessionId,
}: {
  anchor: RefObject<HTMLButtonElement>
  sessionId: string | null
}) {
  const t = useT()
  const view = useScribeView(sessionId)
  const relative = useRelativeTime()
  const config = useScribeConfig()
  const status = useScribeStatus()
  const author = useAuthorStatus(sessionId)
  const authorLine = useAuthorLine(author)
  const locale = useProjectsStore((s) => s.preferences.language)
  const money = useMemo(
    () => new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency: 'USD' }),
    [locale],
  )
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [openFailed, setOpenFailed] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const close = useScribePanel((s) => s.close)

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.max(8, Math.min(rect.right - PANEL_W, window.innerWidth - PANEL_W - 8))
      setPos({ top: rect.bottom + 6, left })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close()
      anchor.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, close])

  // A fresh look at Obsidian each time the panel opens.
  useEffect(() => {
    void checkScribe()
  }, [])

  const vault = config.vaultPath.trim()
  const workNote = notePathFor(config)
  const { issue, detail, checking } = status.health
  const canRetry = status.pending > 0 || status.failures > 0 || Boolean(issue)
  const authorOn = config.enabled && config.authorEnabled
  const busy = author.phase === 'writing' || author.phase === 'saving'
  const failed = sessionId
    ? status.failed.filter((item) => !item.session || item.session === sessionId)
    : status.failed

  const openNote = async (note?: string | null) => {
    setOpenFailed(false)
    const ok = await openScribeNote(note)
    if (!ok) setOpenFailed(true)
  }

  const copy = async (id: number, text: string) => {
    try {
      await writeClipboardText(text)
      setCopied(id)
    } catch {
      setCopied(null)
    }
  }

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={t('orchestra.scribe.name')}
      tabIndex={-1}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: PANEL_W,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <header className={styles.head}>
        <ScribeIdentity size={14} />
        <span className={styles.badge} style={{ color: view.color }}>
          {view.label}
        </span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={t('orchestra.scribe.close')}
          title={t('orchestra.scribe.close')}
          onClick={close}
        >
          <X size={13} />
        </button>
      </header>
      <p className={styles.role}>{t('orchestra.scribe.role')}</p>

      {config.enabled && !config.authorEnabled ? (
        <section className={styles.activate} aria-label={t('orchestra.scribe.author.offTitle')}>
          <p className={styles.activateTitle}>{t('orchestra.scribe.author.offTitle')}</p>
          <p className={styles.contextNote}>
            {t('orchestra.scribe.author.offCost', {
              turns: authorMaxTurns(config),
              budget:
                authorMaxBudget(config) > 0
                  ? money.format(authorMaxBudget(config))
                  : t('orchestra.scribe.author.noBudget'),
            })}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              onClick={scribeEnableAuthor}
            >
              <Power size={12} aria-hidden="true" />
              {t('orchestra.scribe.author.enable')}
            </button>
          </div>
        </section>
      ) : null}

      {view.reason ? (
        <div className={styles.warning} role="alert">
          <p>
            <TriangleAlert size={13} aria-hidden="true" />
            <span>{view.reason}</span>
          </p>
          {detail && (issue === 'unreachable' || issue === 'rejected') ? (
            <code className={styles.detail}>{detail}</code>
          ) : null}
          {!issue && author.phase === 'failed' && author.detail ? (
            <code className={styles.detail}>{author.detail}</code>
          ) : null}
          <div className={styles.actions}>
            {config.enabled ? (
              <button
                type="button"
                className={styles.btn}
                disabled={checking}
                onClick={() => void checkScribe({ redetect: true })}
              >
                <RotateCw size={12} aria-hidden="true" />
                {checking ? t('orchestra.scribe.checking') : t('orchestra.scribe.detect')}
              </button>
            ) : (
              <button
                type="button"
                className={styles.btn}
                onClick={() => config.update({ enabled: true })}
              >
                {t('orchestra.scribe.turnOn')}
              </button>
            )}
            <button type="button" className={styles.btn} onClick={openScribeSettings}>
              <Settings size={12} aria-hidden="true" />
              {t('orchestra.scribe.openSettings')}
            </button>
          </div>
        </div>
      ) : null}

      <dl className={styles.facts}>
        {sessionId ? (
          <div>
            <dt>{t('orchestra.scribe.sessionNote')}</dt>
            <dd title={author.notePath ?? undefined}>
              {author.notePath ? (
                <button
                  type="button"
                  className={styles.noteBtn}
                  disabled={!vault}
                  onClick={() => void openNote(author.notePath)}
                >
                  {noteFileName(author.notePath)}
                </button>
              ) : (
                t('orchestra.scribe.sessionNoteNone')
              )}
            </dd>
          </div>
        ) : null}
        {sessionId ? (
          <div>
            <dt>{t('orchestra.scribe.author.label')}</dt>
            <dd title={authorLine} data-tone={author.phase === 'failed' ? 'error' : undefined}>
              {authorLine}
            </dd>
          </div>
        ) : null}
        {sessionId && (author.lastCostUsd !== null || author.sessionCostUsd > 0) ? (
          <div>
            <dt>{t('orchestra.scribe.cost')}</dt>
            <dd>
              {t('orchestra.scribe.costValue', {
                last: author.lastCostUsd === null ? '—' : money.format(author.lastCostUsd),
                session: money.format(author.sessionCostUsd),
              })}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('orchestra.scribe.workNote')}</dt>
          <dd title={workNote}>{workNote}</dd>
        </div>
        <div>
          <dt>{t('orchestra.scribe.vault')}</dt>
          <dd title={vault || undefined}>
            {vault ? vaultName(vault) : t('orchestra.scribe.notSet')}
          </dd>
        </div>
        <div>
          <dt>{t('orchestra.scribe.lastWrite')}</dt>
          <dd>{status.lastOkAt ? relative(status.lastOkAt) : t('orchestra.scribe.never')}</dd>
        </div>
        {status.pending > 0 ? (
          <div>
            <dt>{t('orchestra.scribe.pending')}</dt>
            <dd>
              {t('orchestra.scribe.pendingValue', { count: status.pending })}
              {status.nextRetryAt
                ? ` · ${t('orchestra.scribe.nextRetry', { when: relative(status.nextRetryAt) })}`
                : ''}
            </dd>
          </div>
        ) : null}
        {status.lastError ? (
          <div>
            <dt>{t('orchestra.scribe.lastError')}</dt>
            <dd className={styles.error} title={status.lastError}>
              {status.lastError}
            </dd>
          </div>
        ) : null}
      </dl>

      {sessionId && author.lastAt !== null ? (
        <div className={styles.preview}>
          <span>
            {t('orchestra.scribe.lastSynthesis')} · {relative(author.lastAt)}
          </span>
          {author.summary ? <p>{author.summary}</p> : null}
          {author.notes.length ? (
            <ul className={styles.contextList} aria-label={t('orchestra.scribe.notesTouched')}>
              {author.notes.map((note) => (
                <li key={note}>
                  <button
                    type="button"
                    className={styles.contextItem}
                    title={note}
                    disabled={!vault}
                    onClick={() => void openNote(note)}
                  >
                    <FileText size={12} aria-hidden="true" />
                    <span className={styles.contextTitle}>{noteFileName(note)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {author.issues.length ? (
            <ul className={styles.issueList} aria-label={t('orchestra.scribe.issues')}>
              {author.issues.slice(0, MAX_ISSUES).map((text) => (
                <li key={text} title={text}>
                  {text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {sessionId ? <ScribeContextSection sessionId={sessionId} /> : null}

      {failed.length ? (
        <section
          className={styles.failed}
          aria-label={t('orchestra.scribe.failedItems', { count: failed.length })}
        >
          <header className={styles.contextHead}>
            <span>{t('orchestra.scribe.failedItems', { count: failed.length })}</span>
          </header>
          <p className={styles.contextNote}>{t('orchestra.scribe.failedHint')}</p>
          <ul className={styles.failedList}>
            {failed.map((item) => (
              <li key={item.id} className={styles.failedItem}>
                <span className={styles.failedPath} title={item.notePath}>
                  {noteFileName(item.notePath)}
                </span>
                <span className={styles.failedReason} title={item.reason}>
                  {item.reasonKey
                    ? t(item.reasonKey as MessageKey, item.reasonParams)
                    : item.reason}
                </span>
                <span className={styles.failedActions}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => void copy(item.id, item.content)}
                  >
                    <Copy size={11} aria-hidden="true" />{' '}
                    {copied === item.id
                      ? t('orchestra.scribe.failedCopied')
                      : t('orchestra.scribe.failedCopy')}
                  </button>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => scribeDiscardFailed(item.id)}
                  >
                    <Trash2 size={11} aria-hidden="true" /> {t('orchestra.scribe.failedDiscard')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {status.dropped > 0 ? (
        <p className={styles.contextNote}>
          {t('orchestra.scribe.dropped', { count: status.dropped })}
        </p>
      ) : null}

      <footer className={styles.foot}>
        {sessionId ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            disabled={!authorOn || busy}
            title={authorOn ? undefined : t('orchestra.scribe.writeNowOff')}
            onClick={() => scribeWriteNow(sessionId)}
          >
            <NotebookPen size={12} aria-hidden="true" />
            {t('orchestra.scribe.writeNow')}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.btn}
          disabled={!vault}
          onClick={() => void openNote(author.notePath ?? workNote)}
        >
          <ExternalLink size={12} aria-hidden="true" />
          {t('orchestra.scribe.openNote')}
        </button>
        <button type="button" className={styles.btn} disabled={!canRetry} onClick={scribeRetryNow}>
          <RotateCw size={12} aria-hidden="true" />
          {t('orchestra.scribe.retry')}
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={t('orchestra.scribe.openSettings')}
          title={t('orchestra.scribe.openSettings')}
          onClick={openScribeSettings}
        >
          <Settings size={12} aria-hidden="true" />
        </button>
      </footer>
      {openFailed ? <p className={styles.error}>{t('orchestra.scribe.openFailed')}</p> : null}
    </div>
  )
}
