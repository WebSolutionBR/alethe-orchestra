/**
 * Session Resume — persiste sessions ativas no localStorage para
 * retomar agentes automaticamente ao reabrir o app.
 */

import { normalizeCwd } from './platform'
import { readScopedStorage, writeScopedStorage } from './storageNamespace'

const STORAGE_KEY = 'active-sessions'

export type SavedSession = {
  sessionId: string
  /** Claude conversation ID (nome do JSONL, ex: "abc123-def456"). */
  claudeSessionId?: string
  /** Codex conversation ID (payload.id do session_meta em ~/.codex/sessions). */
  codexSessionId?: string
  /** OpenCode session ID (ses_... do opencode session list). */
  opencodeSessionId?: string
  /** Antigravity conversation ID (conversation_metadata.json). */
  antigravitySessionId?: string
  cwd: string
  agent: string
  timestamp: number
}

export type ActiveSessions = Record<string, SavedSession>

export function savedConversationIdFor(
  session: SavedSession | null,
  agent: string | null | undefined,
  cwd: string | null | undefined,
): string | undefined {
  if (!session || !agent || !cwd) return undefined
  if (session.agent !== agent) return undefined
  if (normalizeCwd(session.cwd) !== normalizeCwd(cwd)) return undefined
  if (agent === 'claude') return session.claudeSessionId
  if (agent === 'codex') return session.codexSessionId
  if (agent === 'antigravity') return session.antigravitySessionId
  if (agent === 'opencode') return session.opencodeSessionId
  return undefined
}

export function getActiveSessions(): ActiveSessions {
  try {
    const raw = readScopedStorage(STORAGE_KEY, true)
    if (!raw) return {}
    const sessions = JSON.parse(raw) as ActiveSessions
    return sessions
  } catch {
    return {}
  }
}

export function saveSession(ptyId: string, session: SavedSession): void {
  const current = getActiveSessions()
  current[ptyId] = session
  writeScopedStorage(STORAGE_KEY, JSON.stringify(current))
}

export function removeSession(ptyId: string): void {
  const current = getActiveSessions()
  delete current[ptyId]
  writeScopedStorage(STORAGE_KEY, JSON.stringify(current))
}

/**
 * Reads the saved session without dropping it. The record must survive a launch that never
 * reaches `saveSession` — an aborted spawn would otherwise leave the pane with no conversation to
 * resume. Callers that decide the resume is unusable remove it explicitly.
 */
export function peekSession(ptyId: string): SavedSession | null {
  return getActiveSessions()[ptyId] ?? null
}

/**
 * The directory a pane's conversations belong to.
 *
 * A pane with no directory configured still runs somewhere: the child process
 * inherits the app's own working directory, and the agent files its session
 * under that. Treating the empty string as "no directory" switched off every
 * check that guards a resume, which is how a pane ended up asking the agent to
 * resume a conversation that no longer existed.
 */
export function sessionScopeCwd(paneCwd: string | null | undefined, fallback: string): string {
  return paneCwd?.trim() || fallback
}

export type ResumeChoice =
  { kind: 'saved'; id: string } | { kind: 'mostRecent' } | { kind: 'fresh' }

/**
 * Decides what a pane should reopen.
 *
 * A saved id that the agent no longer knows about makes it refuse to start —
 * "No conversation found with session ID". When that happens the newest
 * conversation of the same directory is taken instead, which is what a person
 * does by hand. A pane that never had a conversation is never given one:
 * otherwise a fresh pane would adopt whatever ran there last, and several panes
 * sharing a directory would all adopt the same one.
 */
export function chooseResume(
  savedId: string | undefined,
  knownIds: readonly string[],
): ResumeChoice {
  if (!savedId) return { kind: 'fresh' }
  if (knownIds.includes(savedId)) return { kind: 'saved', id: savedId }
  return knownIds.length > 0 ? { kind: 'mostRecent' } : { kind: 'fresh' }
}
