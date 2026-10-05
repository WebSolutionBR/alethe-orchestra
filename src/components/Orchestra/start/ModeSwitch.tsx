import { TriangleAlert } from 'lucide-react'
import { type ReactNode, useId } from 'react'

import creative from '../creative/Creative.module.css'
import styles from '../Orchestra.module.css'
import start from './Start.module.css'

/**
 * One switch of the start screen's Mode section: a labelled `role="switch"` button whose hint is
 * its accessible description. `accent` picks the color of the on state: amber warns about a
 * risk (autonomous mode), pink is the creative agent, green is a plain "on" (alerts).
 */
export function ModeSwitch({
  on,
  onChange,
  label,
  icon,
  hint,
  hintTone = 'muted',
  accent = 'warn',
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
  icon?: ReactNode
  hint: string
  hintTone?: 'muted' | 'warn'
  accent?: 'warn' | 'creative' | 'ok'
}) {
  const labelId = useId()
  const hintId = useId()
  const accentClass =
    accent === 'creative' ? creative.switchOn : accent === 'ok' ? start.switchOk : ''
  const onClass = [styles.switch, styles.switchOn, accentClass].filter(Boolean).join(' ')
  return (
    <div className={styles.toggleRow}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        className={`${on ? onClass : styles.switch} ${start.switchFocus}`}
        onClick={() => onChange(!on)}
      >
        <span className={`${styles.knob} ${creative.knob} ${start.knob}`} />
      </button>
      <div className={styles.toggleText}>
        <span id={labelId} className={`${styles.label} ${start.switchLabel}`}>
          {icon}
          {label}
        </span>
        <span id={hintId} className={hintTone === 'warn' ? styles.warn : styles.fieldHint}>
          {hintTone === 'warn' ? <TriangleAlert size={12} aria-hidden="true" /> : null}
          {hint}
        </span>
      </div>
    </div>
  )
}
