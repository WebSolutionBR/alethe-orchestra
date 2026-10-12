import { invoke } from '@tauri-apps/api/core'

/** Who an account is signed in as after a login, read back from its `.claude.json`. */
export type AccountLoginResult = { email: string | null; accountUuid: string | null }

/**
 * Signs a Claude account in again with `claude auth login --claudeai`, under its own config dir,
 * opening the authorization page in the account's Chrome profile (none: the default browser,
 * which may be signed in to another account). Resolves once the user authorized it; rejects with
 * `account_mismatch: <e-mail>` when it ended up on another account than `email`, or
 * `login_timeout`, `login_failed: ...`, `account_busy`, `claude_not_found`.
 */
export function claudeAccountLogin(args: {
  accountId: string
  /** Expected e-mail; '' or null logs in without `--email`. */
  email?: string | null
  chromeProfile?: string | null
}): Promise<AccountLoginResult> {
  return invoke<AccountLoginResult>('claude_account_login', {
    accountId: args.accountId,
    email: args.email || null,
    chromeProfile: args.chromeProfile || null,
  })
}
