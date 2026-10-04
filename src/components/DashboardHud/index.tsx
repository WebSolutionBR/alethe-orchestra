import { useCallback, useEffect, useMemo, useState } from 'react'
import { emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ChevronDown, ChevronRight, Clock, Cpu, HardDrive, MemoryStick, Pin, RefreshCw, X } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { accountErrorKey, accountRefs } from '../../lib/claudeAccounts'
import {
  getAllAccountsUsage,
  getSystemMetrics,
  setDashboardAlwaysOnTop,
  type ClaudeAccountUsage,
  type SystemMetrics,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './DashboardHud.module.css'

const SYSTEM_POLL_MS = 1500
// Usage comes from the OAuth usage endpoint; poll it gently (and offer a manual
// refresh) instead of hammering it, since every account is a separate request.
const USAGE_POLL_MS = 120_000

/** Utilization threshold → status token, so bars read at a glance. */
function usageTone(percent: number): 'ok' | 'warn' | 'crit' {
  if (percent >= 85) return 'crit'
  if (percent >= 60) return 'warn'
  return 'ok'
}

/** Compact time remaining until an ISO reset timestamp, e.g. `2h 10m`, `45m`, `3d 4h`. */
function formatReset(resetsAt: string): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 60) return `${totalMin}m`
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours ? `${days}d ${remHours}h` : `${days}d`
}

function Bar({ percent, tone }: { percent: number; tone: 'ok' | 'warn' | 'crit' }) {
  const width = Math.max(0, Math.min(100, percent))
  return (
    <div className={styles.bar}>
      <div className={styles.barFill} data-tone={tone} style={{ transform: `scaleX(${width / 100})` }} />
    </div>
  )
}

/** Small "resets in X" tag next to a usage bar; renders nothing without a time. */
function ResetTag({ resetsAt, label }: { resetsAt: string; label: string }) {
  const remaining = formatReset(resetsAt)
  if (!remaining) return null
  return (
    <span className={styles.reset} title={label.replace('{time}', remaining)}>
      <Clock size={10} /> {remaining}
    </span>
  )
}

/**
 * System + Claude-account monitor. Renders both as its own always-on-top Tauri
 * window (default) and, when `embedded`, inside the right sidebar — where the
 * window-only chrome (drag region, always-on-top, close-window) is dropped since
 * the sidebar tab already owns those affordances.
 */
