import { invoke } from '@tauri-apps/api/core'

/**
 * Saves an export (.md, .json or .txt) to an absolute path the user picked in the native save
 * dialog, creating or replacing the file. The backend refuses anything else.
 */
export async function saveTextFile(path: string, content: string): Promise<void> {
  await invoke('save_text_file', { path, content })
}
