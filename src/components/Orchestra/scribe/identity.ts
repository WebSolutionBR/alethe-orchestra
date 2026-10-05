/**
 * Who the scribe is on the bus. Pure helpers, safe to import from the store and the views.
 */

/** Bus id of the Obsidian scribe: a fixed role, never a worker and never given a PTY. */
export const SCRIBE_ID = 'obsidian'

/**
 * The scribe's bus lines go to the note it wrote. Agent ids never contain a dot, so a
 * `.md` target can only be one of its notes.
 */
export function isScribeNote(id: string): boolean {
  return /\.md$/i.test(id)
}

/** True for both ends of a scribe bus line. */
export function isScribeParty(id: string): boolean {
  return id === SCRIBE_ID || isScribeNote(id)
}

/** File name of a vault-relative note: the target shown on the bus. */
export function noteFileName(notePath: string): string {
  return notePath.split('/').pop() || notePath
}

/** Last folder of the vault path: the vault name Obsidian shows and `obsidian://open` expects. */
export function vaultName(vaultPath: string): string {
  return (
    vaultPath
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

/** `obsidian://open` link for a note of the vault; null while no vault is set. */
export function obsidianOpenUri(vaultPath: string, notePath: string): string | null {
  const vault = vaultName(vaultPath)
  if (!vault || !notePath) return null
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(notePath)}`
}

/** Absolute path of a vault-relative note, with the vault's own separator. */
export function noteFilePath(vaultPath: string, notePath: string): string {
  const base = vaultPath.trim().replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${notePath.split('/').join(sep)}`
}
