import { create } from 'zustand'

import { accountRefs } from '../../../lib/claudeAccounts'
import { type McpSyncResult,syncAccountMcpServers } from '../../../lib/tauri/accountMcp'
import {
  type ClaudeAccountIdentity,
  orchestraAccountIdentities,
} from '../../../lib/tauri/orchestra'
import { type ClaudeUsage, getAllAccountsUsage, getClaudeUsage } from '../../../lib/tauri/usage'
import type { ClaudeAccount } from '../../../lib/types'

/** Key used for the default account (`~/.claude`), which has no account id. */
export const DEFAULT_ACCOUNT_KEY = ''

export type AccountUsageRow = {
  /** Account id, or DEFAULT_ACCOUNT_KEY for the default account. */
  id: string
  name: string | null
  usage: ClaudeUsage | null
  error: string | null
  /** When `usage` was read (epoch ms); null when unknown. */
  fetchedAt?: number | null
  /** Set while `usage` is an older value the API refused to renew (429). */
  staleSince?: number | null
  /** While the backend backs off: the earliest next read (epoch ms). */
  retryAt?: number | null
}

type UsageState = {
  rows: AccountUsageRow[]
  loading: boolean
  fetchedAt: number
  /** Real sign-in of each account folder by account id (DEFAULT_ACCOUNT_KEY: the default). */
  identities: Record<string, ClaudeAccountIdentity>
  /** `force` is the refresh button: the backend cache is skipped, its 429 backoff is not. */
  refresh: (accounts: ClaudeAccount[], force?: boolean) => Promise<void>
  /** Copies default MCP servers into the given accounts. */
  syncMcp: (accounts: ClaudeAccount[]) => Promise<McpSyncResult[]>
}

/** Usage is polled at most this often; limits move slowly and the API is rate limited. */
export const USAGE_TTL_MS = 5 * 60_000

let inFlight: Promise<void> | null = null

export const useUsageStore = create<UsageState>((set) => ({
  rows: [],
  loading: false,
  fetchedAt: 0,
  identities: {},

  refresh: async (accounts, force = false) => {
    if (inFlight) return inFlight
    set({ loading: true })
    inFlight = (async () => {
      const refs = await accountRefs(accounts).catch(() => [])
      const [main, linked, identities] = await Promise.all([
        getClaudeUsage(force).then(
          (usage) => ({ usage, error: null }),
          (error: unknown) => ({ usage: null, error: String(error) }),
        ),
        getAllAccountsUsage(refs, force).catch(() => []),
        // File reads only: who each folder is really signed in as.
        orchestraAccountIdentities([{ id: DEFAULT_ACCOUNT_KEY, config_dir: '' }, ...refs]).catch(
          () => [],
        ),
      ])
      const byId = new Map(linked.map((row) => [row.id, row]))
      const rows: AccountUsageRow[] = [
        { id: DEFAULT_ACCOUNT_KEY, name: null, usage: main.usage, error: main.error },
        ...accounts.map((account) => {
          const row = byId.get(account.id)
          return {
            id: account.id,
            name: account.name,
            usage: row?.usage ?? null,
            error: row ? row.error : 'unavailable',
            fetchedAt: row?.fetched_at ?? null,
            staleSince: row?.stale_since ?? null,
            retryAt: row?.retry_at ?? null,
          }
        }),
      ]
      set({
        rows,
        fetchedAt: Date.now(),
        identities: Object.fromEntries(identities.map((identity) => [identity.id, identity])),
      })
    })().finally(() => {
      inFlight = null
      set({ loading: false })
    })
    return inFlight
  },

  syncMcp: async (accounts) => syncAccountMcpServers(await accountRefs(accounts)),
}))

/** Highest utilization (0-100) across the 5h and weekly windows, or null without data. */
export function peakUtilization(usage: ClaudeUsage | null): number | null {
  if (!usage) return null
  return Math.max(usage.five_hour?.utilization ?? 0, usage.seven_day?.utilization ?? 0)
}

/** Severity bucket used for bar colors. */
export function usageLevel(pct: number | null): 'ok' | 'warn' | 'hot' | 'none' {
  if (pct === null) return 'none'
  if (pct >= 90) return 'hot'
  if (pct >= 70) return 'warn'
  return 'ok'
}

/** Compact "2h10" / "3d" relative reset label; empty when unknown. */
export function resetLabel(resetsAt: string | undefined, now = Date.now()): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}`
  return `${Math.round(hours / 24)}d`
}
