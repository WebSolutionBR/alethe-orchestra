import { ArrowLeftRight, Loader2, LogIn, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useState } from 'react'

import { formatReset } from '../../lib/agentCanvasUtils'
import { accountErrorKey, accountRefs, loginDaysLeft } from '../../lib/claudeAccounts'
import { useT } from '../../lib/i18n'
import { getAllAccountsUsage, type ClaudeAccountUsage } from '../../lib/tauri'
import type { ClaudeAccount } from '../../lib/types'
import { getProjectDefaultCwd, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './ClaudeAccountsModal.module.css'

const EMPTY_ACCOUNTS: ClaudeAccount[] = []

function UsageBar({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: string }) {
  const width = Math.max(0, Math.min(100, pct))
  return (
    <div className={styles.bar}>
      <div className={styles.barHead}>
        <span className={styles.barLabel}>{label}</span>
        <span className={styles.barPct}>{Math.round(pct)}%</span>
      </div>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${width}%` }} />
      </div>
      {resetsAt ? <span className={styles.barReset}>{formatReset(resetsAt)}</span> : null}
    </div>
  )
}

/**
 * Self-contained Claude accounts manager (list, add, remove, connect, usage).
 * Reused by the stand-alone modal and the Preferences "Claude accounts" page.
 */
export function ClaudeAccountsPanel({ hideIntro = false }: { hideIntro?: boolean }) {
  const t = useT()
  const closeModal = useUiStore((s) => s.closeModal)
  const accounts = useProjectsStore((s) => s.preferences.claudeAccounts) ?? EMPTY_ACCOUNTS
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const projects = useProjectsStore((s) => s.projects)
  const createAgentTerminal = useProjectsStore((s) => s.createAgentTerminal)
  const focusedTerminalId = useProjectsStore((s) => s.workspace.focusedTerminalId)
  const setSubTabClaudeAccount = useProjectsStore((s) => s.setSubTabClaudeAccount)
  const setSubTabSessionId = useProjectsStore((s) => s.setSubTabSessionId)

  const [usage, setUsage] = useState<Record<string, ClaudeAccountUsage>>({})
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newProfile, setNewProfile] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (accounts.length === 0) {
      setUsage({})
      return
    }
    setLoading(true)
    try {
      const results = await getAllAccountsUsage(await accountRefs(accounts))
      const map: Record<string, ClaudeAccountUsage> = {}
      for (const r of results) map[r.id] = r
      setUsage(map)
    } catch {
      // A failed batch leaves the previous snapshot; per-account errors come inline.
    } finally {
      setLoading(false)
    }
  }, [accounts])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addAccount = () => {
    const name = newName.trim()
    if (!name) return
    const account: ClaudeAccount = {
      id: nanoid(8),
      name,
      chromeProfile: newProfile.trim() || undefined,
      createdAt: Date.now(),
    }
    setPreferences({ claudeAccounts: [...accounts, account] })
    setNewName('')
    setNewProfile('')
  }

  const removeAccount = (id: string) => {
    setPreferences({ claudeAccounts: accounts.filter((a) => a.id !== id) })
    setUsage((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // Open a Claude terminal bound to this account. The first run of that pane
  // walks through the normal Claude login inside the account's own config dir;
  // after signing in, its usage shows up here (hit Refresh to re-fetch).
  const connect = async (account: ClaudeAccount) => {
    const projectId = activeProjectId ?? projects[0]?.id
    if (!projectId) {
      setNotice(t('claudeAccounts.noProject'))
      return
    }
    const project = projects.find((p) => p.id === projectId)
    const cwd = getProjectDefaultCwd(project)
    await createAgentTerminal(projectId, {
      name: account.name,
      cwd,
      firstTab: { type: 'claude', cwd, claudeAccountId: account.id },
    })
    closeModal()
  }

  // Quick switch: rebind the focused Claude terminal to this account and restart
  // it fresh (a new sign-in/session under that account's own config dir).
  const quickSwitch = (account: ClaudeAccount) => {
    const match = projects
      .flatMap((p) => p.terminals.map((tm) => ({ projectId: p.id, terminal: tm })))
      .find((entry) => entry.terminal.id === focusedTerminalId)
    const activeTab = match?.terminal.tabs.find((tab) => tab.id === match.terminal.activeTabId)
    if (!match || !activeTab || activeTab.type !== 'claude') {
      setNotice(t('claudeAccounts.noActiveTerminal'))
      return
    }
    setSubTabClaudeAccount(match.projectId, match.terminal.id, activeTab.id, account.id)
    setSubTabSessionId(match.projectId, match.terminal.id, activeTab.id, undefined)
    const terminalId = match.terminal.id
    // Let the store re-render the pane (so its env picks up the new account)
    // before asking it to restart.
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-restart-request', { detail: { terminalId } }),
      )
    }, 0)
    closeModal()
  }

  return (
    <div>
      <div className={styles.panelHead}>
        {hideIntro ? <span /> : <p className={styles.intro}>{t('claudeAccounts.intro')}</p>}
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <Loader2 size={14} className={styles.spin} /> : <RefreshCw size={14} />}
          {t('claudeAccounts.refresh')}
        </button>
      </div>
      {notice ? <div className={styles.warn}>{notice}</div> : null}

      {accounts.length === 0 ? (
        <div className={styles.empty}>{t('claudeAccounts.empty')}</div>
      ) : (
        <ul className={styles.list}>
          {accounts.map((account) => {
            const u = usage[account.id]
            const daysLeft = loginDaysLeft(u?.login_expires_at)
            return (
              <li key={account.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <div className={styles.name}>
                    <span className={styles.dot} />
                    {account.name}
                    {account.chromeProfile ? (
                      <span className={styles.chip}>{account.chromeProfile}</span>
                    ) : null}
                  </div>
                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      title={t('claudeAccounts.switchHereHint')}
                      onClick={() => quickSwitch(account)}
                    >
                      <ArrowLeftRight size={13} />
                      {t('claudeAccounts.switchHere')}
                    </button>
                    <button
                      type="button"
                      className={styles.connectBtn}
                      title={t('claudeAccounts.connectHint')}
                      onClick={() => void connect(account)}
                    >
                      <LogIn size={13} />
                      {t('claudeAccounts.connect')}
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={t('claudeAccounts.remove')}
                      onClick={() => removeAccount(account.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {u?.usage ? (
                  <div className={styles.bars}>
                    <UsageBar
                      label={t('claudeAccounts.fiveHour')}
                      pct={u.usage.five_hour.utilization}
                      resetsAt={u.usage.five_hour.resets_at}
                    />
                    <UsageBar
                      label={t('claudeAccounts.sevenDay')}
                      pct={u.usage.seven_day.utilization}
                      resetsAt={u.usage.seven_day.resets_at}
                    />
                    {daysLeft !== null ? (
                      <div className={styles.note}>
                        {t('claudeAccounts.loginExpiresIn', { days: daysLeft })}
                      </div>
                    ) : null}
                  </div>
                ) : u?.error ? (
                  <div className={styles.note}>{t(accountErrorKey(u.error))}</div>
                ) : (
                  <div className={styles.note}>
                    <Loader2 size={13} className={styles.spin} /> {t('claudeAccounts.loading')}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className={styles.addRow}>
        <input
          className={styles.input}
          value={newName}
          placeholder={t('claudeAccounts.namePlaceholder')}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAccount()}
        />
        <input
          className={styles.input}
          value={newProfile}
          placeholder={t('claudeAccounts.profilePlaceholder')}
          onChange={(e) => setNewProfile(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAccount()}
        />
        <button type="button" className={styles.addBtn} onClick={addAccount} disabled={!newName.trim()}>
          <Plus size={14} />
          {t('claudeAccounts.add')}
        </button>
      </div>
      <p className={styles.hint}>{t('claudeAccounts.signInHint')}</p>
    </div>
  )
}
