import { useT } from '../../../lib/i18n'
import { useOrchestraStore } from '../../../stores/orchestraStore'
import { needsYou } from './rules'
import { useAttentionStore } from './store'

/** Agents waiting on the user across every orchestration, plus idle orchestrators waiting. */
export function useAttentionCount(): number {
  const agents = useOrchestraStore((s) => {
    let count = 0
    for (const session of Object.values(s.sessions)) {
      // A stopped session is read-only: nothing in it can still be answered or restarted.
      if (session.stoppedAt) continue
      for (const agent of session.agents) if (needsYou(agent)) count += 1
    }
    return count
  })
  // Joined so the selector returns a value, not a fresh array per store update.
  const stopped = useOrchestraStore((s) =>
    Object.values(s.sessions)
      .filter((session) => session.stoppedAt)
      .map((session) => session.id)
      .join(' '),
  )
  const waiting = useAttentionStore(
    (s) => Object.keys(s.waiting).filter((id) => !stopped.split(' ').includes(id)).length,
  )
  return agents + waiting
}

/** `label` plus how many things wait on the user, for the Orchestra button's accessible name. */
export function useAttentionLabel(label: string): string {
  const t = useT()
  const count = useAttentionCount()
  return count > 0 ? `${label} · ${t('orchestra.attention.badge', { count })}` : label
}
