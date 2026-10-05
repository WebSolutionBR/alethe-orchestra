/**
 * Drafts typed in the Orchestra: the box under each agent (drawer and Hive panel share it), the
 * quick bus field and the message composer with its attachments and target. They outlive view
 * and session switches (components unmount, this store does not), are saved to localStorage
 * after a short pause, and are cleared once sent or when their session ends.
 */
import { useCallback } from 'react'
import { create } from 'zustand'

import type { Attachment, ComposerDraft } from './Composer/attachments'

export const DRAFTS_KEY = 'orchestra.drafts'
const SAVE_DELAY_MS = 400
/** Drafts nobody touched for this long are dropped when the app loads. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type Draft = {
  text: string
  attachments: Attachment[]
  /** Composer only: the agent the message goes to. */
  target?: string
  at: number
}

export const draftKey = {
  /** The message box of one agent (agent drawer, Hive panel). */
  agent: (sessionId: string, agentId: string) => `agent:${sessionId}:${agentId}`,
  /** Mission control's quick field to the orchestrator. */
  quick: (sessionId: string) => `quick:${sessionId}`,
  composer: (sessionId: string) => `composer:${sessionId}`,
}

type DraftsState = {
  drafts: Record<string, Draft>
  put: (key: string, patch: Partial<Omit<Draft, 'at'>>) => void
  clear: (key: string) => void
  clearSession: (sessionId: string) => void
}

function load(): Record<string, Draft> {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? 'null') as unknown
    if (!saved || typeof saved !== 'object') return {}
    const now = Date.now()
    const out: Record<string, Draft> = {}
    for (const [key, value] of Object.entries(saved as Record<string, Partial<Draft>>)) {
      if (!value || typeof value.text !== 'string' || typeof value.at !== 'number') continue
      if (now - value.at > MAX_AGE_MS) continue
      out[key] = {
        text: value.text,
        attachments: Array.isArray(value.attachments) ? value.attachments : [],
        ...(typeof value.target === 'string' ? { target: value.target } : {}),
        at: value.at,
      }
    }
    return out
  } catch {
    // Unreadable storage just means no saved drafts.
    return {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Writes the drafts after a pause; in-memory previews of pasted images do not survive a reload. */
function scheduleSave(drafts: Record<string, Draft>): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const stored: Record<string, Draft> = {}
    for (const [key, draft] of Object.entries(drafts)) {
      stored[key] = {
        ...draft,
        attachments: draft.attachments.map(({ previewUrl: _preview, ...rest }) => rest),
      }
    }
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(stored))
    } catch {
      // Non-persistent storage keeps the drafts for this run only.
    }
  }, SAVE_DELAY_MS)
}

const isEmpty = (draft: Draft) => !draft.text && draft.attachments.length === 0

export const useDrafts = create<DraftsState>((set, get) => ({
  drafts: load(),
  put: (key, patch) => {
    const current = get().drafts[key] ?? { text: '', attachments: [], at: 0 }
    const next: Draft = { ...current, ...patch, at: Date.now() }
    const drafts = { ...get().drafts }
    if (isEmpty(next) && next.target === undefined) delete drafts[key]
    else drafts[key] = next
    set({ drafts })
    scheduleSave(drafts)
  },
  clear: (key) => {
    if (!get().drafts[key]) return
    const drafts = { ...get().drafts }
    delete drafts[key]
    set({ drafts })
    scheduleSave(drafts)
  },
  clearSession: (sessionId) => {
    const drafts = { ...get().drafts }
    let changed = false
    for (const key of Object.keys(drafts)) {
      if (key.split(':')[1] === sessionId) {
        delete drafts[key]
        changed = true
      }
    }
    if (!changed) return
    set({ drafts })
    scheduleSave(drafts)
  },
}))

/** Text draft under `key`: what a plain input keeps while the user is away. */
export function useDraftText(key: string): [string, (text: string) => void] {
  const text = useDrafts((s) => s.drafts[key]?.text ?? '')
  const setText = useCallback(
    (value: string) => useDrafts.getState().put(key, { text: value }),
    [key],
  )
  return [text, setText]
}

const EMPTY_ATTACHMENTS: Attachment[] = []

/** The composer's draft (text and attachments) of a session. */
export function useComposerDraft(
  sessionId: string,
): [ComposerDraft, (draft: ComposerDraft) => void] {
  const key = draftKey.composer(sessionId)
  const text = useDrafts((s) => s.drafts[key]?.text ?? '')
  const attachments = useDrafts((s) => s.drafts[key]?.attachments ?? EMPTY_ATTACHMENTS)
  const setDraft = useCallback(
    (draft: ComposerDraft) =>
      useDrafts.getState().put(key, { text: draft.text, attachments: draft.attachments }),
    [key],
  )
  return [{ text, attachments }, setDraft]
}

/** Drops every draft of a session that ended. */
export function clearSessionDrafts(sessionId: string): void {
  useDrafts.getState().clearSession(sessionId)
}
