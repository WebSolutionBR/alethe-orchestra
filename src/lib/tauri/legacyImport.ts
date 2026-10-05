import { invoke } from '@tauri-apps/api/core'

export type LegacyMarker = {
  imported_at: number | null
  last_sync_at: number | null
  source_dir: string | null
}

export type LegacyStatus = {
  available: boolean
  source_dir: string | null
  profile_id: string | null
  marker: LegacyMarker
}

export type AccountCopyResult = {
  id: string
  found: boolean
  files_copied: number
  error: string | null
}

export function legacyAletheStatus(): Promise<LegacyStatus> {
  return invoke<LegacyStatus>('legacy_alethe_status')
}

export function legacyAletheReadProjects(): Promise<string | null> {
  return invoke<string | null>('legacy_alethe_read_projects')
}

export function legacyAletheCopyAccounts(
  ids: string[],
  refresh: boolean,
): Promise<AccountCopyResult[]> {
  return invoke<AccountCopyResult[]>('legacy_alethe_copy_accounts', { ids, refresh })
}

export function legacyAletheMark(first: boolean): Promise<LegacyMarker> {
  return invoke<LegacyMarker>('legacy_alethe_mark', { first })
}
