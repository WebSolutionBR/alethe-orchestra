import { useEffect, useState } from 'react'

import { accountConfigDirCached } from '../../lib/claudeAccounts'
import { useT } from '../../lib/i18n'
import { claudeAccountLogin } from '../../lib/tauri/accountLogin'
import { accountTrustSeed } from '../../lib/tauri/accountPreflight'
import { type OrchestraAgent, useOrchestraStore } from '../../stores/orchestraStore'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './AgentAlert.module.css'
import {
  agentAccount,
  blockDetail,
  blockedAlike,
  isAccountBlock,
  signInErrorText,
} from './attention/blocking'
import { muteKey, setMuted, setSigningIn, signInKey, useAttentionStore } from './attention/store'
import { useSession, useSessionId } from './sessionContext'
import { blockDescription } from './shared'

const NO_ACCOUNTS: never[] = []

/** Minutes since `at`, refreshed every 30 s while shown. */
function useMinutesSince(at: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [at])
  return at ? Math.max(0, Math.floor((now - at) / 60_000)) : 0
}

/**
 * A block Claude Code never reports to hooks: a stuck screen (trust dialog, login, onboarding,
 * MCP approval, "Press Enter", usage limit, an unknown still screen) or a launch the account
 * preflight held back. Says what it is, how long it lasts, and offers the one-click way out:
 * trust the folder and continue, sign the account in, or open the terminal.
 */
