/**
 * Long blocks: an agent blocked on something only the user can clear is announced again after
 * `thresholdMin`, even with its session on screen (a notice there is easy to miss under other
 * work), and then every `repeatMin` until it ends or the user silences it. Pure; the attention
 * service runs it on a timer.
 */
import type { AgentBlock, OrchestraSession } from '../../../stores/orchestraStore'
import type { EscalationPrefs } from './prefs'
import { needsYou } from './rules'
import { muteKey } from './store'

export type Escalation = {
  sessionId: string
  agentId: string
  block: AgentBlock
  /** Whole minutes blocked so far. */
  minutes: number
  /** The key the reminders of this block are counted (and silenced) by. */
  key: string
}

/**
 * Blocks due a reminder at `now`. `sent` holds when each block was last reminded of; it is
 * updated for the ones returned and pruned of blocks that ended.
 */
export function dueEscalations(
  sessions: Record<string, Pick<OrchestraSession, 'agents' | 'stoppedAt'>>,
  now: number,
  prefs: EscalationPrefs,
  sent: Map<string, number>,
  muted: Record<string, true>,
): Escalation[] {
  const due: Escalation[] = []
  const live = new Set<string>()
  const threshold = prefs.thresholdMin * 60_000
  const repeat = prefs.repeatMin * 60_000
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.stoppedAt) continue
    for (const agent of session.agents) {
      const block = agent.state === 'blocked' ? agent.blocked : null
      if (!block || !needsYou(agent)) continue
      const key = muteKey(sessionId, agent.id, block.at)
      live.add(key)
      if (muted[key] || now - block.at < threshold) continue
      const last = sent.get(key)
      if (last !== undefined && (repeat <= 0 || now - last < repeat)) continue
      sent.set(key, now)
      due.push({
        sessionId,
        agentId: agent.id,
        block,
        minutes: Math.floor((now - block.at) / 60_000),
        key,
      })
    }
  }
  for (const key of sent.keys()) if (!live.has(key)) sent.delete(key)
  return due
}
