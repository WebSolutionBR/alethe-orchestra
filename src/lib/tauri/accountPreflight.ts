import { invoke } from '@tauri-apps/api/core'

/** `ensure_account_ready` before an agent's PTY opens (see account_preflight.rs). */
export type PreflightStatus = 'ready' | 'no_login' | 'login_expired' | 'account_mismatch'

export type Preflight = {
  status: PreflightStatus
  email: string | null
  account_uuid: string | null
  expected_email: string | null
  refreshed: boolean
  seed_errors: string[]
}

/**
 * Trusts `folders` in the agent's account (`configDir`, null for the default one) and in the
 * accounts of `alsoSeed` ('' is the default one), renews an expired token and checks the
 * account is still the expected one.
 */
export function accountPreflight(args: {
  configDir: string | null
  expectedEmail?: string | null
  folders: string[]
  alsoSeed?: string[]
}): Promise<Preflight> {
  return invoke<Preflight>('account_preflight', {
    configDir: args.configDir,
    expectedEmail: args.expectedEmail || null,
    folders: args.folders,
    alsoSeed: args.alsoSeed ?? [],
  })
}

/**
 * Trusts `folders` in the accounts at `configDirs` ('' is the default one) and, with
 * `onboarding`, marks their first-run onboarding done. Resolves with one error per account that
 * could not be seeded.
 */
export function accountTrustSeed(
  configDirs: string[],
  folders: string[],
  onboarding: boolean,
): Promise<string[]> {
  return invoke<string[]>('account_trust_seed', { configDirs, folders, onboarding })
}
