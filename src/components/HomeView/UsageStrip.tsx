import { ArrowLeftRight, Clock, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { accountRefs } from '../../lib/claudeAccounts'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { useT } from '../../lib/i18n'
import {
  type AntigravityUsage,
  type ClaudeAccountUsage,
  type ClaudeUsage,
  type CodexUsage,
  getAllAccountsUsage,
  getClaudeUsageFor,
} from '../../lib/tauri'
import { formatResetMs, formatResetTime } from '../../lib/usageReset'
import type { ClaudeAccount } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AntigravityIcon, ClaudeIcon, CodexIcon } from '../icons/AgentIcons'
import { ActivityGraph } from './ActivityGraph'
import styles from './HomeView.module.css'

function meterColor(util: number, base: string): string {
  if (util >= 80) return 'var(--status-offline)'
  if (util >= 50) return 'var(--status-waiting)'
  return base
}

function pctNum(v: number): number {
  return Math.round(v)
}

function CardHead({
  badgeClass,
  icon,
  name,
  plan,
  accent,
  hasData,
  onRefresh,
  onQuickSwitch,
  quickSwitchLabel,
}: {
  badgeClass: string
  icon: ReactNode
  name: string
  plan?: string
  accent: string
  hasData: boolean
  onRefresh: () => Promise<void>
  /** When set, shows a "switch focused terminal to this account" button. */
  onQuickSwitch?: () => void
  quickSwitchLabel?: string
}) {
  const t = useT()
  const [refreshing, setRefreshing] = useState(false)
  const handle = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <div className={styles.cardHead}>
      <div className={`${styles.badge} ${badgeClass}`}>{icon}</div>
      <span className={styles.name}>{name}</span>
      {plan && <span className={styles.plan}>{plan}</span>}
      <div className={styles.headRight}>
        {hasData && (
          <span className={styles.live}>
            <span className={styles.liveDot} style={{ background: accent }} />
            {t('widget.live')}
          </span>
        )}
        {onQuickSwitch ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onQuickSwitch}
            title={quickSwitchLabel ?? t('claudeAccounts.switchHere')}
          >
            <ArrowLeftRight size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handle}
          disabled={refreshing}
          title={hasData ? t('widget.refreshUsage') : t('widget.tryAgain')}
        >
          <RefreshCw size={12} className={refreshing ? styles.iconBtnSpin : undefined} />
        </button>
      </div>
    </div>
  )
}

function Hero({
  percent,
  reset,
  sub,
  critical,
}: {
  percent: number
  reset: string
  sub: ReactNode
  critical?: boolean
}) {
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroNumWrap}>
          <span className={styles.heroNum}>{pctNum(percent)}</span>
          <span className={styles.heroDen}>%</span>
        </div>
        <span className={styles.timechip}>
          <Clock size={11} />
          <b>{reset}</b>
        </span>
      </div>
      <div className={`${styles.heroSub} ${critical ? styles.heroSubCrit : ''}`}>{sub}</div>
    </>
  )
}

function Meter({
  label,
  reset,
  value,
  util,
  base,
}: {
  label: string
  reset?: string
  value: string
  util: number
  base: string
}) {
  const color = meterColor(util, base)
  const pulse = util >= 80
  return (
    <div className={styles.meter}>
      <div className={styles.meterRow}>
        <span className={styles.meterLabel}>
          {label}
          {reset && <span className={styles.meterReset}>{reset}</span>}
        </span>
        <span className={styles.meterValue}>{value}</span>
      </div>
      <div className={styles.meterBar}>
        <div
          className={`${styles.meterFill} ${pulse ? styles.meterFillPulse : ''}`}
          style={{ width: `${Math.min(util, 100)}%`, background: color }}
        />
      </div>
    </div>
  )
}

function CardFoot({ accent, left, right }: { accent: string; left: ReactNode; right: ReactNode }) {
  return (
    <div className={styles.cardFoot}>
      <span className={styles.cardFootLeft}>
        <span className={styles.cardFootDot} style={{ background: accent }} />
        {left}
      </span>
      <span className={styles.cardFootRight}>{right}</span>
    </div>
  )
}

