import type { ClaudeAccountIdentity } from '../../../lib/tauri/orchestra'
import type { ClaudeUsage } from '../../../lib/tauri/usage'
import type { ClaudeAccount } from '../../../lib/types'
import type { OrchestraAgent } from '../../../stores/orchestraStore'
import { agentLaunch, type SessionLaunch } from '../usage/launch'
import { type AccountUsageRow, DEFAULT_ACCOUNT_KEY } from '../usage/usageStore'

/** 5h usage at which an account counts as near its limit (panel and rail warn). */
export const NEAR_LIMIT_PCT = 90

/** Key of an account in maps: its id, or DEFAULT_ACCOUNT_KEY for the default account. */
export function accountKey(account: string | null | undefined): string {
  return account || DEFAULT_ACCOUNT_KEY
}

/**
 * Linked accounts signed in as the same Claude account (same `accountUuid`): by account id,
 * the other ids that share it. Two folders on one account make a "spread" an illusion and
 * spend one quota (the case of 06/10/2026). The default account is left out: it is normally
 * one of the linked accounts.
 */
export function duplicateAccounts(
  accounts: ClaudeAccount[],
  identities: Record<string, ClaudeAccountIdentity>,
): Map<string, string[]> {
  const byUuid = new Map<string, string[]>()
  for (const account of accounts) {
    const uuid = identities[account.id]?.account_uuid
    if (!uuid) continue
    byUuid.set(uuid, [...(byUuid.get(uuid) ?? []), account.id])
  }
  const out = new Map<string, string[]>()
  for (const ids of byUuid.values()) {
    if (ids.length < 2) continue
    for (const id of ids)
      out.set(
        id,
        ids.filter((other) => other !== id),
      )
  }
  return out
}

/** The account's expected e-mail differs from the one it is really signed in as. */
export function emailMismatch(
  account: Pick<ClaudeAccount, 'email'>,
  identity: ClaudeAccountIdentity | undefined,
): boolean {
  const expected = account.email?.trim().toLowerCase()
  const real = identity?.email?.trim().toLowerCase()
  return Boolean(expected && real && expected !== real)
}

/** Whether an agent's process is (or is about to be) running: it holds a slot on an account. */
function holdsAccount(agent: OrchestraAgent): boolean {
  return agent.state !== 'exited' && agent.state !== 'waiting' && Boolean(agent.launchedWith)
}

/** The account an agent runs on: the one its process started with, else where it would start. */
export function agentAccount(agent: OrchestraAgent, launch: SessionLaunch): string | null {
  return agent.launchedWith ? agent.launchedWith.account : agentLaunch(agent, launch).account
}

/** Running agents by account key (see `accountKey`). */
export function agentsByAccount(
  agents: OrchestraAgent[],
  launch: SessionLaunch,
): Map<string, OrchestraAgent[]> {
  const out = new Map<string, OrchestraAgent[]>()
  for (const agent of agents) {
    if (!holdsAccount(agent)) continue
    const key = accountKey(agentAccount(agent, launch))
    out.set(key, [...(out.get(key) ?? []), agent])
  }
  return out
}

/** Running agents not on the session's account: the ones "restart on the new account" moves. */
export function agentsOffAccount(
  agents: OrchestraAgent[],
  launch: SessionLaunch,
): OrchestraAgent[] {
  return agents.filter(
    (agent) =>
      holdsAccount(agent) && accountKey(agentAccount(agent, launch)) !== accountKey(launch.account),
  )
}

export function nearLimit(usage: ClaudeUsage | null | undefined): boolean {
  return (usage?.five_hour?.utilization ?? 0) >= NEAR_LIMIT_PCT
}

/**
 * When an account at its limit frees up: the reset of the window (5h or weekly) that is full,
 * the later one when both are. Null while it still has room or without data.
 */
