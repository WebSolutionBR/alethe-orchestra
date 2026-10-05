import { Sparkles } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../../lib/i18n'
import { ModeSwitch } from '../start/ModeSwitch'
import creative from './Creative.module.css'
import { readCreativeEnabled, writeCreativeEnabled } from './role'

/**
 * Start screen switch of the built-in creative agent, in the start screen's Mode section.
 * The choice is remembered and read when the next orchestrator launches.
 */
export function CreativeToggle() {
  const t = useT()
  const [on, setOn] = useState(readCreativeEnabled)

  const change = (next: boolean) => {
    setOn(next)
    writeCreativeEnabled(next)
  }

  return (
    <ModeSwitch
      on={on}
      onChange={change}
      accent="creative"
      label={t('orchestra.creative.name')}
      icon={<Sparkles size={12} className={creative.icon} aria-hidden="true" />}
      hint={on ? t('orchestra.creative.hint') : t('orchestra.creative.offHint')}
    />
  )
}
