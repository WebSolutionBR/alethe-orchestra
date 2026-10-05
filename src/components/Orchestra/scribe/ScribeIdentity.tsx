import { Gem } from 'lucide-react'

import { useT } from '../../../lib/i18n'
import styles from './ScribeIdentity.module.css'

type ScribeIdentityProps = {
  /** `mark`: the crystal alone on Obsidian's soft purple, with the name as its label. */
  variant?: 'inline' | 'mark'
  size?: number
  className?: string
}

/** The scribe's identity in every view: Obsidian purple, a crystal and its name. */
export function ScribeIdentity({ variant = 'inline', size = 13, className }: ScribeIdentityProps) {
  const t = useT()
  const name = t('orchestra.scribe.name')
  if (variant === 'mark') {
    return (
      <span
        className={className ? `${styles.mark} ${className}` : styles.mark}
        role="img"
        aria-label={name}
        title={name}
      >
        <Gem size={size} aria-hidden="true" />
      </span>
    )
  }
  return (
    <span className={className ? `${styles.identity} ${className}` : styles.identity}>
      <Gem size={size} className={styles.icon} aria-hidden="true" />
      <span className={styles.name}>{name}</span>
    </span>
  )
}
