import { useEffect, useState } from 'react'

import { getLocale, intlLocale, useT } from '../../lib/i18n'
import { getMirror } from '../../lib/terminalMirror'
import { type OrchestraAgent, useOrchestraStore } from '../../stores/orchestraStore'
import styles from './AgentAlert.module.css'
import { dialogOnScreen, type DialogOption, type ScreenDialog } from './dialog'
import { useSession, useSessionId } from './sessionContext'
import { blockDescription, exitDescription, isFailed } from './shared'

type AgentAlertProps = {
  agent: OrchestraAgent
  /**
   * Reported itself blocked, so it waits for a message: write it (composer, the drawer's box).
   * Never offered for a dialog, which takes keys, not text.
   */
  onReply?: () => void
  /** Show the agent's terminal (selects it). */
  onOpenTerminal?: () => void
  /** One-line text, for cards. */
  compact?: boolean
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(intlLocale(getLocale()), { hour: '2-digit', minute: '2-digit' })

/**
 * Why an agent needs the user, wherever it is shown: how a failed agent ended (with its last
 * note), the real question or permission a blocked agent waits on, or the dependency that fell,
 * with the only ways out of that (start anyway, cancel). Nothing for a healthy agent.
 */
export function AgentAlert({ agent, onReply, onOpenTerminal, compact = false }: AgentAlertProps) {
  const t = useT()
  const sessionId = useSessionId()
  // A stopped orchestration is read-only: it explains, it offers nothing to do.
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const className = compact ? `${styles.alert} ${styles.compact}` : styles.alert
  const store = useOrchestraStore.getState

  if (isFailed(agent)) {
    const exit = exitDescription(agent)
    const restart = (resume: boolean) =>
      void store().restartAgent(sessionId, agent.id, {
        resume,
        notice: resume
          ? t('orchestra.controls.resumeNotice', { id: agent.id })
          : t('orchestra.controls.restartNotice', { id: agent.id }),
      })
    return (
      <div className={className} data-kind="failed" role="status">
        <div className={styles.head}>
          <span className={styles.tag}>✕ {t('orchestra.agents.failed')}</span>
          <span>{t(exit.key, exit.params)}</span>
          {agent.finishedAt ? (
            <span className={styles.faint}>
              {t('orchestra.agents.exitAt', { time: clock(agent.finishedAt) })}
            </span>
          ) : null}
        </div>
        {agent.note ? (
          <p className={styles.text} title={agent.note}>
            {t('orchestra.agents.lastNote', { note: agent.note })}
          </p>
        ) : null}
        {stopped ? null : (
          <div className={styles.actions}>
            {agent.claudeSessionId ? (
              <button
                type="button"
                className={`${styles.action} ${styles.primary}`}
                title={t('orchestra.controls.resumeTitle', { id: agent.id })}
                onClick={(e) => {
                  e.stopPropagation()
                  restart(true)
                }}
              >
                {t('orchestra.controls.resume')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.action}
              title={t('orchestra.controls.restartTitle', { id: agent.id })}
              onClick={(e) => {
                e.stopPropagation()
                restart(false)
              }}
            >
              {t('orchestra.controls.restart')}
            </button>
            {onOpenTerminal ? (
              <button
                type="button"
                className={styles.action}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenTerminal()
                }}
              >
                {t('orchestra.agents.openTerminal')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  const block = agent.state === 'blocked' ? blockDescription(agent) : null
  if (!block || !agent.blocked) return null

  if (agent.blocked.reason === 'dependency') {
    const deps = agent.blocked.text
    return (
      <div className={className} data-kind="dependency" role="status">
        <div className={styles.head}>
          <span className={styles.tag}>!</span>
          <span>{t(block.key, block.params)}</span>
        </div>
        {stopped ? null : (
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.action} ${styles.primary}`}
              title={t('orchestra.agents.startNowTitle', { id: agent.id, deps })}
              onClick={(e) => {
                e.stopPropagation()
                store().startNow(
                  sessionId,
                  agent.id,
                  t('orchestra.agents.startNowNotice', { id: agent.id, deps }),
                )
              }}
            >
              {t('orchestra.agents.startNow')}
            </button>
            <button
              type="button"
              className={styles.action}
              title={t('orchestra.agents.cancelTitle', { id: agent.id })}
              onClick={(e) => {
                e.stopPropagation()
                store().cancelWaiting(
                  sessionId,
                  agent.id,
                  t('orchestra.agents.cancelNotice', { id: agent.id, deps }),
                )
              }}
            >
              {t('orchestra.agents.cancel')}
            </button>
          </div>
        )}
      </div>
    )
  }

  const asked = agent.blocked.text.trim()
  const reason = agent.blocked.reason
  return (
    <div className={className} data-kind="blocked" role="status">
      <div className={styles.head}>
        <span className={styles.tag}>! {t(block.key, block.params)}</span>
      </div>
      <p className={styles.text} title={asked || undefined}>
        {asked || t('orchestra.agents.blocked.noText')}
      </p>
      {stopped ? null : reason === 'permission' || reason === 'question' ? (
        <DialogChoices
          agent={agent}
          permission={reason === 'permission'}
          onOpenTerminal={onOpenTerminal}
        />
      ) : onReply || onOpenTerminal ? (
        <div className={styles.actions}>
          {onReply ? (
            <button
              type="button"
              className={`${styles.action} ${styles.primary}`}
              title={t('orchestra.agents.replyTitle', { id: agent.id })}
              onClick={(e) => {
                e.stopPropagation()
                onReply()
              }}
            >
              {t('orchestra.agents.reply')}
            </button>
          ) : null}
          {onOpenTerminal ? (
            <button
              type="button"
              className={styles.action}
              onClick={(e) => {
                e.stopPropagation()
                onOpenTerminal()
              }}
            >
              {t('orchestra.agents.openTerminal')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The dialog on a terminal's screen, followed as the screen changes. */
function useScreenDialog(ptyId: string | null): ScreenDialog | null {
  const [dialog, setDialog] = useState<ScreenDialog | null>(() => dialogOnScreen(ptyId))
  useEffect(() => {
    const read = () => {
      const next = dialogOnScreen(ptyId)
      setDialog((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    }
    read()
    if (!ptyId) return
    let stop: (() => void) | undefined
    try {
      stop = getMirror(ptyId)?.onChange(read)
    } catch {
      stop = undefined
    }
    return () => stop?.()
  }, [ptyId])
  return dialog
}

/**
 * A dialog has the agent's terminal: it takes keys, never text. A permission request on screen
 * gets one button per option, each sending that option's keys; otherwise (a question, or a
 * request the screen does not show as expected) only the way to its terminal.
 */
function DialogChoices({
  agent,
  permission,
  onOpenTerminal,
}: {
  agent: OrchestraAgent
  permission: boolean
  onOpenTerminal?: () => void
}) {
  const t = useT()
  const sessionId = useSessionId()
  const screen = useScreenDialog(permission ? agent.ptyId : null)
  const [busy, setBusy] = useState(false)
  const request = screen?.permission ? screen : null

  const label = (option: DialogOption) =>
    option.deny
      ? t('orchestra.agents.dialog.deny')
      : option.label.trim().toLowerCase() === 'yes'
        ? t('orchestra.agents.dialog.allowOnce')
        : `${option.index}. ${option.label}`

  const choose = (option: DialogOption) => {
    setBusy(true)
    void useOrchestraStore
      .getState()
      .answerDialog(
        sessionId,
        agent.id,
        option,
        t('orchestra.agents.dialog.answered', { option: `${option.index}. ${option.label}` }),
      )
      .then((answered) => {
        // Gone or changed meanwhile: nothing was answered, the terminal shows what it is now.
        if (!answered) onOpenTerminal?.()
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      {request ? null : <p className={styles.faint}>{t('orchestra.agents.dialog.inTerminal')}</p>}
      {request || onOpenTerminal ? (
        <div className={styles.actions}>
          {request?.options.map((option) => (
            <button
              key={option.index}
              type="button"
              className={`${styles.action} ${styles.choice}`}
              disabled={busy}
              title={t('orchestra.agents.dialog.optionTitle', {
                index: option.index,
                label: option.label,
              })}
              onClick={(e) => {
                e.stopPropagation()
                choose(option)
              }}
            >
              {label(option)}
            </button>
          ))}
          {onOpenTerminal ? (
            <button
              type="button"
              className={styles.action}
              onClick={(e) => {
                e.stopPropagation()
                onOpenTerminal()
              }}
            >
              {t('orchestra.agents.openTerminal')}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
