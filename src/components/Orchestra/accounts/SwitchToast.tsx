import { X } from 'lucide-react'
import { useEffect } from 'react'

import { useT } from '../../../lib/i18n'
import { useSessionId } from '../sessionContext'
import styles from './Accounts.module.css'
import { useAccountName } from './hooks'
import { undoAccountSwitch, useAccountSwitchUndo } from './switchAccount'

/**
 * "Session account: A → B [Undo]" for UNDO_SWITCH_MS after "Use in this session". Undo goes
 * back to the account the session had before; it is the session's own switch, so it is shown
 * over that session's body only.
 */
export function AccountSwitchToast() {
  const t = useT()
  const sessionId = useSessionId()
  const nameOf = useAccountName()
  const undo = useAccountSwitchUndo((s) => s.bySession[sessionId])
  const clear = useAccountSwitchUndo((s) => s.clear)
  const pause = useAccountSwitchUndo((s) => s.pause)
  const resume = useAccountSwitchUndo((s) => s.resume)

  useEffect(() => {
    // Paused while the pointer or the focus is on it: reading it or reaching Undo takes time.
    if (!undo || undo.paused != null) return
    const timer = window.setTimeout(() => clear(sessionId), Math.max(0, undo.until - Date.now()))
    return () => window.clearTimeout(timer)
  }, [undo, clear, sessionId])

  if (!undo) return null
  return (
    <div
      className={styles.toast}
      role="status"
      onMouseEnter={() => pause(sessionId)}
      onMouseLeave={(e) => {
        // Still focused inside: the focus keeps it paused.
        if (!e.currentTarget.contains(document.activeElement)) resume(sessionId)
      }}
      onFocus={() => pause(sessionId)}
      onBlur={(e) => {
        const box = e.currentTarget
        if (!box.contains(e.relatedTarget as Node | null) && !box.matches(':hover'))
          resume(sessionId)
      }}
    >
      <span>
        {t('orchestra.accounts.switched', { from: nameOf(undo.from), to: nameOf(undo.to) })}
      </span>
      <button type="button" className={styles.btn} onClick={() => undoAccountSwitch(sessionId)}>
        {t('orchestra.accounts.undo')}
      </button>
      <button
        type="button"
        className={styles.iconBtn}
        title={t('orchestra.accounts.dismiss')}
        aria-label={t('orchestra.accounts.dismiss')}
        onClick={() => clear(sessionId)}
      >
        <X size={13} />
      </button>
    </div>
  )
}
