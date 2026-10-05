import { FileText, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'

import { intlLocale, type MessageKey, useT } from '../../../lib/i18n'
import { openInBrowser } from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useScribeConfig } from './config'
import { CONTEXT_BUDGET_MS, type ContextNote } from './context'
import { useSessionContext } from './contextStore'
import { obsidianOpenUri } from './identity'
import styles from './ScribeChip.module.css'

/**
 * The scribe panel's account of the Obsidian consultation made before the session's
 * orchestrator started: the notes it read (each opens in Obsidian), when, and why it could
 * not consult when it failed.
 */
export function ScribeContextSection({ sessionId }: { sessionId: string }) {
  const t = useT()
  const context = useSessionContext(sessionId)
  const vaultPath = useScribeConfig((s) => s.vaultPath)
  const locale = useProjectsStore((s) => s.preferences.language)
  const clock = useMemo(
    () => new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )
  if (!context) return null

  const time = clock.format(context.at)
  const seconds = Math.round(CONTEXT_BUDGET_MS / 1000)
  const file = context.file
  const openNote = (note: ContextNote) => {
    const uri = obsidianOpenUri(vaultPath, note.path)
    if (uri) void openInBrowser(uri).catch(() => {})
  }

  let summary: string
  switch (context.status) {
    case 'pending':
      summary = t('orchestra.scribe.context.pending')
      break
    case 'off':
      summary = t('orchestra.scribe.context.off')
      break
    case 'failed':
      summary = ''
      break
    default:
      summary =
        context.notes.length === 0
          ? t('orchestra.scribe.context.none', { time })
          : context.notes.length === 1
            ? t('orchestra.scribe.context.readyOne', { time })
            : t('orchestra.scribe.context.ready', { count: context.notes.length, time })
  }

  return (
    <section
      className={styles.context}
      data-status={context.status}
      aria-label={t('orchestra.scribe.context.title')}
    >
      <header className={styles.contextHead}>
        <span>{t('orchestra.scribe.context.title')}</span>
        {file ? (
          <button
            type="button"
            className={styles.linkBtn}
            title={file}
            onClick={() => void openInBrowser(file).catch(() => {})}
          >
            {t('orchestra.scribe.context.openFile')}
          </button>
        ) : null}
      </header>
      {context.status === 'failed' ? (
        <p className={styles.contextWarn} role="status" title={context.detail ?? undefined}>
          <TriangleAlert size={13} aria-hidden="true" />
          <span>
            {t('orchestra.scribe.context.failed', {
              reason: t(
                `orchestra.scribe.context.failure.${context.failure ?? 'unreachable'}` as MessageKey,
                { seconds },
              ),
            })}
          </span>
        </p>
      ) : (
        <p className={styles.contextNote}>{summary}</p>
      )}
      {context.notes.length > 0 ? (
        <ul className={styles.contextList}>
          {context.notes.map((note) => (
            <li key={note.path}>
              <button
                type="button"
                className={styles.contextItem}
                title={note.path}
                aria-label={t('orchestra.scribe.context.open', { note: note.title })}
                disabled={!vaultPath.trim()}
                onClick={() => openNote(note)}
              >
                <FileText size={12} aria-hidden="true" />
                <span className={styles.contextTitle}>{note.title}</span>
                {note.kind === 'search' ? null : (
                  <span className={styles.contextKind}>
                    {t(`orchestra.scribe.context.kind.${note.kind}` as MessageKey)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
