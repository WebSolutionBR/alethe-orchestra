/**
 * Pure helpers for what the Orchestra writes into agent terminals and reads back from their
 * hooks: safe text for a bracketed paste, code-point chunks, delivery probes and what a Claude
 * Code notification means. Kept apart from the store so they can be tested on their own.
 */
import type { OrchestraHookSummary } from '../../lib/tauri/orchestra'

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
/** Longest write sent to a PTY in one call, in UTF-16 code units. */
export const PASTE_CHUNK = 900

/** C0 controls (tab and newline excepted), DEL and C1: an ESC in relayed text becomes a key. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * Text that is safe inside a bracketed paste: line breaks normalized to `\n`, and every other
 * control character removed, so relayed text can neither end the paste early (`ESC [201~`) nor
 * type keys into the agent.
 */
export function sanitizeRelay(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
}

/** Splits `text` into pieces of at most `size` code units without cutting a surrogate pair. */
export function chunkByCodePoint(text: string, size = PASTE_CHUNK): string[] {
  const chunks: string[] = []
  let current = ''
  for (const char of text) {
    if (current.length + char.length > size && current) {
      chunks.push(current)
      current = ''
    }
    current += char
  }
  if (current) chunks.push(current)
  return chunks
}

/** Collapses whitespace, so a pasted message and the prompt Claude Code reports compare equal. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Characters of a pasted message compared with the prompt a `UserPromptSubmit` hook reports. */
const PROBE_LENGTH = 60

/** The start of a message as the agent will see it, to recognize it in its next prompt. */
export function deliveryProbe(pasted: string): string {
  return normalizeText(sanitizeRelay(pasted)).slice(0, PROBE_LENGTH)
}

/**
 * Index of the newest awaited message the submitted prompt contains, or -1. Input reaches an
 * agent in order, so every older awaited message was submitted too (Claude Code can join queued
 * messages into one prompt, and the hook only reports its start).
 */
export function deliveredUpTo(probes: readonly string[], prompt: string | undefined): number {
  const submitted = normalizeText(prompt ?? '')
  if (!submitted) return -1
  for (let i = probes.length - 1; i >= 0; i--) {
    if (probes[i] && submitted.includes(probes[i])) return i
  }
  return -1
}

/** What a Claude Code `Notification` hook asks of the user. */
export type NotificationKind = 'permission' | 'question' | 'idle' | 'info'

/**
 * `permission`: a tool waits for approval; `question`: a dialog asks the user something; `idle`:
 * the turn ended and the prompt waits (not a block); `info`: nothing to do. Older Claude Code
 * builds send no `notification_type`, so the message decides, and anything unknown is treated
 * as a question rather than silently ignored.
 */
export function notificationKind(hook: OrchestraHookSummary): NotificationKind {
  switch (hook.notification_type) {
    case 'permission_prompt':
      return 'permission'
    case 'idle_prompt':
      return 'idle'
    case 'elicitation_dialog':
      return 'question'
    case 'auth_success':
      return 'info'
  }
  const message = (hook.message ?? '').toLowerCase()
  if (message.includes('waiting for your input')) return 'idle'
  if (message.includes('permission')) return 'permission'
  return 'question'
}

/** Single-line preview for notices, clipped to `max` characters. */
export function clipLine(text: string, max = 160): string {
  const line = normalizeText(text)
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
