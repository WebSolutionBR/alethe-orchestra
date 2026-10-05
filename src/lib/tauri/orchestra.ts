import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type OrchestraLaunch = {
  endpoint: string
  token: string
  settings_path: string
  cli_path: string
  path_env: string
}

export type OrchestraStatus = 'thinking' | 'editing' | 'testing' | 'blocked' | 'done' | 'idle'

export type OrchestraHookSummary = {
  hook_event_name?: string
  tool_name?: string
  target?: string
  prompt?: string
  message?: string
  last_assistant_message?: string
  notification_type?: string
  failed?: boolean
  /** The agent's Claude conversation; `claude --resume <session_id>` continues it. */
  session_id?: string
  /** That conversation's JSONL transcript on disk. */
  transcript_path?: string
}

/** Every event names the orchestration it belongs to; `default` marks legacy calls. */
export type OrchestraEvent =
  | { kind: 'hook'; session: string; at: number; agent_id: string; hook: OrchestraHookSummary }
  | {
      kind: 'report'
      session: string
      at: number
      agent_id: string
      progress: number | null
      status: OrchestraStatus | null
      note: string
    }
  | { kind: 'message'; session: string; at: number; from: string; to: string; text: string }
  | {
      kind: 'spawn'
      session: string
      at: number
      id: string
      area: string
      task: string
      after: string[]
      /** Optional `orch spawn --account/--model/--effort` values; null when not given. */
      account?: string | null
      model?: string | null
      effort?: string | null
    }
  /** `orch note`: an agent's record of a decision and its why (Markdown, up to 16 000 chars). */
  | { kind: 'note'; session: string; at: number; agent_id: string; text: string }

/**
 * Writes the hooks file of `agentId` in that session and returns how to launch it. With `cwd`,
 * it rejects when that folder no longer exists, so the agent never runs somewhere else.
 */
export function orchestraPrepare(
  sessionId: string,
  agentId: string,
  cwd?: string,
): Promise<OrchestraLaunch> {
  return invoke<OrchestraLaunch>('orchestra_prepare', { sessionId, agentId, cwd: cwd ?? null })
}

/** Whether a folder exists (a resume checks its folder before relaunching anything). */
export function orchestraFolderExists(path: string): Promise<boolean> {
  return invoke<boolean>('orchestra_folder_exists', { path })
}

/** Restarts the worker numbering of one session at `claude-1`; other sessions keep theirs. */
export function orchestraReset(sessionId: string): Promise<void> {
  return invoke('orchestra_reset', { sessionId })
}

/** A resumed session numbers new workers from `nextWorker` (one above its highest `claude-N`). */
export function orchestraResume(sessionId: string, nextWorker: number): Promise<void> {
  return invoke('orchestra_resume', { sessionId, nextWorker })
}

/**
 * Saves an agent's task (or the orchestrator's goal) to a file the agent is told to read, so
 * the text never crosses a command line. Resolves to the file's path.
 */
export function orchestraWriteTask(
  sessionId: string,
  agentId: string,
  text: string,
): Promise<string> {
  return invoke<string>('orchestra_write_task', { sessionId, agentId, text })
}

/** Forgets a finished session (counter, hooks and task files). Best effort on the backend. */
export function orchestraEnd(sessionId: string): Promise<void> {
  return invoke('orchestra_end', { sessionId })
}

/** Saves a running session's manifest (atomic on the backend); callers debounce. */
export function orchestraManifestSave(sessionId: string, manifest: unknown): Promise<void> {
  return invoke('orchestra_manifest_save', { sessionId, manifest })
}

/** Raw manifests on disk; each `id` is its file's session. Validate before use. */
export function orchestraManifestList(): Promise<unknown[]> {
  return invoke<unknown[]>('orchestra_manifest_list')
}

/** Forgets a session's manifest and the transcripts kept for it. */
export function orchestraManifestRemove(sessionId: string): Promise<void> {
  return invoke('orchestra_manifest_remove', { sessionId })
}

export function listenOrchestra(handler: (event: OrchestraEvent) => void): Promise<UnlistenFn> {
  return listen<OrchestraEvent>('orchestra://event', (event) => handler(event.payload))
}
