import { History } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { runLegacyImport, toastLegacyImport, toastLegacyImportError } from '../../lib/legacyImport'
import { legacyAletheStatus } from '../../lib/tauri/legacyImport'
import styles from './LegacyResync.module.css'

/** Sidebar footer action that re-runs the read-only import from the original Alethe. */
export function LegacyResync() {
  const t = useT()
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    legacyAletheStatus()
      .then((status) => {
        if (alive) setAvailable(status.available)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (!available) return null

  const resync = async () => {
    if (busy) return
    setBusy(true)
    try {
      toastLegacyImport(await runLegacyImport({ resync: true }), true)
    } catch (error) {
      toastLegacyImportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={styles.resync}
      title={t('legacyImport.resyncHint')}
      disabled={busy}
      onClick={() => void resync()}
    >
      <History size={12} className={busy ? styles.spin : undefined} />
      <span>{t('legacyImport.resync')}</span>
    </button>
  )
}
