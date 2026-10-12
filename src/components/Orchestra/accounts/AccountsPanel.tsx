import { AlertTriangle, LogIn, RefreshCw, RotateCcw, Users, X } from 'lucide-react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { type MessageKey, useT } from '../../../lib/i18n'
import { claudeAccountLogin } from '../../../lib/tauri/accountLogin'
import type { ClaudeAccountIdentity } from '../../../lib/tauri/orchestra'
import type { ClaudeUsageWindow } from '../../../lib/tauri/usage'
import type { ClaudeAccount } from '../../../lib/types'
import type { OrchestraAgent } from '../../../stores/orchestraStore'
import { clockTime } from '../sessionActions'
import { useSession, useSessionId } from '../sessionContext'
import { useClaudeAccounts } from '../usage/UsageBar'
import {
  type AccountUsageRow,
  DEFAULT_ACCOUNT_KEY,
  resetLabel,
  USAGE_TTL_MS,
  usageLevel,
  useUsageStore,
} from '../usage/usageStore'
import styles from './Accounts.module.css'
import { askRestartOnSessionAccount } from './actions'
import { useAccountName, useSessionAccountRow, useSessionLaunch } from './hooks'
import { readAutoWaitOnLimit, writeAutoWaitOnLimit } from './limitPrefs'
import {
  accountKey,
  agentsByAccount,
  agentsOffAccount,
  type CardError,
  cardError,
  duplicateAccounts,
  emailMismatch,
  nearLimit,
  switchRisks,
} from './model'
import { switchSessionAccountGuarded } from './switchAccount'

/* ---------------------------------------------------------------- rail and header */

/** The accounts button on the session's side rail; warns when the session account is near its limit. */
export function AccountsRail({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement>
}) {
  const t = useT()
  const launch = useSessionLaunch()
  const nameOf = useAccountName()
  const row = useSessionAccountRow()
  const near = nearLimit(row?.usage)
  const title = near
    ? t('orchestra.accounts.openNear', { name: nameOf(launch.account) })
    : t('orchestra.accounts.openTitle')
  return (
    <nav className={styles.rail} aria-label={t('orchestra.accounts.title')}>
      <button
        ref={buttonRef}
        type="button"
        className={open ? `${styles.railBtn} ${styles.railBtnOn}` : styles.railBtn}
        aria-pressed={open}
        aria-expanded={open}
        aria-keyshortcuts="Alt+A"
        aria-label={title}
        title={title}
        onClick={onToggle}
      >
        <Users size={15} />
        {near ? <span className={styles.railDot} aria-hidden="true" /> : null}
      </button>
    </nav>
  )
}

