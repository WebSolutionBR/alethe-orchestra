/**
 * Ending an orchestration asks the same question wherever it starts: the top bar, the tab's ✕,
 * a middle click or Delete on the tab. Stop ends the agents and keeps the session readable;
 * Close forgets a session that was already stopped. A running session is never removed in one
 * step.
 */
import { getLocale, intlLocale, type useT } from '../../lib/i18n'
import { confirmStop, useOrchestraStore } from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { stopSession } from './navigation'
import { folderName } from './sessionLayout'

type Translate = ReturnType<typeof useT>

/** Hours and minutes in the app's language. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(intlLocale(getLocale()), {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** What a session is called in its tab and its dialogs: its project, else its folder. */
export function sessionName(sessionId: string, t: Translate): string {
  const session = useOrchestraStore.getState().sessions[sessionId]
  const project = useProjectsStore.getState().projects.find((p) => p.id === session?.projectId)
  return project?.name || folderName(session?.cwd ?? null) || t('orchestra.sessions.untitled')
}

/** Asks, then stops every agent of a running session; it stays open, read-only. */
export async function askStopAgents(sessionId: string, t: Translate): Promise<boolean> {
  const session = useOrchestraStore.getState().sessions[sessionId]
  if (!session || session.stoppedAt) return false
  const ok = await confirmStop(
    t('orchestra.session.stopBody', {
      goal: session.goal || t('orchestra.noGoal'),
      time: clockTime(session.startedAt),
    }),
    {
      title: t('orchestra.session.stopTitle', { name: sessionName(sessionId, t) }),
      okLabel: t('orchestra.session.stopOk'),
      cancelLabel: t('common.cancel'),
    },
  )
  if (!ok) return false
  await useOrchestraStore.getState().stopAgents(sessionId)
  return true
}

/** Asks, then forgets a stopped session together with its report and transcripts. */
export async function askCloseSession(sessionId: string, t: Translate): Promise<boolean> {
  if (!useOrchestraStore.getState().sessions[sessionId]?.stoppedAt) return false
  const ok = await confirmStop(t('orchestra.session.closeBody'), {
    title: t('orchestra.session.closeAsk', { name: sessionName(sessionId, t) }),
    okLabel: t('orchestra.session.closeOk'),
    cancelLabel: t('common.cancel'),
  })
  if (!ok) return false
  await stopSession(sessionId)
  return true
}

/** The tab's ✕, middle click and Delete: stop a running session, close a stopped one. */
export function askEndSession(sessionId: string, t: Translate): Promise<boolean> {
  return useOrchestraStore.getState().sessions[sessionId]?.stoppedAt
    ? askCloseSession(sessionId, t)
    : askStopAgents(sessionId, t)
}
