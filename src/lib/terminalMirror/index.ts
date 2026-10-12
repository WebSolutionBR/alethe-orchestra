/**
 * One headless xterm.js buffer per PTY, fed from the first byte and always kept at the PTY's real
 * size. Views (LiveTerminal, XTermView restores) read it instead of replaying recorded bytes at
 * another width.
 */
export {
  mirrorPaletteFromTheme,
  type MirrorThemeLike,
  XTERM_DEFAULT_ANSI,
  XTERM_DEFAULT_BACKGROUND,
  XTERM_DEFAULT_FOREGROUND,
} from './colors'
export { encodeKey, encodeWheel } from './keys'
export { MAX_SEARCH_MATCHES } from './lines'
export { transcriptOfRecording } from './recorded'
export {
  disposeMirror,
  ensureMirror,
  feedMirror,
  seedMirror,
  serializeMirror,
  whenMirrorReady,
} from './registry'
export { getMirror, onMirrorRegistry } from './store'
export type {
  KeyLike,
  MirrorColor,
  MirrorLine,
  MirrorModes,
  MirrorMouseTracking,
  MirrorOptions,
  MirrorPalette,
  MirrorRun,
  MirrorSearchMatch,
  MirrorSearchOptions,
  TerminalMirror,
} from './types'