export function limitedUntil(usage: ClaudeUsage | null | undefined): number | null {
  if (!usage) return null
  let until: number | null = null
  for (const window of [usage.five_hour, usage.seven_day]) {
    if (!window || window.utilization < 100) continue
    const at = Date.parse(window.resets_at)
    if (Number.isFinite(at)) until = until === null ? at : Math.max(until, at)
  }
  return until
}

/** What a card without usage says, and the action it offers. */
export type CardError =
  | { kind: 'login' }
  | { kind: 'rateLimited'; retryAt: number | null }
  | { kind: 'signedOut' }
  | { kind: 'unavailable' }

/**
 * One message per usage error: an expired sign-in or token needs a new login (the card puts
 * "Sign in" first), a 429 says when the next read happens, `no_token` was never signed in.
 * Null when the row has no error.
 */
export function cardError(
  row: Pick<AccountUsageRow, 'error' | 'retryAt'> | null | undefined,
): CardError | null {
  const error = row?.error
  if (!error) return null
  if (error === 'login_expired' || error === 'token_expired') return { kind: 'login' }
  if (error === 'rate_limited') return { kind: 'rateLimited', retryAt: row?.retryAt ?? null }
  if (error === 'no_token') return { kind: 'signedOut' }
  return { kind: 'unavailable' }
}

/** Why switching the session to an account deserves a confirmation. */
export type SwitchRisk = 'error' | 'near' | 'duplicate'

/**
 * The risks of making this account the session's: it has an error (no usage could be read),
 * it is at NEAR_LIMIT_PCT or more on the 5h or the weekly window, or it is signed in to the
 * same Claude account as another one. Empty: switch without asking.
 */
export function switchRisks(
  row: Pick<AccountUsageRow, 'usage' | 'error'> | null | undefined,
  duplicates: string[],
): SwitchRisk[] {
  const risks: SwitchRisk[] = []
  if (row?.error && !row.usage) risks.push('error')
  const usage = row?.usage
  if (
    (usage?.five_hour?.utilization ?? 0) >= NEAR_LIMIT_PCT ||
    (usage?.seven_day?.utilization ?? 0) >= NEAR_LIMIT_PCT
  )
    risks.push('near')
  if (duplicates.length > 0) risks.push('duplicate')
  return risks
}

/**
 * When the session account's limit resets, for the limit strip: the full window's reset from
 * the usage cache, else its 5h reset, else (the usage API is often 429 right then) the latest
 * `blocked.resetAt` the screen classifier read on the agents stopped by the limit. Null when
 * no source has it.
 */
export function limitResetAt(
  usage: ClaudeUsage | null | undefined,
  blockedResets: (number | null | undefined)[],
  now: number,
): number | null {
  const until = limitedUntil(usage)
  if (until !== null && until > now) return until
  const fiveHour = Date.parse(usage?.five_hour?.resets_at ?? '')
  if (Number.isFinite(fiveHour) && fiveHour > 0) return fiveHour
  let latest: number | null = null
  for (const at of blockedResets)
    if (typeof at === 'number' && Number.isFinite(at) && at > 0)
      latest = latest === null ? at : Math.max(latest, at)
  return latest
}

/** MAX_LIMIT_REARMS: how many times a wait is armed again when the limit comes straight back. */
export const MAX_LIMIT_REARMS = 3

/**
 * Which "waiting" text the limit strip shows: armed again after the limit came back (with the
 * attempt), armed by itself on the first agent stopped by the limit, or by the Wait button.
 */
export function waitingText(wait: {
  auto?: boolean
  rearms?: number
}):
  | { key: 'orchestra.limit.rearmed'; count: number }
  | { key: 'orchestra.limit.waitingAuto' }
  | { key: 'orchestra.limit.waiting' } {
  const rearms = wait.rearms ?? 0
  if (rearms > 0)
    return { key: 'orchestra.limit.rearmed', count: Math.min(rearms, MAX_LIMIT_REARMS) }
  if (wait.auto) return { key: 'orchestra.limit.waitingAuto' }
  return { key: 'orchestra.limit.waiting' }
}
