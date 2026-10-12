import { useState } from 'react'

import { useT } from '../../../lib/i18n'
import { SettingsSection } from '../../modals/preferences/primitives'
import styles from '../../modals/PreferencesModal.module.css'
import own from './Attention.module.css'
import {
  ESCALATION_DEFAULTS,
  ESCALATION_LIMITS,
  type EscalationPrefs,
  readEscalation,
  writeEscalation,
} from './prefs'

const FIELDS: { key: keyof EscalationPrefs; label: Parameters<ReturnType<typeof useT>>[0] }[] = [
  { key: 'thresholdMin', label: 'orchestra.attention.prefs.threshold' },
  { key: 'repeatMin', label: 'orchestra.attention.prefs.repeat' },
  { key: 'stallMin', label: 'orchestra.attention.prefs.stall' },
]

/**
 * Preferences of the long-block reminders and the "stalled?" mark: read by the attention
 * service and the screen watcher on every check, so a change applies at once.
 */
export function EscalationSettings() {
  const t = useT()
  const [prefs, setPrefs] = useState<EscalationPrefs>(readEscalation)
  // What is being typed; saved (within its limits) when the field loses focus or on Enter.
  const [drafts, setDrafts] = useState<Partial<Record<keyof EscalationPrefs, string>>>({})

  const commit = (key: keyof EscalationPrefs) => {
    const raw = drafts[key]
    setDrafts(({ [key]: _, ...rest }) => rest)
    const value = Number(raw)
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(value)) return
    setPrefs(writeEscalation({ ...prefs, [key]: value }))
  }

  return (
    <SettingsSection
      id="orchestra-escalation"
      title={t('orchestra.attention.prefs.title')}
      description={t('orchestra.attention.prefs.desc')}
    >
      {FIELDS.map(({ key, label }) => (
        <label key={key} className={own.prefRow}>
          <span>{t(label)}</span>
          <input
            type="number"
            className={own.prefInput}
            inputMode="numeric"
            min={ESCALATION_LIMITS[key].min}
            max={ESCALATION_LIMITS[key].max}
            value={drafts[key] ?? String(prefs[key])}
            onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
            onBlur={() => commit(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(key)
            }}
          />
        </label>
      ))}
      <div className={styles.segmented}>
        <button type="button" onClick={() => setPrefs(writeEscalation(ESCALATION_DEFAULTS))}>
          {t('orchestra.attention.prefs.reset')}
        </button>
      </div>
    </SettingsSection>
  )
}
