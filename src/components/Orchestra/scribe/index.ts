export { useAuthorStatus } from './authorStatus'
export { getScribeConfig, notePathFor, type ScribeConfig, useScribeConfig } from './config'
export {
  contextTerms,
  gatherObsidianContext,
  type ObsidianContext,
  rankNotes,
  sessionNoteDigest,
} from './context'
export { sessionContextOf, useSessionContext } from './contextStore'
export { pickVault, type ScribeIssue, type ScribeState, scribeState } from './health'
export { SCRIBE_ID } from './identity'
export { contextHint, obsidianRule, withObsidianRule } from './rule'
export { ScribeChip } from './ScribeChip'
export { ScribeIdentity } from './ScribeIdentity'
export { ScribeSettings } from './ScribeSettings'
export {
  checkScribe,
  flushScribe,
  installScribe,
  prepareSessionContext,
  scribeRetryNow,
  scribeWriteNow,
  useScribeStatus,
} from './service'
export { openScribePanel, openScribeSettings } from './ui'
