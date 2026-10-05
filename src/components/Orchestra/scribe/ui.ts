/**
 * UI actions shared by the scribe chip and the scribe marks in the views: which panel is
 * open, opening today's note and jumping to the scribe settings.
 */
import { create } from 'zustand'

import { openInBrowser } from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import { getScribeConfig, notePathFor } from './config'
import { noteFilePath, obsidianOpenUri } from './identity'

/** `data-setting-id` of the scribe section in Preferences → Integrations. */
export const SCRIBE_SETTINGS_ID = 'obsidian-scribe'

const SESSION_PREFIX = 'session:'

type ScribePanelState = {
  /** A chip's own key, or `session:<id>` when a view asked for the chip of that session. */
  open: string | null
  toggle: (key: string) => void
  close: () => void
}

export const useScribePanel = create<ScribePanelState>((set) => ({
  open: null,
  toggle: (key) => set((s) => ({ open: s.open === key ? null : key })),
  close: () => set({ open: null }),
}))

/** Opens the scribe panel from a view mark; the chip showing that session answers. */
export function openScribePanel(sessionId: string): void {
  useScribePanel.setState({ open: `${SESSION_PREFIX}${sessionId}` })
}

/** Whether the chip `key` (shown for `sessionId`, if any) owns the open panel. */
export function panelOpenFor(open: string | null, key: string, sessionId: string | null): boolean {
  if (!open) return false
  if (open === key) return true
  if (!open.startsWith(SESSION_PREFIX)) return false
  return sessionId === null || open === `${SESSION_PREFIX}${sessionId}`
}

export function openScribeSettings(): void {
  useScribePanel.getState().close()
  useUiStore
    .getState()
    .openModal_('preferences', { category: 'integrations', focus: SCRIBE_SETTINGS_ID })
}

/**
 * Opens a note of the vault in Obsidian (today's agents' note by default). When the
 * `obsidian://` link cannot be opened, the note file opens with its default app instead.
 * Resolves false when neither worked.
 */
export async function openScribeNote(note?: string | null): Promise<boolean> {
  const config = getScribeConfig()
  const vault = config.vaultPath.trim()
  if (!vault) return false
  const notePath = note?.trim() || notePathFor(config)
  const uri = obsidianOpenUri(vault, notePath)
  if (uri) {
    try {
      await openInBrowser(uri)
      return true
    } catch {
      // Fall through to the file itself.
    }
  }
  try {
    await openInBrowser(noteFilePath(vault, notePath))
    return true
  } catch {
    return false
  }
}