/** "One account: <name>" in the session header, in the near-limit color when it is close. */
export function SessionAccountChip({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  const launch = useSessionLaunch()
  const nameOf = useAccountName()
  const row = useSessionAccountRow()
  const name = nameOf(launch.account)
  const level = usageLevel(row?.usage ? Math.round(row.usage.five_hour?.utilization ?? 0) : null)
  const label =
    launch.policy === 'single'
      ? t('orchestra.accounts.policySingle', { name })
      : t('orchestra.accounts.policySpread')
  const title =
    launch.policy === 'single'
      ? t('orchestra.accounts.policySingleTitle', { name })
      : t('orchestra.accounts.policySpreadTitle', { name })
  const tone = level === 'hot' ? styles.chipHot : level === 'warn' ? styles.chipWarn : ''
  return (
    <button
      type="button"
      className={`${styles.chip} ${tone}`}
      title={title}
      aria-label={title}
      aria-keyshortcuts="Alt+A"
      onClick={onOpen}
    >
      <Users size={11} />
      <span className={styles.chipText}>{label}</span>
    </button>
  )
}

/* ---------------------------------------------------------------- panel */

function WindowMeter({
  label,
  window,
}: {
  label: MessageKey
  window: ClaudeUsageWindow | undefined
}) {
  const t = useT()
  const pct = window ? Math.round(window.utilization) : null
  const level = usageLevel(pct)
  const when = resetLabel(window?.resets_at)
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span>{t(label)}</span>
        <span className={level === 'hot' ? styles.hot : level === 'warn' ? styles.warn : undefined}>
          {pct === null ? '–' : `${pct}%`}
        </span>
      </div>
      <div
        className={`${styles.track} ${level === 'hot' ? styles.trackHot : level === 'warn' ? styles.trackWarn : ''}`}
        role="meter"
        aria-label={t(label)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        aria-valuetext={
          pct === null
            ? '–'
            : t('orchestra.accounts.resetIn', { window: t(label), pct, when: when || '?' })
        }
      >
        <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
      {when ? (
        <span className={styles.reset}>
          {t('orchestra.accounts.resetIn', { window: t(label), pct: pct ?? 0, when })}
        </span>
      ) : null}
    </div>
  )
}

type CardProps = {
  row: AccountUsageRow
  account: ClaudeAccount | null
  identity: ClaudeAccountIdentity | undefined
  duplicates: string[]
  agents: OrchestraAgent[]
  active: boolean
  canSwitch: boolean
  nameOf: (account: string | null) => string
}

function AccountCard({
  row,
  account,
  identity,
  duplicates,
  agents,
  active,
  canSwitch,
  nameOf,
}: CardProps) {
  const t = useT()
  const sessionId = useSessionId()
  const id = row.id === DEFAULT_ACCOUNT_KEY ? null : row.id
  const name = nameOf(id)
  const mismatch = account ? emailMismatch(account, identity) : false
  const near = nearLimit(row.usage)
  const error = row.usage ? null : cardError(row)
  const loginFirst = error?.kind === 'login'
  return (
    <li className={active ? `${styles.card} ${styles.cardActive}` : styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName} title={name}>
          {name}
        </span>
        {active ? (
          <span className={styles.badge}>{t('orchestra.accounts.sessionAccount')}</span>
        ) : null}
        {near ? (
          <span className={styles.badgeHot}>
            <AlertTriangle size={11} aria-hidden="true" /> {t('orchestra.accounts.nearLimit')}
          </span>
        ) : null}
      </div>
      <div
        className={styles.identity}
        title={
          identity?.organization_name
            ? t('orchestra.accounts.organization', { name: identity.organization_name })
            : undefined
        }
      >
        {identity?.email
          ? t('orchestra.accounts.signedInAs', { email: identity.email })
          : t('orchestra.accounts.noIdentity')}
      </div>
      {mismatch ? (
        <div className={styles.alert} role="alert">
          <AlertTriangle size={12} aria-hidden="true" />
          {t('orchestra.accounts.emailMismatch', {
            real: identity?.email ?? '',
            expected: account?.email ?? '',
          })}
        </div>
      ) : null}
      {duplicates.length > 0 ? (
        <div className={styles.alert} role="alert">
          <AlertTriangle size={12} aria-hidden="true" />
          {t('orchestra.accounts.duplicate', {
            names: duplicates.map((d) => nameOf(d)).join(', '),
          })}
        </div>
      ) : null}
      {row.usage ? (
        <div className={styles.meters}>
          <WindowMeter label="orchestra.usage.fiveHour" window={row.usage.five_hour} />
          <WindowMeter label="orchestra.usage.sevenDay" window={row.usage.seven_day} />
        </div>
      ) : (
        <CardErrorLine error={error} raw={row.error} />
      )}
      {row.staleSince && row.fetchedAt ? (
        <div className={styles.muted}>
          {t('orchestra.accounts.staleRetry', {
            time: clockTime(row.fetchedAt),
            retry: row.retryAt ? clockTime(row.retryAt) : '?',
          })}
        </div>
      ) : null}
      <div className={styles.agents}>
        <span className={styles.muted}>
          {agents.length === 0
            ? t('orchestra.accounts.agentsNone')
            : agents.length === 1
              ? t('orchestra.accounts.agentsOne')
              : t('orchestra.accounts.agents', { count: agents.length })}
        </span>
        {agents.map((agent) => (
          <span key={agent.id} className={styles.agentChip}>
            {agent.id}
          </span>
        ))}
      </div>
      <div className={styles.cardActions}>
        {account && loginFirst ? (
          <SignInButton account={account} identity={identity} prominent />
        ) : null}
        {!active && canSwitch ? (
          <button
            type="button"
            className={styles.btn}
            title={t('orchestra.accounts.useHereTitle', { name })}
            onClick={() =>
              void switchSessionAccountGuarded(sessionId, id, switchRisks(row, duplicates), name, t)
            }
          >
            {t('orchestra.accounts.useHere')}
          </button>
        ) : null}
        {account && !loginFirst ? <SignInButton account={account} identity={identity} /> : null}
      </div>
    </li>
  )
}

/** The card's line when no usage could be read: one message per error. */
function CardErrorLine({ error, raw }: { error: CardError | null; raw: string | null }) {
  const t = useT()
  if (error?.kind === 'login')
    return (
      <div className={styles.alert} role="alert">
        <AlertTriangle size={12} aria-hidden="true" />
        {t('orchestra.accounts.loginExpired')}
      </div>
    )
  if (error?.kind === 'rateLimited')
    return (
      <div className={styles.muted} title={raw ?? undefined}>
        {error.retryAt
          ? t('orchestra.accounts.rateLimited', { time: clockTime(error.retryAt) })
          : t('orchestra.accounts.rateLimitedNoTime')}
      </div>
    )
  return (
    <div className={styles.muted} title={raw ?? undefined}>
      {error?.kind === 'signedOut'
        ? t('orchestra.usage.signedOut')
        : t('orchestra.usage.unavailable')}
    </div>
  )
}

/**
 * Signs the account in again, opening the authorization in its own Chrome profile. Without a
 * profile the default browser opens, which may be signed in to another account: the card warns.
 * Afterwards the usage and the real sign-in are read again.
 */
function SignInButton({
  account,
  identity,
  prominent = false,
}: {
  account: ClaudeAccount
  identity: ClaudeAccountIdentity | undefined
  /** The sign-in expired: the button leads the card's actions. */
  prominent?: boolean
}) {
  const t = useT()
  const accounts = useClaudeAccounts()
  const refresh = useUsageStore((s) => s.refresh)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await claudeAccountLogin({
        accountId: account.id,
        email: account.email || identity?.email || null,
        chromeProfile: account.chromeProfile || null,
      })
      await refresh(accounts, true)
    } catch (reason) {
      setError(signInError(String(reason), t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className={prominent ? `${styles.btn} ${styles.btnPrimary}` : styles.btn}
        disabled={busy}
        aria-busy={busy}
        title={t('orchestra.accounts.signInTitle', { name: account.name })}
        onClick={() => void signIn()}
      >
        <LogIn size={12} />
        {t('orchestra.accounts.signIn')}
      </button>
      {!account.chromeProfile ? (
        <span className={styles.muted}>{t('orchestra.accounts.noChromeProfile')}</span>
      ) : null}
      {error ? (
        <span className={styles.alert} role="alert">
          {error}
        </span>
      ) : null}
    </>
  )
}

/** The sign-in command's reject string as a sentence: the known codes get their own. */
function signInError(reason: string, t: ReturnType<typeof useT>): string {
  const mismatch = /^account_mismatch:\s*(.*)$/.exec(reason)
  if (mismatch) return t('orchestra.accounts.signInMismatch', { email: mismatch[1] || '?' })
  if (reason === 'account_busy') return t('orchestra.accounts.signInBusy')
  if (reason === 'login_timeout') return t('orchestra.accounts.signInTimeout')
  if (reason === 'login_incomplete') return t('orchestra.accounts.signInIncomplete')
  if (reason === 'claude_not_found') return t('orchestra.accounts.signInNoClaude')
  // Same text as the agent alert's sign-in (attention/i18n.ts).
  if (reason === 'chrome_not_found') return t('orchestra.attention.signIn.noChrome')
  if (reason === 'bad_profile') return t('orchestra.attention.signIn.badProfile')
  return t('orchestra.accounts.signInFailed', { message: reason })
}

/** "On hitting the limit: wait for the reset and continue", kept across sessions. */
function AutoWaitPref({ policy }: { policy: 'single' | 'spread' }) {
  const t = useT()
  const [on, setOn] = useState(() => readAutoWaitOnLimit(policy))
  return (
    <label className={styles.pref} title={t('orchestra.accounts.autoWaitTitle')}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          writeAutoWaitOnLimit(e.target.checked)
          setOn(e.target.checked)
        }}
      />
      {t('orchestra.accounts.autoWait')}
    </label>
  )
}

