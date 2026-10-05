import { useMemo, useState } from 'react'

import { saveFile } from '../../lib/dialog'
import { getLocale, intlLocale, useT } from '../../lib/i18n'
import { writeClipboardText } from '../../lib/tauri'
import { saveTextFile } from '../../lib/tauri/export'
import { useProjectsStore } from '../../stores/projectsStore'
import { Modal } from '../modals/Modal'
import {
  buildReport,
  formatDuration,
  reportJson,
  type ReportLabels,
  reportMarkdown,
} from './report'
import styles from './ReportDialog.module.css'
import { scribeSaveReport } from './scribe/service'
import { useSession, useSessionGetter, useSessionId } from './sessionContext'
import { describeExit } from './shared'

/** File names the exports are offered under, after the project and the session start. */
function exportName(project: string | null, startedAt: number, extension: string): string {
  const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const base = (project ?? 'orchestra').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'orchestra'
  return `${base} ${stamp}.${extension}`
}

/**
 * The orchestration report: goal, duration and, per worker, area, state, duration, files and
 * last note, with the failures. Copy it as Markdown, export it as .md or .json, or hand it to
 * the Obsidian scribe, which files it in the session's note.
 */
export function ReportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const sessionId = useSessionId()
  const getSession = useSessionGetter()
  const projectId = useSession((s) => s.projectId)
  const stoppedAt = useSession((s) => s.stoppedAt ?? null)
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.name ?? null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Built when the dialog opens (a snapshot while the session runs).
  const report = useMemo(
    () => (open ? buildReport(getSession(), { project }) : null),
    [open, getSession, project],
  )

  const markdown = useMemo(() => {
    if (!report) return ''
    const locale = intlLocale(getLocale())
    const labels: ReportLabels = {
      title: t('orchestra.report.title'),
      goal: t('orchestra.report.goal'),
      noGoal: t('orchestra.report.noGoal'),
      folder: t('orchestra.report.folder'),
      mode: t('orchestra.report.mode'),
      autonomous: t('orchestra.report.autonomous'),
      supervised: t('orchestra.report.supervised'),
      summary: t('orchestra.report.summary'),
      worker: t('orchestra.report.worker'),
      area: t('orchestra.report.area'),
      state: t('orchestra.report.state'),
      duration: t('orchestra.report.duration'),
      files: t('orchestra.report.files'),
      note: t('orchestra.report.note'),
      failures: t('orchestra.report.failures'),
      filesByWorker: t('orchestra.report.filesByWorker'),
      noWorkers: t('orchestra.report.noWorkers'),
      states: {
        done: t('orchestra.report.state.done'),
        failed: t('orchestra.report.state.failed'),
        stopped: t('orchestra.report.state.stopped'),
        blocked: t('orchestra.report.state.blocked'),
        waiting: t('orchestra.report.state.waiting'),
        working: t('orchestra.report.state.working'),
      },
      failure: (worker) => describeExit(t, worker),
    }
    const dateTime = new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    return reportMarkdown(report, labels, {
      dateTime: (ms) => dateTime.format(ms),
      time: (ms) => time.format(ms),
      duration: formatDuration,
    })
  }, [report, t])

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    try {
      const message = await action()
      if (message) setStatus(message)
    } catch (error) {
      setStatus(t('orchestra.report.failed', { message: String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const exportAs = (extension: 'md' | 'json') =>
    run(async () => {
      if (!report) return null
      const path = await saveFile({
        title: t('orchestra.report.dialogTitle'),
        defaultPath: exportName(report.project, report.startedAt, extension),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      })
      if (!path) return null
      await saveTextFile(path, extension === 'md' ? markdown : reportJson(report))
      return t('orchestra.controls.exported', { path })
    })

  const saveInObsidian = () =>
    run(async () => {
      setStatus(t('orchestra.report.saving'))
      const result = await scribeSaveReport({ sessionId, markdown })
      switch (result.status) {
        case 'written':
          return t('orchestra.report.obsidianWritten', { note: result.notePath ?? '' })
        case 'queued':
          return t('orchestra.report.obsidianQueued')
        case 'off':
          return t('orchestra.report.obsidianOff')
        default:
          return t('orchestra.report.obsidianFailed', { detail: result.detail ?? '' })
      }
    })

  return (
    <Modal
      open={open}
      onClose={() => {
        setStatus(null)
        onClose()
      }}
      title={t('orchestra.report.dialogTitle')}
      width={760}
      footer={
        <div className={styles.footer}>
          <span className={styles.status} role="status">
            {status}
          </span>
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await writeClipboardText(markdown)
                return t('orchestra.report.copied')
              })
            }
          >
            {t('orchestra.report.copy')}
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => void exportAs('md')}
          >
            {t('orchestra.report.exportMd')}
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => void exportAs('json')}
          >
            {t('orchestra.report.exportJson')}
          </button>
          <button
            type="button"
            className={`${styles.action} ${styles.primary}`}
            disabled={busy}
            onClick={() => void saveInObsidian()}
          >
            {t('orchestra.report.saveObsidian')}
          </button>
        </div>
      }
    >
      {stoppedAt === null ? (
        <p className={styles.snapshot}>{t('orchestra.report.snapshot')}</p>
      ) : null}
      <pre className={styles.preview} tabIndex={0}>
        {markdown}
      </pre>
    </Modal>
  )
}
