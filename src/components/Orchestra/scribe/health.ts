/**
 * Pure decisions behind the scribe's health: which vault to pick on its own, why it cannot
 * write, and the state its chip shows.
 */
import type { ObsidianStatus, ObsidianVault } from './api'

/** Why the scribe cannot write right now. */
export type ScribeIssue =
  /** Obsidian has no vault registered (or is not installed). */
  | 'no-vault'
  /** Several vaults and none open: only the user can choose. */
  | 'pick-vault'
  /** The configured vault folder does not exist. */
  | 'vault-missing'
  /** The Local REST API plugin is not installed in the vault. */
  | 'plugin-missing'
  /** The plugin has no API key in its config. */
  | 'no-key'
  /** Obsidian is closed, the plugin is off or it timed out. */
  | 'unreachable'
  /** The plugin answered but refused the key. */
  | 'rejected'

export const SCRIBE_ISSUES: ScribeIssue[] = [
  'no-vault',
  'pick-vault',
  'vault-missing',
  'plugin-missing',
  'no-key',
  'unreachable',
  'rejected',
]

/** The open vault first, else the only one; several closed vaults are the user's call. */
export function pickVault(vaults: ObsidianVault[]): string | null {
  const open = vaults.find((vault) => vault.open && vault.path.trim())
  if (open) return open.path
  return vaults.length === 1 && vaults[0].path.trim() ? vaults[0].path : null
}

/** The issue `obsidianStatus` reports, or null when the plugin accepted the key. */
export function issueFromStatus(status: ObsidianStatus): ScribeIssue | null {
  if (status.authenticated) return null
  if (!status.vault_exists) return 'vault-missing'
  if (!status.plugin_found) return 'plugin-missing'
  if (!status.has_key) return 'no-key'
  return /reject/i.test(status.error ?? '') ? 'rejected' : 'unreachable'
}

export type ScribeState = 'off' | 'failing' | 'writing' | 'pending' | 'scheduled' | 'listening'

export const SCRIBE_STATES: ScribeState[] = [
  'off',
  'failing',
  'writing',
  'pending',
  'scheduled',
  'listening',
]

/** What the author of a session is doing, as far as the chip cares. */
export type AuthorActivity =
  'idle' | 'scheduled' | 'queued' | 'writing' | 'saving' | 'ready' | 'failed'

/**
 * What the chip shows: off, failing (with a reason), writing (a note or the queue), N writes
 * pending, a note scheduled, or listening.
 */
export function scribeState(input: {
  enabled: boolean
  issue: ScribeIssue | null
  sending: boolean
  pending: number
  failures: number
  author?: AuthorActivity
}): ScribeState {
  if (!input.enabled) return 'off'
  if (input.issue || input.failures > 0 || input.author === 'failed') return 'failing'
  if (input.sending || input.author === 'writing' || input.author === 'saving') return 'writing'
  if (input.pending > 0) return 'pending'
  if (input.author === 'scheduled' || input.author === 'queued') return 'scheduled'
  return 'listening'
}

/** Theme token of a scribe state; listening and writing wear Obsidian's purple. */
export function scribeStateColor(state: ScribeState): string {
  switch (state) {
    case 'failing':
      return 'var(--status-waiting)'
    case 'off':
      return 'var(--fg-faint)'
    default:
      return 'var(--agent-obsidian)'
  }
}
