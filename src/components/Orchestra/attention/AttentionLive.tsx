import css from './Attention.module.css'
import { useAttentionStore } from './store'

/**
 * Visually hidden live region of one session: screen readers hear each attention notice of that
 * session (blocked, stopped, all done, orchestrator waiting) while it is on screen.
 */
export function AttentionLive({ sessionId }: { sessionId: string }) {
  const text = useAttentionStore((s) => s.last[sessionId]?.text ?? '')
  return (
    <div className={css.live} role="status" aria-live="polite">
      {text}
    </div>
  )
}
