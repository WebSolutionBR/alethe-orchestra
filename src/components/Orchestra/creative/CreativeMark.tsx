import { Sparkles } from 'lucide-react'

import { useT } from '../../../lib/i18n'
import creative from './Creative.module.css'
import { isCreativeArea } from './role'

/**
 * Discreet creative identity for a view: the spark icon, optionally with the short label in a
 * soft chip. Renders nothing for any other area, so views can drop it next to every worker.
 * `inline` adds a leading gap for use inside running text (outside a flex row with `gap`).
 */
export function CreativeMark({
  area,
  withLabel = false,
  inline = false,
  size = 11,
}: {
  area: string | null | undefined
  withLabel?: boolean
  inline?: boolean
  size?: number
}) {
  const t = useT()
  if (!isCreativeArea(area)) return null
  const className = [creative.mark, withLabel ? creative.chip : '', inline ? creative.inline : '']
    .filter(Boolean)
    .join(' ')
  return (
    <span
      className={className}
      title={t('orchestra.creative.badgeTitle')}
      role="img"
      aria-label={t('orchestra.creative.name')}
    >
      <Sparkles size={size} aria-hidden="true" />
      {withLabel ? <span aria-hidden="true">{t('orchestra.creative.badge')}</span> : null}
    </span>
  )
}
