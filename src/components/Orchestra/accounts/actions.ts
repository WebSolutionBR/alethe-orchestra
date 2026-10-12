import type { useT } from '../../../lib/i18n'
import { confirmStop, type OrchestraAgent, useOrchestraStore } from '../../../stores/orchestraStore'
import { moveOutcome } from '../usage/launch'
import { sessionLaunchOf } from '../usage/launchDefaults'

type Translate = ReturnType<typeof useT>

/** Which confirmation text a restart on `target` needs: carried, started over, or both. */
export function restartPlan(
  agents: OrchestraAgent[],
  target: string | null,
): { carry: string[]; fresh: string[] } {
  const carry: string[] = []
  const fresh: string[] = []
  for (const agent of agents) {
    const outcome = moveOutcome(agent, target)
    if (outcome === 'carry') carry.push(agent.id)
    else if (outcome === 'fresh') fresh.push(agent.id)
  }
  return { carry, fresh }
}

/**
 * Asks, then restarts these agents on the session's account. Restarting interrupts their work,
 * so it only ever happens after the user confirms; the dialog says whether each one continues
 * its conversation or starts its task over. Resolves to whether it went ahead.
 */
export async function askRestartOnSessionAccount(
  sessionId: string,
  agents: OrchestraAgent[],
  targetName: string,
  t: Translate,
): Promise<boolean> {
  const store = useOrchestraStore.getState()
  const session = store.sessions[sessionId]
  if (!session || session.stoppedAt || agents.length === 0) return false
  const target = sessionLaunchOf(session).account
  const { carry, fresh } = restartPlan(agents, target)
  if (carry.length + fresh.length === 0) return false
  const names = [...carry, ...fresh].join(', ')
  const body =
    carry.length && fresh.length
      ? t('orchestra.accounts.confirmMixed', {
          agents: names,
          carry: carry.join(', '),
          fresh: fresh.join(', '),
          name: targetName,
        })
      : carry.length
        ? t('orchestra.accounts.confirmCarry', { agents: names, name: targetName })
        : t('orchestra.accounts.confirmFresh', { agents: names, name: targetName })
  const ok = await confirmStop(body, {
    title: t('orchestra.accounts.confirmTitle', { name: targetName }),
    okLabel: t('orchestra.accounts.confirmOk'),
    cancelLabel: t('common.cancel'),
  })
  if (!ok) return false
  // One after the other: each restart copies a conversation and starts a process.
  for (const id of [...carry, ...fresh]) {
    await useOrchestraStore.getState().restartAgent(sessionId, id, {
      moveAccount: true,
      notice: t('orchestra.accounts.restartNotice', { id, name: targetName }),
    })
  }
  return true
}
