import { CornerUpLeft, Download, History, OctagonX, RotateCcw } from 'lucide-react'
import type { MouseEvent } from 'react'

import { saveFile } from '../../lib/dialog'
import { getLocale, translate, useT } from '../../lib/i18n'
import { saveTextFile } from '../../lib/tauri/export'
import { getMirror } from '../../lib/terminalMirror'
import { confirmStop, type OrchestraAgent, useOrchestraStore } from '../../stores/orchestraStore'
import { useUiStore } from '../../stores/uiStore'
import { useRetiredPtys, useViewedRetired, viewRetired } from './retiredTerminals'
import { useSession, useSessionId } from './sessionContext'
import { isBusy, isFailed, processEnded } from './shared'
import { useHasTranscript } from './terminalHooks'

/** Header clicks focus or maximize the terminal; these buttons keep theirs. */
const stop = (event: MouseEvent) => event.stopPropagation()

/** File name an exported transcript is offered under. */
const transcriptName = (agentId: string) =>
  `${agentId}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`

/**
 * Icon buttons for one agent, meant for a header next to its terminal (they never change the
 * terminal's size): interrupt it (Esc), resume it in its own conversation (`claude --resume`,
 * when Claude Code told us its id), restart it from its task, and export its whole transcript.
 * A stopped orchestration only exports.
 */
export function AgentControls({
  agent,
  buttonClassName,
}: {
  agent: OrchestraAgent
  buttonClassName?: string
}) {
  const t = useT()
  const sessionId = useSessionId()
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const hasTranscript = useHasTranscript(agent.ptyId)
  // Terminals it had before a Restart: their transcripts stay until the session is closed.
  const earlier = useRetiredPtys(sessionId, agent.id)
  const viewed = useViewedRetired(sessionId, agent.id)
  const store = useOrchestraStore.getState

  // A running process: not failed, and not ended after reporting done.
  const live = Boolean(agent.ptyId) && !processEnded(agent)
  const canRestart = !stopped && (live || isFailed(agent))
  const canResume = canRestart && Boolean(agent.claudeSessionId)
  const canInterrupt = !stopped && live && isBusy(agent.state)

  const restart = async (resume: boolean) => {
    if (live) {
      const ok = await confirmStop(t('orchestra.controls.confirmRestart', { id: agent.id }), {
        title: t('orchestra.controls.confirmRestartTitle', { id: agent.id }),
        okLabel: resume ? t('orchestra.controls.resume') : t('orchestra.controls.restart'),
        cancelLabel: t('common.cancel'),
      })
      if (!ok) return
    }
    const notice = resume
      ? t('orchestra.controls.resumeNotice', { id: agent.id })
      : t('orchestra.controls.restartNotice', { id: agent.id })
    void store().restartAgent(sessionId, agent.id, { resume, notice })
  }

  // Steps back through the earlier terminals, newest first, then returns to the current one.
  const showEarlier = () => {
    const at = viewed ? earlier.indexOf(viewed) : earlier.length
    viewRetired(sessionId, agent.id, at > 0 ? earlier[at - 1] : null)
  }
  const earlierIndex = viewed ? earlier.indexOf(viewed) + 1 : 0

  const exportTranscript = async () => {
    // The transcript on screen: an earlier terminal while one is shown, else the current one.
    const shown = viewed ?? agent.ptyId
    const mirror = shown ? getMirror(shown) : null
    if (!mirror) return
    const toast = useUiStore.getState().pushToast
    const locale = getLocale()
    try {
      const path = await saveFile({
        title: t('orchestra.controls.exportTitle', { id: agent.id }),
        defaultPath: transcriptName(agent.id),
        filters: [{ name: 'Text', extensions: ['txt'] }],
      })
      if (!path) return
      await saveTextFile(path, `${mirror.getText(0, mirror.length)}\n`)
      toast({
        title: translate(locale, 'orchestra.controls.export'),
        body: translate(locale, 'orchestra.controls.exported', { path }),
      })
    } catch (error) {
      toast({
        title: translate(locale, 'orchestra.controls.export'),
        body: translate(locale, 'orchestra.controls.exportFailed', { message: String(error) }),
      })
    }
  }

  return (
    <>
      {canInterrupt ? (
        <button
          type="button"
          className={buttonClassName}
          aria-label={t('orchestra.controls.interrupt')}
          title={t('orchestra.controls.interruptTitle', { id: agent.id })}
          onClick={(event) => {
            event.stopPropagation()
            void store().interruptAgent(
              sessionId,
              agent.id,
              t('orchestra.controls.interruptNotice'),
            )
          }}
          onDoubleClick={stop}
        >
          <OctagonX size={13} aria-hidden="true" />
        </button>
      ) : null}
      {canResume ? (
        <button
          type="button"
          className={buttonClassName}
          aria-label={t('orchestra.controls.resume')}
          title={t('orchestra.controls.resumeTitle', { id: agent.id })}
          onClick={(event) => {
            event.stopPropagation()
            void restart(true)
          }}
          onDoubleClick={stop}
        >
          <CornerUpLeft size={13} aria-hidden="true" />
        </button>
      ) : null}
      {canRestart ? (
        <button
          type="button"
          className={buttonClassName}
          aria-label={t('orchestra.controls.restart')}
          title={t('orchestra.controls.restartTitle', { id: agent.id })}
          onClick={(event) => {
            event.stopPropagation()
            void restart(false)
          }}
          onDoubleClick={stop}
        >
          <RotateCcw size={13} aria-hidden="true" />
        </button>
      ) : null}
      {earlier.length > 0 && agent.ptyId ? (
        <button
          type="button"
          className={buttonClassName}
          aria-pressed={viewed !== null}
          aria-label={
            viewed
              ? t('orchestra.controls.earlierShown', {
                  index: earlierIndex,
                  total: earlier.length,
                })
              : t('orchestra.controls.earlier')
          }
          title={
            viewed
              ? earlierIndex > 1
                ? t('orchestra.controls.earlierOlderTitle', { id: agent.id })
                : t('orchestra.controls.earlierBackTitle', { id: agent.id })
              : t('orchestra.controls.earlierTitle', { id: agent.id, count: earlier.length })
          }
          data-retired-index={viewed ? earlierIndex : undefined}
          onClick={(event) => {
            event.stopPropagation()
            showEarlier()
          }}
          onDoubleClick={stop}
        >
          <History size={13} aria-hidden="true" />
        </button>
      ) : null}
      {hasTranscript || viewed ? (
        <button
          type="button"
          className={buttonClassName}
          aria-label={t('orchestra.controls.export')}
          title={t('orchestra.controls.exportTitle', { id: agent.id })}
          onClick={(event) => {
            event.stopPropagation()
            void exportTranscript()
          }}
          onDoubleClick={stop}
        >
          <Download size={13} aria-hidden="true" />
        </button>
      ) : null}
    </>
  )
}
