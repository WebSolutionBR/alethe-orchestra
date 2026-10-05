import { FileText, FolderSearch, History, Play, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import { useT } from '../../../lib/i18n'
import { confirmStop, useOrchestraStore } from '../../../stores/orchestraStore'
import { showSession } from '../navigation'
import { useInterrupted } from './interrupted'
import { InterruptedRecord } from './InterruptedRecord'
import { type OrchestraManifest, sameFolder, summarizeManifest } from './manifest'
import styles from './Resume.module.css'
import { manifestName, useDateTime } from './useManifestInfo'

type RowProps = {
  manifest: OrchestraManifest
  /** Its folder is gone: it cannot be resumed until the user picks where it is now. */
  missing: boolean
  resuming: boolean
  busy: boolean
  onResume: () => void
  onChooseFolder: () => void
  onView: () => void
  onDiscard: () => void
}

function InterruptedRow({
  manifest,
  missing,
  resuming,
  busy,
  onResume,
  onChooseFolder,
  onView,
  onDiscard,
}: RowProps) {
  const t = useT()
  const formatDate = useDateTime()
  const summary = summarizeManifest(manifest)
  const counts = [
    summary.done === 1
      ? t('orchestra.resume.doneCountOne')
      : summary.done
        ? t('orchestra.resume.doneCount', { count: summary.done })
        : '',
    summary.failed ? t('orchestra.resume.failedCount', { count: summary.failed }) : '',
  ]
    .filter(Boolean)
    .join(', ')
  const workers =
    summary.workers === 1
      ? t('orchestra.resume.workersOne')
      : t('orchestra.resume.workersMany', { count: summary.workers })
  const goal = manifest.goal.replace(/\s+/g, ' ').trim()
  const meta = [
    manifestName(manifest),
    goal ? t('orchestra.resume.goal', { goal }) : t('orchestra.resume.noGoal'),
    t('orchestra.resume.saved', { when: formatDate(manifest.savedAt) }),
    counts ? `${workers} (${counts})` : workers,
  ].join(' · ')
  const where = [
    t('orchestra.resume.folder', { cwd: manifest.cwd ?? '—' }),
    manifest.autonomous
      ? t('orchestra.resume.modeAutonomous')
      : t('orchestra.resume.modeSupervised'),
  ].join(' · ')
  return (
    <div className={styles.row}>
      <History size={16} className={styles.icon} aria-hidden />
      <div className={styles.text}>
        <div className={styles.headline}>
          <strong>{t('orchestra.resume.title')}</strong>
          <span className={styles.meta} title={manifest.goal || undefined}>
            {meta}
          </span>
        </div>
        {missing ? (
          <div className={styles.warning} role="alert">
            <TriangleAlert size={12} aria-hidden />
            {t('orchestra.resume.folderMissing', { cwd: manifest.cwd ?? '—' })}
          </div>
        ) : (
          <div className={styles.why}>
            {t('orchestra.resume.why')} <span className={styles.where}>{where}</span>
          </div>
        )}
      </div>
      <div className={styles.actions}>
        {missing ? (
          <button
            type="button"
            className={styles.primary}
            onClick={onChooseFolder}
            disabled={busy}
            title={t('orchestra.resume.chooseFolderTitle')}
          >
            <FolderSearch size={13} aria-hidden />
            {resuming ? t('orchestra.resume.resuming') : t('orchestra.resume.chooseFolder')}
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            onClick={onResume}
            disabled={busy}
            title={t('orchestra.resume.resumeTitle')}
          >
            <Play size={13} aria-hidden />
            {resuming ? t('orchestra.resume.resuming') : t('orchestra.resume.resume')}
          </button>
        )}
        <button
          type="button"
          className={styles.button}
          onClick={onView}
          title={t('orchestra.resume.viewTitle')}
        >
          <FileText size={13} aria-hidden />
          {t('orchestra.resume.view')}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={onDiscard}
          disabled={busy}
          title={t('orchestra.resume.discardTitle')}
        >
          <Trash2 size={13} aria-hidden />
          {t('orchestra.resume.discard')}
        </button>
      </div>
    </div>
  )
}

/** A record the app cannot read: it can only be discarded. */
function DamagedRow({ id, onDiscard }: { id: string; onDiscard: () => void }) {
  const t = useT()
  return (
    <div className={styles.row}>
      <TriangleAlert size={16} className={styles.icon} aria-hidden />
      <div className={styles.text}>
        <div className={styles.headline}>
          <strong>{t('orchestra.resume.damagedTitle')}</strong>
        </div>
        <div className={styles.why}>{t('orchestra.resume.damagedWhy', { id })}</div>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={onDiscard}
          title={t('orchestra.resume.discardTitle')}
        >
          <Trash2 size={13} aria-hidden />
          {t('orchestra.resume.discard')}
        </button>
      </div>
    </div>
  )
}

/**
 * Strip over the Orchestra view for each orchestration the app was closed on: read its record,
 * resume it (every unfinished agent comes back in its own conversation) or discard it. It
 * resumes only in its own folder, or in one the user picks; never anywhere else by itself.
 */
export function InterruptedBanner() {
  const t = useT()
  const manifests = useInterrupted((s) => s.manifests)
  const damaged = useInterrupted((s) => s.damaged)
  const folders = useInterrupted((s) => s.folders)
  const [viewing, setViewing] = useState<string | null>(null)
  const [resuming, setResuming] = useState<string | null>(null)

  useEffect(() => {
    void useInterrupted.getState().load(Object.keys(useOrchestraStore.getState().sessions))
  }, [])

  /** Says what is about to happen when it is not the plain resume the button promises. */
  const confirmResume = (manifest: OrchestraManifest, cwd: string, moved: boolean) => {
    if (!moved && !manifest.autonomous) return Promise.resolve(true)
    const name = manifestName(manifest)
    const lines = [
      moved ? t('orchestra.resume.confirmMoved', { name, cwd }) : '',
      manifest.autonomous ? t('orchestra.resume.confirmAutonomous', { name, cwd }) : '',
    ].filter(Boolean)
    return confirmStop(lines.join('\n\n'), {
      title: manifest.autonomous
        ? t('orchestra.resume.confirmAutonomousTitle')
        : t('orchestra.resume.confirmTitle'),
      okLabel: t('orchestra.resume.resume'),
      cancelLabel: t('common.cancel'),
    })
  }

  /** Resumes in its own folder, or in `picked`; a folder that is gone is never replaced silently. */
  const resume = async (manifest: OrchestraManifest, picked?: string) => {
    if (resuming) return
    const interrupted = useInterrupted.getState()
    // The folder may have gone since the strip appeared.
    if (!picked && !(await interrupted.checkFolder(manifest.id))) return
    const cwd = picked ?? manifest.cwd ?? ''
    const moved = Boolean(picked) && !sameFolder(cwd, manifest.cwd)
    if (!(await confirmResume(manifest, cwd, moved))) return
    setResuming(manifest.id)
    const sessionId = await useOrchestraStore
      .getState()
      .resume(manifest, picked ? { cwd: picked } : undefined)
      .catch(() => null)
    setResuming(null)
    // On failure the strip stays; the store shows why on the start screen.
    if (!sessionId) return
    setViewing(null)
    interrupted.take(manifest.id)
    showSession(sessionId)
  }

  const chooseFolder = async (manifest: OrchestraManifest) => {
    if (resuming) return
    const picked = await pickDirectory().catch(() => null)
    if (picked) await resume(manifest, picked)
  }

  const discard = async (id: string, name: string) => {
    const ok = await confirmStop(t('orchestra.resume.confirmDiscard', { name }), {
      okLabel: t('orchestra.resume.discard'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return
    setViewing((shown) => (shown === id ? null : shown))
    await useInterrupted.getState().discard(id)
  }

  if (manifests.length === 0 && damaged.length === 0) return null
  const shown = manifests.find((m) => m.id === viewing) ?? null
  return (
    <section className={styles.strip} aria-label={t('orchestra.resume.region')}>
      {manifests.map((manifest) => (
        <InterruptedRow
          key={manifest.id}
          manifest={manifest}
          missing={folders[manifest.id] === false}
          resuming={resuming === manifest.id}
          busy={resuming !== null}
          onResume={() => void resume(manifest)}
          onChooseFolder={() => void chooseFolder(manifest)}
          onView={() => setViewing(manifest.id)}
          onDiscard={() => void discard(manifest.id, manifestName(manifest))}
        />
      ))}
      {damaged.map((id) => (
        <DamagedRow key={id} id={id} onDiscard={() => void discard(id, id)} />
      ))}
      {shown ? (
        <InterruptedRecord
          manifest={shown}
          missing={folders[shown.id] === false}
          resuming={resuming === shown.id}
          onResume={() => void resume(shown)}
          onChooseFolder={() => void chooseFolder(shown)}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </section>
  )
}
