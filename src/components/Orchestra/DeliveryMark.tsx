import { type MessageKey, useT } from '../../lib/i18n'
import { type BusMessage, useOrchestraStore } from '../../stores/orchestraStore'
import styles from './DeliveryMark.module.css'
import { useSession, useSessionId } from './sessionContext'

const GLYPH = { queued: '◌', pending: '…', delivered: '✓', failed: '✕' } as const

/**
 * Where a bus message routed to a terminal stands: queued for an agent that has not started,
 * sent and not read yet, delivered, or not delivered with the reason and a way to send it again
 * on the same line. Nothing for notices and scribe lines, which are not routed.
 */
export function DeliveryMark({
  message,
  compact = false,
  actionable = true,
}: {
  message: BusMessage
  /** Glyph only, the label for screen readers and the tooltip. */
  compact?: boolean
  /** False inside another control (a ticker button): no Resend button of its own. */
  actionable?: boolean
}) {
  const t = useT()
  const sessionId = useSessionId()
  // A stopped orchestration has no terminal left to resend to.
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const status = message.delivery
  if (!status) return null
  const label =
    status === 'failed'
      ? t(`orchestra.delivery.failed.${message.failure ?? 'write'}` as MessageKey)
      : t(`orchestra.delivery.${status}` as MessageKey)
  return (
    <span className={styles.mark} data-status={status}>
      <span className={styles.glyph} aria-hidden="true" title={compact ? label : undefined}>
        {GLYPH[status]}
      </span>
      {compact ? <span className={styles.srOnly}>{label}</span> : <span>{label}</span>}
      {status === 'failed' && actionable && !stopped ? (
        <button
          type="button"
          className={styles.resend}
          title={t('orchestra.delivery.resendTitle')}
          onClick={(event) => {
            event.stopPropagation()
            void useOrchestraStore.getState().resend(sessionId, message.id)
          }}
        >
          {t('orchestra.delivery.resend')}
        </button>
      ) : null}
    </span>
  )
}
