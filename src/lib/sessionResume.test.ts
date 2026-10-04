import { describe, expect, it } from 'vitest'

import {
  chooseResume,
  savedConversationIdFor,
  sessionScopeCwd,
  type SavedSession,
} from './sessionResume'

const baseSession: SavedSession = {
  sessionId: 'pty-1',
  claudeSessionId: 'claude-chat',
  codexSessionId: 'codex-chat',
  antigravitySessionId: 'antigravity-chat',
  cwd: 'D:\\Work\\Project',
  agent: 'claude',
  timestamp: 1000,
}

describe('savedConversationIdFor', () => {
  it('returns the saved Claude id when agent and cwd match', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Project/')).toBe('claude-chat')
  })

  it('ignores saved sessions from another agent', () => {
    expect(savedConversationIdFor(baseSession, 'codex', 'D:/Work/Project')).toBeUndefined()
  })

  it('ignores saved sessions from another cwd', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Other')).toBeUndefined()
  })

  it('returns the saved Antigravity conversation id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'antigravity' },
        'antigravity',
        'D:/Work/Project',
      ),
    ).toBe('antigravity-chat')
  })

  it('returns the saved OpenCode session id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'opencode', opencodeSessionId: 'opencode-chat' },
        'opencode',
        'D:/Work/Project',
      ),
    ).toBe('opencode-chat')
  })
})

describe('sessionScopeCwd', () => {
  it('uses the pane directory when it has one', () => {
    expect(sessionScopeCwd('C:/repo', 'C:/Users/me')).toBe('C:/repo')
  })

  it('falls back to the directory the process actually inherits', () => {
    // A pane with no directory does not run nowhere: the child inherits the
    // app's own. Treating that as "no cwd" switched off every session check.
    expect(sessionScopeCwd('', 'C:/Users/me')).toBe('C:/Users/me')
    expect(sessionScopeCwd(undefined, 'C:/Users/me')).toBe('C:/Users/me')
    expect(sessionScopeCwd('   ', 'C:/Users/me')).toBe('C:/Users/me')
  })

  it('has nothing to offer when neither is known', () => {
    expect(sessionScopeCwd('', '')).toBe('')
  })
})

describe('chooseResume', () => {
  it('resumes the saved conversation while it still exists', () => {
    expect(chooseResume('a', ['a', 'b'])).toEqual({ kind: 'saved', id: 'a' })
  })

  it('takes the most recent one when the saved id is gone', () => {
    // Claude answers "No conversation found with session ID" and the pane dies
    // on an id that no longer exists. Picking the newest conversation of that
    // directory is what a person does by hand with /resume.
    expect(chooseResume('gone', ['a', 'b'])).toEqual({ kind: 'mostRecent' })
  })

  it('starts fresh when the saved id is gone and nothing else is there', () => {
    expect(chooseResume('gone', [])).toEqual({ kind: 'fresh' })
  })

  it('never adopts a conversation for a pane that had none', () => {
    // Without this a brand-new pane would hijack whatever ran last in that
    // directory — and every pane sharing one directory would grab the same one.
    expect(chooseResume(undefined, ['a', 'b'])).toEqual({ kind: 'fresh' })
    expect(chooseResume('', ['a'])).toEqual({ kind: 'fresh' })
  })
})
