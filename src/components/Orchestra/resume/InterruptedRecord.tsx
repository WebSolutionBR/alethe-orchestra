import { FolderSearch, Play, TriangleAlert } from 'lucide-react'

import { type MessageKey, useT } from '../../../lib/i18n'
import type { OrchestraAgent } from '../../../stores/orchestraStore'
import { Modal } from '../../modals/Modal'
import { stateColor } from '../shared'
import { type AgentFate, agentFate, type OrchestraManifest } from './manifest'
import styles from './Resume.module.css'
import { manifestName, useDateTime } from './useManifestInfo'

const RECENT_LINES = 8

const FATE_KEY: Record<Exclude<AgentFate, 'wait'>, MessageKey> = {
  resume: 'orchestra.resume.record.willResume',
  restart: 'orchestra.resume.record.willRestart',
  failed: 'orchestra.resume.record.willFail',
  finished: 'orchestra.resume.record.finished',
}

function AgentRecord({ agent }: { agent: OrchestraAgent }) {
  const t = useT()
  const fate = agentFate(agent)
  const fateText =
    fate === 'wait'
      ? t('orchestra.resume.record.willWait', { deps: agent.after.join(', ') || '—' })
      : t(FATE_KEY[fate])
  const settings = [agent.model, agent.effort].filter(Boolean).join(' · ')
  const lines = agent.lines.slice(-RECENT_LINES)
  return (
    <li className={styles.agent}>
      <div className={styles.agentHead}>
        <span className={styles.dot} style={{ background: stateColor(agent.state) }} aria-hidden />
        <strong>{agent.id}</strong>
        {agent.area && agent.area !== agent.id ? (
          <span className={styles.area}>{agent.area}</span>
        ) : null}
        <span className={styles.state}>
          {t(`orchestra.state.${agent.state}` as MessageKey)} · {agent.progress}%
          {settings ? ` · ${settings}` : ''}
        </span>
        <span className={styles.fate}>{fateText}</span>
      </div>
      {agent.note ? <p className={styles.note}>{agent.note}</p> : null}
      {agent.task ? (
        <details className={styles.details}>
          <summary>{t('orchestra.resume.record.task')}</summary>
          <pre className={styles.pre}>{agent.task}</pre>
        </details>
      ) : null}
      {agent.history.length > 0 ? (
        <details className={styles.details}>
          <summary>{t('orchestra.resume.record.history', { count: agent.history.length })}</summary>
          <ul className={styles.lines}>
            {agent.history.map((record, index) => (
              <li key={index}>
                {record.progress}% · {record.task}
                {record.note ? ` — ${record.note}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {lines.length > 0 ? (
        <details className={styles.details}>
          <summary>{t('orchestra.resume.record.activity')}</summary>
          <ul className={styles.lines}>
            {lines.map((line, index) => (
              <li key={index}>{line.text}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {agent.files.length > 0 ? (
        <details className={styles.details}>
          <summary>{t('orchestra.resume.record.files', { count: agent.files.length })}</summary>
          <ul className={styles.lines}>
            {agent.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  )
}

/** What an interrupted orchestration left behind, read-only: nothing runs from here. */
export function InterruptedRecord({
  manifest,
  missing,
  resuming,
  onResume,
  onChooseFolder,
  onClose,
}: {
  manifest: OrchestraManifest
  /** Its folder is gone: resuming waits for the user to pick where it is now. */
  missing: boolean
  resuming: boolean
  onResume: () => void
  onChooseFolder: () => void
  onClose: () => void
}) {
  const t = useT()
  const formatDate = useDateTime()
  const name = manifestName(manifest)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('orchestra.resume.record.title', { name })}
      width={760}
      footer={
        <div className={styles.footer}>
          <button type="button" className={styles.button} onClick={onClose}>
            {t('orchestra.resume.record.close')}
          </button>
          {missing ? (
            <button
              type="button"
              className={styles.primary}
              onClick={onChooseFolder}
              disabled={resuming}
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
              disabled={resuming}
              title={t('orchestra.resume.resumeTitle')}
            >
              <Play size={13} aria-hidden />
              {resuming ? t('orchestra.resume.resuming') : t('orchestra.resume.resume')}
            </button>
          )}
        </div>
      }
    >
      <div className={styles.record}>
        <p className={styles.readOnly}>{t('orchestra.resume.record.readOnly')}</p>
        {missing ? (
          <p className={styles.warning}>
            <TriangleAlert size={12} aria-hidden />
            {t('orchestra.resume.folderMissing', { cwd: manifest.cwd ?? '—' })}
          </p>
        ) : null}
        <dl className={styles.facts}>
          <dt>{t('orchestra.resume.record.folder')}</dt>
          <dd>{manifest.cwd ?? '—'}</dd>
          <dt>{t('orchestra.resume.record.started')}</dt>
          <dd>{formatDate(manifest.startedAt)}</dd>
          <dt>{t('orchestra.resume.record.saved')}</dt>
          <dd>{formatDate(manifest.savedAt)}</dd>
          <dt>{t('orchestra.resume.record.permissions')}</dt>
          <dd>
            {manifest.autonomous
              ? t('orchestra.resume.record.autonomous')
              : t('orchestra.resume.record.supervised')}
          </dd>
        </dl>
        <section>
          <h3 className={styles.sectionTitle}>{t('orchestra.resume.record.goal')}</h3>
          <pre className={styles.goal}>{manifest.goal || t('orchestra.resume.noGoal')}</pre>
        </section>
        <section>
          <h3 className={styles.sectionTitle}>{t('orchestra.resume.record.agents')}</h3>
          <ul className={styles.agents}>
            {manifest.agents.map((agent) => (
              <AgentRecord key={agent.id} agent={agent} />
            ))}
          </ul>
        </section>
        <section>
          <h3 className={styles.sectionTitle}>{t('orchestra.resume.record.messages')}</h3>
          {manifest.messages.length === 0 ? (
            <p className={styles.empty}>{t('orchestra.resume.record.noMessages')}</p>
          ) : (
            <ol className={styles.messages}>
              {manifest.messages.map((message) => (
                <li key={message.id}>
                  <time>{formatDate(message.at, true)}</time>{' '}
                  <span className={styles.route}>
                    {message.from} → {message.to}
                  </span>{' '}
                  <span className={styles.messageText}>{message.text}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Modal>
  )
}