/** Agents still on another account after a switch, with the restarts the user may confirm. */
function OffAccount({ agents, name }: { agents: OrchestraAgent[]; name: string }) {
  const t = useT()
  const sessionId = useSessionId()
  if (agents.length === 0) return null
  return (
    <section className={styles.off} aria-label={t('orchestra.accounts.offTitle')}>
      <h3 className={styles.offTitle}>{t('orchestra.accounts.offTitle')}</h3>
      <p className={styles.muted}>{t('orchestra.accounts.offHint')}</p>
      <ul className={styles.offList}>
        {agents.map((agent) => (
          <li key={agent.id} className={styles.offRow}>
            <span className={styles.agentChip}>{agent.id}</span>
            <button
              type="button"
              className={styles.btn}
              onClick={() => void askRestartOnSessionAccount(sessionId, [agent], name, t)}
            >
              <RotateCcw size={12} />
              {t('orchestra.accounts.restartOne', { name })}
            </button>
          </li>
        ))}
      </ul>
      {agents.length > 1 ? (
        <button
          type="button"
          className={styles.btn}
          onClick={() => void askRestartOnSessionAccount(sessionId, agents, name, t)}
        >
          <RotateCcw size={12} />
          {t('orchestra.accounts.restartAll', { name })}
        </button>
      ) : null}
    </section>
  )
}

