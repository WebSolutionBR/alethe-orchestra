import { invoke } from '@tauri-apps/api/core'

export type ObsidianVault = { path: string; open: boolean }

export type ObsidianStatus = {
  vault_exists: boolean
  plugin_found: boolean
  has_key: boolean
  port: number
  authenticated: boolean
  error: string | null
}

/** The API key is read from the vault's Local REST API plugin config by the backend. */
export type ObsidianTarget = { vaultPath: string; port?: number }

export function obsidianDetectVaults(): Promise<ObsidianVault[]> {
  return invoke<ObsidianVault[]>('obsidian_detect_vaults')
}

export function obsidianStatus(target: ObsidianTarget): Promise<ObsidianStatus> {
  return invoke<ObsidianStatus>('obsidian_status', { target })
}

export function obsidianAppend(
  target: ObsidianTarget,
  notePath: string,
  content: string,
): Promise<void> {
  return invoke('obsidian_append', { target, notePath, content })
}

export type ObsidianSearchHit = {
  /** Vault-relative path of the note. */
  filename: string
  /** The plugin's score; hits keep its order, best first. */
  score: number
  match_count: number
  /** The first few matches with the text around them. */
  contexts: string[]
}

export type ObsidianSearchResult = {
  /** Notes that matched, before the backend kept the best 40. */
  total: number
  hits: ObsidianSearchHit[]
}

export type ObsidianNote = {
  path: string
  content: string
  /** Bytes of the whole note. */
  size: number
  /** Longer than 200 KB: `content` is the head, or the tail when asked. */
  truncated: boolean
}

/** Local REST API simple search: every word of `query` must appear in the note. */
export function obsidianSearch(
  target: ObsidianTarget,
  query: string,
  contextLength?: number,
): Promise<ObsidianSearchResult> {
  return invoke<ObsidianSearchResult>('obsidian_search', { target, query, contextLength })
}

/** Markdown of a vault-relative note; rejects with "note not found" when it does not exist. */
export function obsidianRead(
  target: ObsidianTarget,
  notePath: string,
  tail = false,
): Promise<ObsidianNote> {
  return invoke<ObsidianNote>('obsidian_read', { target, notePath, tail })
}

/** Entries of a vault folder ('' = root); subfolders end with `/`, a missing folder is empty. */
export function obsidianList(target: ObsidianTarget, dir: string): Promise<string[]> {
  return invoke<string[]>('obsidian_list', { target, dir })
}

/** Saves a session's Obsidian context to a temp file the agents read; resolves to its path. */
export function obsidianWriteContext(sessionId: string, markdown: string): Promise<string> {
  return invoke<string>('obsidian_write_context', { sessionId, markdown })
}

export function obsidianRemoveContext(sessionId: string): Promise<void> {
  return invoke('obsidian_remove_context', { sessionId })
}

/** Creates or replaces a whole note; the scribe only does it to notes it created itself. */
export function obsidianPut(
  target: ObsidianTarget,
  notePath: string,
  content: string,
): Promise<void> {
  return invoke('obsidian_put', { target, notePath, content })
}

export type ObsidianPatchOutcome = {
  applied: boolean
  /** The section already had this text (a retried write): nothing was added. */
  preexisting: boolean
}

/**
 * Appends markdown under a heading; `heading` is the path from the note's top heading. The
 * heading is created when missing, and text already in the section is never added twice.
 */
export function obsidianPatchHeading(
  target: ObsidianTarget,
  notePath: string,
  heading: string[],
  content: string,
): Promise<ObsidianPatchOutcome> {
  return invoke<ObsidianPatchOutcome>('obsidian_patch_heading', {
    target,
    notePath,
    heading,
    content,
  })
}

/* ------------------------------------------------------------- scribe author runner */

/** A transcript of one of the session's agents; `name` is the agent id. */
export type ScribeAuthorFile = { name: string; path: string }

export type ScribeAuthorRequest = {
  /** 1-40 of `a-z0-9-`; names the run folder and lets it be cancelled. */
  runId: string
  /** The orchestration the run writes about. */
  sessionId: string
  /** Sent through stdin, never on the command line. */
  prompt: string
  model?: string | null
  effort?: string | null
  /** `CLAUDE_CONFIG_DIR` of the account; null runs the CLI's default account. */
  configDir?: string | null
  vaultPath: string
  /** The session's project folder: task files are only accepted from it. */
  sessionFolder?: string | null
  /** Linked into the author's folder as `transcripts/<name>.jsonl`; the only ones it reads. */
  transcripts?: ScribeAuthorFile[]
  /** The session's task files, copied into the author's folder under `tarefas/`. */
  sources?: string[]
  timeoutSecs?: number
  maxTurns?: number
  /** Spending ceiling of the run, in US dollars; 0 leaves it to the CLI. */
  maxBudgetUsd?: number
}

export type ScribeAuthorError =
  | 'cli-missing'
  | 'cli-locks'
  | 'invalid'
  | 'spawn'
  | 'timeout'
  | 'cancelled'
  | 'exit'
  | 'output'
  | 'max-turns'
  | 'max-budget'
  | 'cli-error'

export type ScribeAuthorOutcome = {
  ok: boolean
  /** The author's final message: its write plan. */
  result: string
  error: ScribeAuthorError | null
  detail: string | null
  durationMs: number
  costUsd: number | null
  turns: number | null
  /** Tool calls the permission rules refused. */
  denials: number
  /** The Obsidian MCP server was available to the author. */
  mcp: boolean
}

/** Runs the author (`claude -p`, read-only tools) once and resolves when it is over. */
export function scribeAuthorRun(request: ScribeAuthorRequest): Promise<ScribeAuthorOutcome> {
  return invoke<ScribeAuthorOutcome>('scribe_author_run', { request })
}

/** Stops a running author; resolves true when one was running. */
export function scribeAuthorCancel(runId: string): Promise<boolean> {
  return invoke<boolean>('scribe_author_cancel', { runId })
}

/** Appends a session's material (one JSON object per line) in the app data folder. */
export function scribeMaterialAppend(sessionId: string, lines: string[]): Promise<void> {
  return invoke('scribe_material_append', { sessionId, lines })
}

/** The newest part of a session's material, one JSON object per line; '' when none. */
export function scribeMaterialRead(sessionId: string): Promise<string> {
  return invoke<string>('scribe_material_read', { sessionId })
}

export function scribeMaterialRemove(sessionId: string): Promise<void> {
  return invoke('scribe_material_remove', { sessionId })
}

/** Vault-relative paths of every file in the vault (hidden folders skipped). */
export function scribeVaultIndex(vaultPath: string): Promise<string[]> {
  return invoke<string[]>('scribe_vault_index', { vaultPath })
}

export type ScribeSource = { path: string; content: string; truncated: boolean }

export type ScribeSourcesRequest = {
  sessionId: string
  /** The session's project folder; task files outside it (and the orchestra's own) are skipped. */
  sessionFolder?: string | null
  paths: string[]
}

/** Heads of the session's task files; any other path is skipped by the backend. */
export function scribeReadSources(request: ScribeSourcesRequest): Promise<ScribeSource[]> {
  return invoke<ScribeSource[]>('scribe_read_sources', { request })
}
