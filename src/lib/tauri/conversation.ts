import { invoke } from '@tauri-apps/api/core'

/** Outcome of moving a conversation to another Claude account. */
export type CopyConversationResult = {
  /** The conversation is now in the destination account: `claude --resume` will find it. */
  copied: boolean
  /** Why nothing was copied: same account folder, no such conversation, or a malformed id. */
  reason: 'same_dir' | 'not_found' | 'invalid_session' | null
}

/**
 * Copies one conversation (`<config>/projects/<folder>/<sessionId>.jsonl` and its folder)
 * from one account to another so an agent restarted on the new account can resume it.
 * Never touches credentials. `''` as a dir means the default account (`~/.claude`).
 * Rejects only on I/O failures.
 */
export async function copyConversation(args: {
  fromDir: string
  toDir: string
  cwd: string
  sessionId: string
}): Promise<CopyConversationResult> {
  return invoke<CopyConversationResult>('copy_conversation', {
    fromDir: args.fromDir,
    toDir: args.toDir,
    cwd: args.cwd,
    sessionId: args.sessionId,
  })
}
