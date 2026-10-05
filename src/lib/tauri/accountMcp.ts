import { invoke } from '@tauri-apps/api/core'

import type { ClaudeAccountRef } from './usage'

/** Outcome for one account; `error` is set when it was skipped (e.g. `no_config_dir`). */
export type McpSyncResult = {
  id: string
  added: string[]
  error: string | null
}

/**
 * Copies the default account's user-scope MCP servers (`~/.claude.json`) into
 * each account's own `.claude.json`. Only missing servers are added.
 */
export async function syncAccountMcpServers(
  accounts: ClaudeAccountRef[],
): Promise<McpSyncResult[]> {
  return invoke<McpSyncResult[]>('sync_account_mcp_servers', { accounts })
}
