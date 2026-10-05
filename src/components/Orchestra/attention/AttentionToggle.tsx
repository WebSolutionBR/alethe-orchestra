import { Bell, BellOff } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../../lib/i18n'
import { ModeSwitch } from '../start/ModeSwitch'
import { readAlertsEnabled, writeAlertsEnabled } from './prefs'

/** The Alerts switch of the start screen's Mode section; remembered, on by default. */
export function AttentionToggle() {
  const t = useT()
  const [on, setOn] = useState(readAlertsEnabled)

  const change = (next: boolean) => {
    setOn(next)
    writeAlertsEnabled(next)
  }

  return (
    <ModeSwitch
      on={on}
      onChange={change}
      accent="ok"
      label={t('orchestra.attention.toggle')}
      icon={on ? <Bell size={12} aria-hidden="true" /> : <BellOff size={12} aria-hidden="true" />}
      hint={on ? t('orchestra.attention.toggleOn') : t('orchestra.attention.toggleOff')}
    />
  )
}
