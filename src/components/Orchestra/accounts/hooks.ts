import { useEffect, useMemo, useRef } from 'react'

import { useT } from '../../../lib/i18n'
import { useSession, useSessionFocused } from '../sessionContext'
import type { SessionLaunch } from '../usage/launch'
import { sessionLaunchOf } from '../usage/launchDefaults'
import { useClaudeAccounts } from '../usage/UsageBar'
import { type AccountUsageRow, useUsageStore } from '../usage/usageStore'
import { accountKey } from './model'

/** The session's launch settings, stable while the session's own `launch` does not change. */
export function useSessionLaunch(): SessionLaunch {
  const launch = useSession((s) => s.launch)
  return useMemo(() => sessionLaunchOf({ launch }), [launch])
}

/** Display name of an account id; the default account has none of its own. */
export function useAccountName(): (account: string | null) => string {
  const t = useT()
  const accounts = useClaudeAccounts()
  return (account) =>
    account
      ? (accounts.find((a) => a.id === account)?.name ?? account)
      : t('orchestra.usage.defaultAccount')
}

/** Usage row of the session's account, if the panel or the top bar already read it. */
export function useSessionAccountRow(): AccountUsageRow | null {
  const launch = useSessionLaunch()
  return useUsageStore((s) => s.rows.find((r) => r.id === accountKey(launch.account)) ?? null)
}

/** Alt+A opens and closes the accounts panel of the focused pane, even from a terminal. */
export function useAccountsShortcut(toggle: () => void): void {
  const focused = useSessionFocused()
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyA') {
        e.preventDefault()
        e.stopPropagation()
        toggleRef.current()
      }
    }
    // Capture phase, like Alt+1..6: a focused terminal would otherwise take the key.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [focused])
}