function StatCell({ label, value, crit }: { label: string; value: string; crit?: boolean }) {
  return (
    <div className={styles.statCell}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${crit ? styles.statValueCrit : ''}`}>{value}</span>
    </div>
  )
}

function ClaudeCard({
  usage,
  name = 'claude code',
  plan,
  onRefresh,
  onQuickSwitch,
}: {
  usage: ClaudeUsage | null
  name?: string
  /** Explicit plan chip; `null` hides it, `undefined` uses the default. */
  plan?: string | null
  /** Overrides the active-account refresh (used for extra accounts). */
  onRefresh?: () => Promise<void>
  /** Shows a "switch focused terminal to this account" button in the head. */
  onQuickSwitch?: () => void
}) {
  const t = useT()
  const setClaudeUsage = useUiStore((s) => s.setClaudeUsage)
  const accent = 'var(--agent-claude)'

  const refresh =
    onRefresh ??
    (async () => {
      try {
        setClaudeUsage(await getCachedClaudeUsage(true))
      } catch {
        setClaudeUsage(null)
      }
    })

  const resolvedPlan = plan === undefined ? (usage ? 'max · 5x' : undefined) : (plan ?? undefined)

  const head = (
    <CardHead
      badgeClass={styles.badgeClaude}
      icon={<ClaudeIcon size={16} />}
      name={name}
      plan={resolvedPlan}
      accent={accent}
      hasData={!!usage}
      onRefresh={refresh}
      onQuickSwitch={onQuickSwitch}
    />
  )

  if (!usage) {
    return (
      <div className={styles.usageCard}>
        {head}
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>{t('widget.noTokenConfigured')}</span>
          <span className={styles.usageEmptyHint}>{t('widget.connectToSeeUsage')}</span>
        </div>
      </div>
    )
  }

  const maxUtil = Math.max(
    usage.five_hour.utilization,
    usage.seven_day.utilization,
    usage.seven_day_opus.utilization,
  )

  return (
    <div className={styles.usageCard}>
      {head}
      <Hero
        percent={usage.five_hour.utilization}
        reset={formatResetTime(usage.five_hour.resets_at)}
        critical={usage.five_hour.utilization >= 80}
        sub={
          <>
            {t('widget.usage5h')} ·{' '}
            <b>
              {t('widget.week')} {pctNum(usage.seven_day.utilization)}%
            </b>
          </>
        }
      />
      <div className={styles.cardBody}>
        <div className={styles.meterList}>
          <Meter
            label="5h"
            value={`${pctNum(usage.five_hour.utilization)}%`}
            util={usage.five_hour.utilization}
            base={accent}
          />
          <Meter
            label={t('widget.week')}
            value={`${pctNum(usage.seven_day.utilization)}%`}
            util={usage.seven_day.utilization}
            base={accent}
          />
          <Meter
            label="opus"
            value={`${pctNum(usage.seven_day_opus.utilization)}%`}
            util={usage.seven_day_opus.utilization}
            base={accent}
          />
        </div>
        <div className={styles.statGrid}>
          <StatCell
            label={t('widget.resetLabel', { w: '5h' })}
            value={formatResetTime(usage.five_hour.resets_at)}
          />
          <StatCell
            label={t('widget.resetLabel', { w: t('widget.week') })}
            value={formatResetTime(usage.seven_day.resets_at)}
          />
          <StatCell
            label={t('widget.resetLabel', { w: 'opus' })}
            value={formatResetTime(usage.seven_day_opus.resets_at)}
          />
          <StatCell
            label={t('widget.peakLabel')}
            value={`${pctNum(maxUtil)}%`}
            crit={maxUtil >= 80}
          />
        </div>
      </div>
      <CardFoot
        accent={accent}
        left={`5h · ${t('widget.week')} · opus`}
        right={t('widget.peak', { v: `${pctNum(maxUtil)}%` })}
      />
    </div>
  )
}

function CodexCard({ usage }: { usage: CodexUsage | null }) {
  const t = useT()
  const setCodexUsage = useUiStore((s) => s.setCodexUsage)
  const accent = 'var(--agent-codex)'

  const refresh = async () => {
    try {
      setCodexUsage(await getCachedCodexUsage(true))
    } catch {
      setCodexUsage(null)
    }
  }

  const head = (
    <CardHead
      badgeClass={styles.badgeCodex}
      icon={<CodexIcon size={16} />}
      name="codex"
      plan={usage?.plan || undefined}
      accent={accent}
      hasData={!!usage}
      onRefresh={refresh}
    />
  )

  if (!usage) {
    return (
      <div className={styles.usageCard}>
        {head}
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>{t('widget.codexNotSignedIn')}</span>
          <span className={styles.usageEmptyHint}>{t('widget.codexSignInHint')}</span>
        </div>
      </div>
    )
  }

  const maxUtil = Math.max(usage.primary.used_percent, usage.secondary.used_percent)

  return (
    <div className={styles.usageCard}>
      {head}
      <Hero
        percent={usage.primary.used_percent}
        reset={formatResetMs(usage.primary.resets_at_ms)}
        critical={usage.rate_limited || usage.primary.used_percent >= 80}
        sub={
          usage.rate_limited ? (
            t('widget.limitReached')
          ) : (
            <>
              {t('widget.usage5h')} ·{' '}
              <b>
                {t('widget.week')} {pctNum(usage.secondary.used_percent)}%
              </b>
            </>
          )
        }
      />
      <div className={styles.cardBody}>
        <div className={styles.meterList}>
          <Meter
            label="5h"
            value={`${pctNum(usage.primary.used_percent)}%`}
            util={usage.primary.used_percent}
            base={accent}
          />
          <Meter
            label={t('widget.week')}
            value={`${pctNum(usage.secondary.used_percent)}%`}
            util={usage.secondary.used_percent}
            base={accent}
          />
        </div>
        <div className={styles.statGrid}>
          <StatCell
            label={t('widget.resetLabel', { w: '5h' })}
            value={formatResetMs(usage.primary.resets_at_ms)}
          />
          <StatCell
            label={t('widget.resetLabel', { w: t('widget.week') })}
            value={formatResetMs(usage.secondary.resets_at_ms)}
          />
          <StatCell
            label={t('widget.statusLabel')}
            value={usage.rate_limited ? t('widget.statusLimited') : t('widget.statusOk')}
            crit={usage.rate_limited}
          />
          <StatCell label={t('widget.creditsLabel')} value={String(usage.reset_credits)} />
        </div>
      </div>
      <CardFoot
        accent={accent}
        left={`5h · ${t('widget.week')}`}
        right={t('widget.peak', { v: `${pctNum(maxUtil)}%` })}
      />
    </div>
  )
}

function AntigravityCard({ usage }: { usage: AntigravityUsage | null }) {
  const t = useT()
  const setAntigravityUsage = useUiStore((s) => s.setAntigravityUsage)
  const accent = 'var(--agent-antigravity)'

  const refresh = async () => {
    try {
      setAntigravityUsage(await getCachedAntigravityUsage(true))
    } catch {
      setAntigravityUsage(null)
    }
  }

  const hasData = usage?.status === 'ready' && usage.buckets.length > 0
  const head = (
    <CardHead
      badgeClass={styles.badgeAntigravity}
      icon={<AntigravityIcon size={16} />}
      name="antigravity"
      plan={hasData ? `${usage.buckets.length} ${t('widget.quotaBucketsShort')}` : undefined}
      accent={accent}
      hasData={hasData}
      onRefresh={refresh}
    />
  )

  if (!usage || !hasData) {
    const emptyTitle =
      usage?.status === 'no_cli'
        ? t('widget.antigravityNotInstalled')
        : usage?.status === 'no_auth'
          ? t('widget.antigravityNotSignedIn')
          : t('widget.usageUnavailable')
    return (
      <div className={styles.usageCard}>
        {head}
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>{emptyTitle}</span>
          <span className={styles.usageEmptyHint}>{t('widget.antigravityUsageHint')}</span>
        </div>
      </div>
    )
  }

  const primary = usage.buckets[0]
  return (
    <div className={styles.usageCard}>
      {head}
      <Hero
        percent={usage.used_percent}
        reset={formatResetTime(primary.resets_at)}
        critical={usage.rate_limited || usage.used_percent >= 80}
        sub={
          usage.rate_limited
            ? t('widget.limitReached')
            : t('widget.mostUsedBucket', { name: primary.label })
        }
      />
      <div className={styles.cardBody}>
        <div className={styles.meterList}>
          {usage.buckets.map((bucket) => (
            <Meter
              key={`${bucket.label}:${bucket.resets_at}`}
              label={bucket.label}
              reset={formatResetTime(bucket.resets_at)}
              value={`${pctNum(bucket.used_percent)}%`}
              util={bucket.used_percent}
              base={accent}
            />
          ))}
        </div>
        <div className={styles.statGrid}>
          <StatCell
            label={t('widget.statusLabel')}
            value={usage.rate_limited ? t('widget.statusLimited') : t('widget.statusOk')}
            crit={usage.rate_limited}
          />
          <StatCell
            label={t('widget.remainingLabel')}
            value={`${pctNum(primary.remaining_percent)}%`}
            crit={primary.remaining_percent <= 1}
          />
          <StatCell
            label={t('widget.modelsLabel')}
            value={String(usage.buckets.reduce((sum, bucket) => sum + bucket.models.length, 0))}
          />
          <StatCell
            label={t('widget.peakLabel')}
            value={`${pctNum(usage.used_percent)}%`}
            crit={usage.used_percent >= 80}
          />
        </div>
      </div>
      <CardFoot
        accent={accent}
        left={usage.buckets.map((bucket) => bucket.label).join(' · ')}
        right={t('widget.quotaBuckets', { n: usage.buckets.length })}
      />
    </div>
  )
}

const EMPTY_CLAUDE_ACCOUNTS: ClaudeAccount[] = []

/**
 * Usage cards for the extra Claude accounts the user keeps signed in, each in
 * its own config dir. Shown in the AI usage panel below the main strip.
 */
export function AccountUsageCards() {
  const t = useT()
  const accounts = useProjectsStore((s) => s.preferences.claudeAccounts) ?? EMPTY_CLAUDE_ACCOUNTS
  const openModal = useUiStore((s) => s.openModal_)
  const pushToast = useUiStore((s) => s.pushToast)
  const projects = useProjectsStore((s) => s.projects)
  const focusedTerminalId = useProjectsStore((s) => s.workspace.focusedTerminalId)
  const setSubTabClaudeAccount = useProjectsStore((s) => s.setSubTabClaudeAccount)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)
  const [usage, setUsage] = useState<Record<string, ClaudeAccountUsage>>({})

  const refreshAll = useCallback(async () => {
    if (accounts.length === 0) return
    try {
      const results = await getAllAccountsUsage(await accountRefs(accounts))
      const map: Record<string, ClaudeAccountUsage> = {}
      for (const r of results) map[r.id] = r
      setUsage(map)
    } catch {
      // Per-account errors surface inline; keep the previous snapshot.
    }
  }, [accounts])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const refreshOne = useCallback(async (account: ClaudeAccount) => {
    try {
      const dir = (await accountRefs([account]))[0]?.config_dir
      if (!dir) return
      const u = await getClaudeUsageFor(dir)
      setUsage((prev) => ({ ...prev, [account.id]: { id: account.id, usage: u, error: null } }))
    } catch (err) {
      setUsage((prev) => ({
        ...prev,
        [account.id]: { id: account.id, usage: null, error: String(err) },
      }))
    }
  }, [])

  // Switch the focused Claude terminal to this account and restart it fresh.
  const quickSwitch = useCallback(
    (account: ClaudeAccount) => {
      const match = projects
        .flatMap((p) => p.terminals.map((tm) => ({ projectId: p.id, terminal: tm })))
        .find((entry) => entry.terminal.id === focusedTerminalId)
      const activeTab = match?.terminal.tabs.find((tab) => tab.id === match.terminal.activeTabId)
      if (!match || !activeTab || activeTab.type !== 'claude') {
        pushToast({ title: t('claudeAccounts.switchAccount'), body: t('claudeAccounts.noActiveTerminal') })
        return
      }
      setSubTabClaudeAccount(match.projectId, match.terminal.id, activeTab.id, account.id)
      setSubTabSessionId(match.projectId, match.terminal.id, activeTab.id, undefined)
      const terminalId = match.terminal.id
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('alethe:terminal-restart-request', { detail: { terminalId } }),
        )
      }, 0)
      pushToast({
        title: t('claudeAccounts.switchedTo', { name: account.name }),
        body: '',
        agent: 'claude',
      })
    },
    [projects, focusedTerminalId, setSubTabClaudeAccount, setSubTabSessionId, pushToast, t],
  )

  return (
    <div className={styles.accountSection}>
      <div className={styles.accountSectionHead}>
        <span className={styles.accountSectionTitle}>{t('claudeAccounts.title')}</span>
      </div>
      <div className={styles.accountStrip}>
        {accounts.map((account) => (
          <ClaudeCard
            key={account.id}
            name={account.name}
            plan={null}
            usage={usage[account.id]?.usage ?? null}
            onRefresh={() => refreshOne(account)}
            onQuickSwitch={() => quickSwitch(account)}
          />
        ))}
        <button
          type="button"
          className={styles.accountAdd}
          onClick={() => openModal('claudeAccounts')}
        >
          <Plus size={16} />
          <span>{t('claudeAccounts.manage')}</span>
        </button>
      </div>
    </div>
  )
}

export function UsageStrip({ showActivity = true }: { showActivity?: boolean }) {
  const claudeUsage = useUiStore((s) => s.claudeUsage)
  const codexUsage = useUiStore((s) => s.codexUsage)
  const antigravityUsage = useUiStore((s) => s.antigravityUsage)

  return (
    <div className={`${styles.usageStrip} ${showActivity ? '' : styles.usageStripTwo}`}>
      <ClaudeCard usage={claudeUsage} />
      <CodexCard usage={codexUsage} />
      {!showActivity ? <AntigravityCard usage={antigravityUsage} /> : null}
      {showActivity ? <ActivityGraph /> : null}
    </div>
  )
}