/**
 * The session's accounts panel: usage per account (5h, week, resets), who each folder is really
 * signed in as, how many agents run on each, and switching the session's account. It reads the
 * shared usage cache and only asks for a new read when that is older than USAGE_TTL_MS or on
 * the refresh button (the usage endpoint answers 429 to frequent reads).
 */
export function AccountsPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const accounts = useClaudeAccounts()
  const launch = useSessionLaunch()
  const nameOf = useAccountName()
  const { agents, stopped } = useSession(
    useShallow((s) => ({ agents: s.agents, stopped: Boolean(s.stoppedAt) })),
  )
  const { rows, identities, loading, fetchedAt, refresh } = useUsageStore(
    useShallow((s) => ({
      rows: s.rows,
      identities: s.identities,
      loading: s.loading,
      fetchedAt: s.fetchedAt,
      refresh: s.refresh,
    })),
  )
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (Date.now() - useUsageStore.getState().fetchedAt >= USAGE_TTL_MS) void refresh(accounts)
    // Only on open: the top bar keeps the cache fresh while the session is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const duplicates = useMemo(() => duplicateAccounts(accounts, identities), [accounts, identities])
  const byAccount = useMemo(() => agentsByAccount(agents, launch), [agents, launch])
  const off = useMemo(
    () => (stopped ? [] : agentsOffAccount(agents, launch)),
    [agents, launch, stopped],
  )
  const sessionName = nameOf(launch.account)

  return (
    <aside
      ref={panelRef}
      className={styles.panel}
      aria-label={t('orchestra.accounts.title')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <Users size={14} aria-hidden="true" />
        <h2 className={styles.title}>{t('orchestra.accounts.title')}</h2>
        <span className={styles.spacer} />
        {fetchedAt ? (
          <span className={styles.muted}>
            {t('orchestra.accounts.fetchedAt', { time: clockTime(fetchedAt) })}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.iconBtn}
          disabled={loading}
          title={t('orchestra.accounts.refresh')}
          aria-label={t('orchestra.accounts.refresh')}
          onClick={() => void refresh(accounts, true)}
        >
          <RefreshCw size={13} className={loading ? styles.spin : undefined} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title={t('orchestra.accounts.close')}
          aria-label={t('orchestra.accounts.close')}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className={styles.scroll}>
        <p className={styles.policy}>
          {launch.policy === 'single'
            ? t('orchestra.accounts.policySingleTitle', { name: sessionName })
            : t('orchestra.accounts.policySpreadTitle', { name: sessionName })}
        </p>
        {stopped ? (
          <p className={styles.muted}>{t('orchestra.accounts.stopped')}</p>
        ) : (
          <AutoWaitPref policy={launch.policy} />
        )}
        {duplicates.size > 0 ? (
          <div className={styles.banner} role="alert">
            <AlertTriangle size={13} aria-hidden="true" />
            {t('orchestra.accounts.duplicateBanner')}
          </div>
        ) : null}
        <OffAccount agents={off} name={sessionName} />
        {rows.length === 0 ? (
          <p className={styles.muted}>{t('orchestra.usage.loading')}</p>
        ) : (
          <ul className={styles.cards}>
            {rows.map((row) => {
              const account = accounts.find((a) => a.id === row.id) ?? null
              return (
                <AccountCard
                  key={row.id || 'default'}
                  row={row}
                  account={account}
                  identity={identities[row.id]}
                  duplicates={duplicates.get(row.id) ?? []}
                  agents={byAccount.get(row.id) ?? []}
                  active={accountKey(launch.account) === row.id}
                  canSwitch={!stopped}
                  nameOf={nameOf}
                />
              )
            })}
          </ul>
        )}
        {accounts.length === 0 ? (
          <p className={styles.muted}>{t('orchestra.accounts.empty')}</p>
        ) : null}
      </div>
    </aside>
  )
}
