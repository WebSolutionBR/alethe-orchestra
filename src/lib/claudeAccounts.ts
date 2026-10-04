import { appLocalDataDir, join } from '@tauri-apps/api/path'

import type { ClaudeAccount } from './types'
import type { ClaudeAccountRef } from './tauri/usage'

/**
 * Where each Claude account keeps its own Claude Code state. Sits at the root of
 * the app data dir (not under `profiles/<id>`), so accounts are shared across
 * Alethe profiles. A pane launched with `CLAUDE_CONFIG_DIR` pointing here stays
 * signed in independently of every other account.
 */
export async function accountConfigDir(accountId: string): Promise<string> {
  const base = await appLocalDataDir()
  return join(base, 'claude-accounts', accountId)
}

/** Resolve the config dir for many accounts, ready for `getAllAccountsUsage`. */
export async function accountRefs(accounts: ClaudeAccount[]): Promise<ClaudeAccountRef[]> {
  return Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      config_dir: await accountConfigDir(account.id),
    })),
  )
}

// The app local data dir is constant for a session. We resolve it once at
// startup so panes can derive an account's config dir synchronously when they
// spawn (the terminal render path is not async).
let cachedBase: string | null = null

/** Resolve and cache the app data dir. Call once at startup. */
export async function primeAccountBase(): Promise<void> {
  if (!cachedBase) cachedBase = await appLocalDataDir()
}

/**
 * Synchronous config dir for a pane's env, using the cached base. Returns null
 * until `primeAccountBase` has resolved — the pane then simply runs as the
 * default account, never worse than today.
 */
export function accountConfigDirCached(accountId: string): string | null {
  if (!cachedBase) return null
  const sep = cachedBase.includes('\\') ? '\\' : '/'
  const root = cachedBase.endsWith(sep) ? cachedBase.slice(0, -1) : cachedBase
  return [root, 'claude-accounts', accountId].join(sep)
}

/** Days of sign-in left at which the accounts panel starts warning. */
export const LOGIN_EXPIRY_WARN_DAYS = 5

/**
 * Message key for an account usage error from the backend. Access tokens are
 * renewed automatically, so what is left is either "never signed in", "the
 * sign-in itself ran out" or "the renewal failed".
 */
export function accountErrorKey(
  error: string,
): 'claudeAccounts.signedOut' | 'claudeAccounts.loginExpired' | 'claudeAccounts.tokenExpired' | 'claudeAccounts.usageError' {
  switch (error) {
    case 'no_token':
      return 'claudeAccounts.signedOut'
    case 'login_expired':
      return 'claudeAccounts.loginExpired'
    case 'token_expired':
    case 'unauthorized':
      return 'claudeAccounts.tokenExpired'
    default:
      return 'claudeAccounts.usageError'
  }
}

/** Whole days until the sign-in lapses, or null when it is not close enough to warn. */
export function loginDaysLeft(loginExpiresAt: number | null | undefined, now = Date.now()): number | null {
  if (!loginExpiresAt) return null
  const days = Math.ceil((loginExpiresAt - now) / 86_400_000)
  return days > 0 && days <= LOGIN_EXPIRY_WARN_DAYS ? days : null
}