export default function DashboardHud({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT()
  const accounts = useProjectsStore((s) => s.preferences.claudeAccounts)
  const currentAccountId = useProjectsStore((s) => s.preferences.currentClaudeAccountId)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const hydrate = useProjectsStore((s) => s.hydrate)

  // Toggle which account is marked as the one currently in use. Selecting one
  // also switches every Claude terminal to it (handled in the main window via
  // this Tauri event, since the DOM restart event can't cross windows).
  const toggleCurrentAccount = (id: string) => {
    const next = currentAccountId === id ? undefined : id
    setPreferences({ currentClaudeAccountId: next })
    // emitTo targets the main window explicitly (reliable cross-window path).
    if (next) void emitTo('main', 'alethe://claude-switch-all', { accountId: next })
  }

  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const [usage, setUsage] = useState<ClaudeAccountUsage[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('monitor.collapsed') ?? '{}')
    } catch {
      return {}
    }
  })

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try {
        localStorage.setItem('monitor.collapsed', JSON.stringify(next))
      } catch {
        /* per-viewer convenience only */
      }
      return next
    })
  }, [])

  // Load persisted preferences (language + accounts) into this window's store.
  // Skipped when embedded: the host window's store is already the live one, so
  // re-hydrating would clobber unsaved state.
  useEffect(() => {
    if (embedded) return
    void hydrate()
  }, [embedded, hydrate])

  // System metrics: cheap and local, polled fast.
  useEffect(() => {
    let alive = true
    const tick = () => {
      getSystemMetrics()
        .then((m) => {
          if (alive) setMetrics(m)
        })
        .catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, SYSTEM_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const refreshUsage = useCallback(async () => {
    if (!accounts || accounts.length === 0) {
      setUsage([])
      return
    }
    setUsageLoading(true)
    try {
      const refs = await accountRefs(accounts)
      const result = await getAllAccountsUsage(refs)
      setUsage(result)
    } catch {
      /* leave previous usage in place */
    } finally {
      setUsageLoading(false)
    }
  }, [accounts])

  // Usage: on mount / when accounts change, plus a gentle interval.
  useEffect(() => {
    void refreshUsage()
    const id = window.setInterval(() => void refreshUsage(), USAGE_POLL_MS)
    return () => window.clearInterval(id)
  }, [refreshUsage])

  const toggleAlwaysOnTop = useCallback(() => {
    setAlwaysOnTop((prev) => {
      const next = !prev
      void setDashboardAlwaysOnTop(next)
      return next
    })
  }, [])

  const usageById = useMemo(() => {
    const map = new Map<string, ClaudeAccountUsage>()
    for (const entry of usage) map.set(entry.id, entry)
    return map
  }, [usage])

  return (
    <div className={styles.hud} data-embedded={embedded || undefined}>
      {!embedded && (
        <header className={styles.header} data-tauri-drag-region>
          <span className={styles.title}>{t('monitor.title')}</span>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconButton}
              data-active={alwaysOnTop}
              title={t('monitor.alwaysOnTop')}
              aria-label={t('monitor.alwaysOnTop')}
              aria-pressed={alwaysOnTop}
              onClick={toggleAlwaysOnTop}
            >
              <Pin size={14} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              title={t('monitor.close')}
              aria-label={t('monitor.close')}
              onClick={() => void getCurrentWindow().close()}
            >
              <X size={14} />
            </button>
          </div>
        </header>
      )}

      <div className={styles.body}>
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionHeadBtn}
            onClick={() => toggleCollapsed('system')}
            aria-expanded={!collapsed.system}
          >
            {collapsed.system ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <h2 className={styles.sectionTitle}>{t('monitor.system')}</h2>
          </button>

          {!collapsed.system && (
            <>
          <div className={styles.metric}>
            <div className={styles.metricHead}>
              <span className={styles.metricLabel}>
                <Cpu size={13} /> {t('monitor.cpu')}
              </span>
              <span className={styles.metricValue}>
                {metrics ? `${Math.round(metrics.cpu_percent)}%` : '—'}
              </span>
            </div>
            <Bar
              percent={metrics?.cpu_percent ?? 0}
              tone={usageTone(metrics?.cpu_percent ?? 0)}
            />
          </div>

          <div className={styles.metric}>
            <div className={styles.metricHead}>
              <span className={styles.metricLabel}>
                <MemoryStick size={13} /> {t('monitor.ram')}
              </span>
              <span className={styles.metricValue}>
                {metrics
                  ? `${(metrics.ram_used_mb / 1024).toFixed(1)} / ${(metrics.ram_total_mb / 1024).toFixed(1)} GB`
                  : '—'}
              </span>
            </div>
            <Bar
              percent={metrics ? (metrics.ram_used_mb / metrics.ram_total_mb) * 100 : 0}
              tone={usageTone(metrics ? (metrics.ram_used_mb / metrics.ram_total_mb) * 100 : 0)}
            />
          </div>

          {metrics?.gpus.map((gpu, index) => {
            const vramPercent =
              gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb) * 100 : 0
            return (
              <div className={styles.metric} key={`gpu-${index}`}>
                <div className={styles.metricHead}>
                  <span className={styles.metricLabel} title={gpu.name}>
                    {t('monitor.gpu')}
                  </span>
                  <span className={styles.metricValue}>
                    {Math.round(gpu.utilization_percent)}% · {Math.round(gpu.temperature_c)}°C ·{' '}
                    {Math.round(gpu.power_watts)} W
                  </span>
                </div>
                <Bar percent={gpu.utilization_percent} tone={usageTone(gpu.utilization_percent)} />
                <div className={styles.subRow}>
                  <span>{t('monitor.vram')}</span>
                  <span>
                    {(gpu.vram_used_mb / 1024).toFixed(1)} / {(gpu.vram_total_mb / 1024).toFixed(1)}{' '}
                    GB
                  </span>
                </div>
                <Bar percent={vramPercent} tone={usageTone(vramPercent)} />
              </div>
            )
          })}

          {metrics?.disks.map((disk) => (
            <div className={styles.metric} key={disk.mount_point}>
              <div className={styles.metricHead}>
                <span className={styles.metricLabel}>
                  <HardDrive size={13} /> {disk.mount_point}
                </span>
                <span className={styles.metricValue}>
                  {disk.used_gb.toFixed(0)} / {disk.total_gb.toFixed(0)} GB
                </span>
              </div>
              <Bar percent={disk.used_percent} tone={usageTone(disk.used_percent)} />
            </div>
          ))}

          {metrics && (
            <div className={styles.subRow}>
              <span>{t('monitor.diskActivity')}</span>
              <span>
                ↓ {metrics.disk_read_mbps.toFixed(1)} · ↑ {metrics.disk_write_mbps.toFixed(1)} MB/s
              </span>
            </div>
          )}
            </>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <button
              type="button"
              className={styles.sectionHeadBtn}
              onClick={() => toggleCollapsed('claude')}
              aria-expanded={!collapsed.claude}
            >
              {collapsed.claude ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <h2 className={styles.sectionTitle}>{t('monitor.claudeAccounts')}</h2>
            </button>
            <button
              type="button"
              className={styles.iconButton}
              title={t('claudeAccounts.refresh')}
              aria-label={t('claudeAccounts.refresh')}
              onClick={() => void refreshUsage()}
              disabled={usageLoading}
            >
              <RefreshCw size={13} className={usageLoading ? styles.spin : undefined} />
            </button>
          </div>

          {!collapsed.claude && (
            <>
          {(!accounts || accounts.length === 0) && (
            <p className={styles.empty}>{t('monitor.noAccounts')}</p>
          )}

          {accounts?.map((account) => {
            const entry = usageById.get(account.id)
            const u = entry?.usage
            return (
              <div
                className={styles.account}
                key={account.id}
                data-current={account.id === currentAccountId}
                role="button"
                tabIndex={0}
                title={t('monitor.setCurrent')}
                onClick={() => toggleCurrentAccount(account.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggleCurrentAccount(account.id)
                  }
                }}
              >
                <div className={styles.accountHead}>
                  <span className={styles.accountName}>
                    {account.id === currentAccountId && <span className={styles.currentDot} />}
                    {account.name}
                  </span>
                  <span className={styles.accountHeadRight}>
                    {account.id === currentAccountId && (
                      <span className={styles.currentTag}>{t('monitor.current')}</span>
                    )}
                    {entry?.error && (
                      <span className={styles.accountErr}>{t(accountErrorKey(entry.error))}</span>
                    )}
                  </span>
                </div>
                {u && (
                  <>
                    <div className={styles.subRow}>
                      <span>{t('claudeAccounts.fiveHour')}</span>
                      <span className={styles.subRowRight}>
                        {Math.round(u.five_hour.utilization)}%
                        <ResetTag resetsAt={u.five_hour.resets_at} label={t('monitor.resetsIn')} />
                      </span>
                    </div>
                    <Bar
                      percent={u.five_hour.utilization}
                      tone={usageTone(u.five_hour.utilization)}
                    />
                    <div className={styles.subRow}>
                      <span>{t('claudeAccounts.sevenDay')}</span>
                      <span className={styles.subRowRight}>
                        {Math.round(u.seven_day.utilization)}%
                        <ResetTag resetsAt={u.seven_day.resets_at} label={t('monitor.resetsIn')} />
                      </span>
                    </div>
                    <Bar
                      percent={u.seven_day.utilization}
                      tone={usageTone(u.seven_day.utilization)}
                    />
                  </>
                )}
                {!u && !entry?.error && usageLoading && (
                  <span className={styles.loading}>{t('claudeAccounts.loading')}</span>
                )}
              </div>
            )
          })}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
