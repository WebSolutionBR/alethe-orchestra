import { PlugZap, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import type { ClaudeUsageWindow } from '../../../lib/tauri/usage'
import type { ClaudeAccount } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import styles from './Usage.module.css'
import {
  type AccountUsageRow,
  resetLabel,
  USAGE_TTL_MS,
  usageLevel,
  useUsageStore,
} from './usageStore'

const NO_ACCOUNTS: ClaudeAccount[] = []

/** Linked Claude accounts from preferences (empty when none are configured). */
export function useClaudeAccounts(): ClaudeAccount[] {
  return useProjectsStore((s) => s.preferences.claudeAccounts) ?? NO_ACCOUNTS
}

function Meter({ label, window }: { label: MessageKey; window: ClaudeUsageWindow | undefined }) {
  const t = useT()
  const pct = window ? Math.round(window.utilization) : null
  const level = usageLevel(pct)
  const trackClass =
    level === 'warn' || level === 'hot' ? `${styles.track} ${styles[level]}` : styles.track
  const title =
    pct === null
      ? undefined
      : t('orchestra.usage.resets', {
          window: t(label),
          pct,
          when: resetLabel(window?.resets_at) || '?',
        })
  return (
    <span className={styles.meter} title={title}>
      <span className={trackClass}>
        <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <span className={level === 'hot' ? `${styles.pct} ${styles.hot}` : styles.pct}>
        {t(label)} {pct === null ? '–' : `${pct}%`}
      </span>
    </span>
  )
}

function AccountUsage({ row }: { row: AccountUsageRow }) {
  const t = useT()
  const name = row.name ?? t('orchestra.usage.defaultAccount')
  return (
    <span className={styles.account}>
      <span className={styles.name} title={name}>
        {name}
      </span>
      {row.usage ? (
        <>
          <Meter label="orchestra.usage.fiveHour" window={row.usage.five_hour} />
          <Meter label="orchestra.usage.sevenDay" window={row.usage.seven_day} />
        </>
      ) : (
        <span className={styles.muted} title={row.error ?? undefined}>
          {row.error === 'no_token'
            ? t('orchestra.usage.signedOut')
            : t('orchestra.usage.unavailable')}
        </span>
      )}
    </span>
  )
}

/** Compact 5h / weekly limit meters for the default account and every linked account. */
export function UsageBar() {
  const t = useT()
  const accounts = useClaudeAccounts()
  const { rows, loading, refresh, syncMcp } = useUsageStore()
  const [toast, setToast] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    const tick = () => {
      if (Date.now() - useUsageStore.getState().fetchedAt >= USAGE_TTL_MS) void refresh(accounts)
    }
    tick()
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [accounts, refresh])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const onSync = async () => {
    setSyncing(true)
    try {
      const results = await syncMcp(accounts)
      const added = results.reduce((sum, r) => sum + r.added.length, 0)
      setToast(
        added > 0
          ? t('orchestra.usage.syncMcpDone', { count: added })
          : t('orchestra.usage.syncMcpNone'),
      )
    } catch (error) {
      setToast(t('orchestra.usage.syncMcpFailed', { message: String(error) }))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className={styles.bar} aria-label={t('orchestra.usage.title')}>
      <div className={styles.accounts}>
        {rows.length === 0 ? (
          <span className={styles.muted}>{t('orchestra.usage.loading')}</span>
        ) : (
          rows.map((row) => <AccountUsage key={row.id || 'default'} row={row} />)
        )}
      </div>
      {toast ? <span className={styles.toast}>{toast}</span> : null}
      {accounts.length > 0 ? (
        <button
          type="button"
          className={styles.iconBtn}
          disabled={syncing}
          title={t('orchestra.usage.syncMcp')}
          aria-label={t('orchestra.usage.syncMcp')}
          onClick={() => void onSync()}
        >
          <PlugZap size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className={styles.iconBtn}
        disabled={loading}
        title={t('orchestra.usage.refresh')}
        aria-label={t('orchestra.usage.refresh')}
        onClick={() => void refresh(accounts)}
      >
        <RefreshCw size={12} className={loading ? styles.spin : undefined} />
      </button>
    </div>
  )
}