export function AgentAlertScreen({
  agent,
  onOpenTerminal,
  compact = false,
}: {
  agent: OrchestraAgent
  onOpenTerminal?: () => void
  compact?: boolean
}) {
  const t = useT()
  const sessionId = useSessionId()
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const cwd = useSession((s) => s.cwd)
  const accounts = useProjectsStore((s) => s.preferences.claudeAccounts) ?? NO_ACCOUNTS
  const block = agent.blocked
  const minutes = useMinutesSince(block?.at)
  const key = block ? muteKey(sessionId, agent.id, block.at) : ''
  const muted = useAttentionStore((s) => Boolean(key && s.muted[key]))
  const accountId = agentAccount(agent)
  const signing = signInKey(sessionId, accountId)
  const signingBy = useAttentionStore((s) => s.signingIn[signing] ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!block) return null

  const described = blockDescription(agent)
  const account = accounts.find((a) => a.id === accountId) ?? null
  const className = compact ? `${styles.alert} ${styles.compact}` : styles.alert

  const detail = blockDetail(block, t) || t('orchestra.agents.blocked.noText')

  /**
   * Relaunches this agent and, in a one-account session, the others the same click cleared
   * (same reason, same account), one after the other.
   */
  const restartAll = async (notice: (id: string) => string) => {
    const store = useOrchestraStore.getState()
    const session = store.sessions[sessionId]
    const others = session ? blockedAlike(session, agent.id) : []
    for (const id of [agent.id, ...others]) {
      await store.restartAgent(sessionId, id, { resume: true, notice: notice(id) })
    }
  }

  const run = (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    void work()
      .catch((e: unknown) =>
        setError(
          e instanceof Error
            ? e.message
            : t('orchestra.agents.blocked.actionFailed', { error: String(e) }),
        ),
      )
      .finally(() => setBusy(false))
  }

  const trustAndContinue = () =>
    run(async () => {
      if (!cwd) return
      const dir = accountId ? accountConfigDirCached(accountId) : ''
      const failed = await accountTrustSeed([dir ?? ''], [cwd], false)
      if (failed.length) {
        throw new Error(t('orchestra.agents.blocked.actionFailed', { error: failed.join('; ') }))
      }
      await restartAll((id) => t('orchestra.agents.blocked.trustNotice', { id }))
    })

  const signIn = () =>
    run(async () => {
      if (!account || useAttentionStore.getState().signingIn[signing]) return
      setSigningIn(signing, agent.id)
      // The command rejects with a code ("account_mismatch: <e-mail>", "login_timeout"...).
      const failed = await claudeAccountLogin({
        accountId: account.id,
        email: account.email ?? null,
        chromeProfile: account.chromeProfile ?? null,
      })
        .then(
          () => null,
          (e: unknown) => signInErrorText(String(e), t),
        )
        .finally(() => setSigningIn(signing, null))
      if (failed) {
        setError(failed)
        return
      }
      await restartAll((id) => t('orchestra.agents.blocked.signedInNotice', { id }))
    })

  const loginBlock = block.reason === 'login' || block.reason === 'account'
  const canSignIn = loginBlock && Boolean(account)
  // Another card of this account started the sign-in: this one waits for it.
  const signingElsewhere = signingBy !== null && signingBy !== agent.id

  return (
    <div className={className} data-kind="screen" role="status">
      <div className={styles.head}>
        <span className={styles.tag}>
          !{' '}
          {described
            ? t(described.key, described.params)
            : t('orchestra.agents.blocked.unknownScreen')}
        </span>
        <span className={styles.faint}>
          {t('orchestra.agents.blocked.forMinutes', { minutes })}
        </span>
      </div>
      <p className={`${styles.text} ${isAccountBlock(block) ? '' : styles.screen}`} title={detail}>
        {detail}
      </p>
      {loginBlock && account && !account.chromeProfile ? (
        <p className={styles.faint}>{t('orchestra.agents.blocked.noChromeProfile')}</p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {stopped ? null : (
        <div className={styles.actions}>
          {block.reason === 'trust' && cwd ? (
            <button
              type="button"
              className={`${styles.action} ${styles.primary}`}
              disabled={busy}
              title={t('orchestra.agents.blocked.trustTitle', { folder: cwd })}
              onClick={(e) => {
                e.stopPropagation()
                trustAndContinue()
              }}
            >
              {t('orchestra.agents.blocked.trustAction')}
            </button>
          ) : null}
          {canSignIn && account ? (
            <button
              type="button"
              className={`${styles.action} ${styles.primary}`}
              disabled={busy || signingElsewhere}
              title={
                signingElsewhere
                  ? t('orchestra.attention.signIn.otherTitle', { id: signingBy ?? '' })
                  : t('orchestra.agents.blocked.signInTitle', {
                      account: account.name,
                      profile:
                        account.chromeProfile || t('orchestra.agents.blocked.defaultBrowser'),
                    })
              }
              onClick={(e) => {
                e.stopPropagation()
                signIn()
              }}
            >
              {signingElsewhere
                ? t('orchestra.attention.signIn.other', { id: signingBy ?? '' })
                : busy
                  ? t('orchestra.agents.blocked.signingIn')
                  : t('orchestra.agents.blocked.signIn')}
            </button>
          ) : null}
          {onOpenTerminal && agent.ptyId ? (
            <button
              type="button"
              className={styles.action}
              onClick={(e) => {
                e.stopPropagation()
                onOpenTerminal()
              }}
            >
              {t('orchestra.agents.openTerminal')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.action}
            aria-pressed={muted}
            title={t('orchestra.agents.blocked.muteTitle')}
            onClick={(e) => {
              e.stopPropagation()
              setMuted(key, !muted)
            }}
          >
            {muted ? t('orchestra.agents.blocked.unmute') : t('orchestra.agents.blocked.mute')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * A busy agent with no terminal output and no report for a while: maybe stuck, maybe a long
 * silent command. Amber "stalled?", with the way to look.
 */
export function AgentAlertStalled({
  agent,
  onOpenTerminal,
  compact = false,
}: {
  agent: OrchestraAgent
  onOpenTerminal?: () => void
  compact?: boolean
}) {
  const t = useT()
  const minutes = useMinutesSince(agent.stalledSince)
  if (!agent.stalledSince) return null
  const className = compact ? `${styles.alert} ${styles.compact}` : styles.alert
  return (
    <div className={className} data-kind="stalled" role="status">
      <div className={styles.head}>
        <span className={styles.tag}>? {t('orchestra.agents.stalled')}</span>
        <span>{t('orchestra.agents.stalledFor', { minutes })}</span>
      </div>
      {onOpenTerminal && agent.ptyId ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={(e) => {
              e.stopPropagation()
              onOpenTerminal()
            }}
          >
            {t('orchestra.agents.openTerminal')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
