const ESC = ''

/**
 * Sequences that leave the screen in a state the stream itself defines: after
 * one of these, everything that follows can be replayed exactly as recorded.
 */
const ANCHORS = [`${ESC}[2J`, `${ESC}[3J`, `${ESC}[?1049h`]

/** CSI sequence: ESC [ params intermediates final. */
const CSI = /\[[0-9;?]*[ -/]*[@-~]/g
/** OSC sequence: ESC ] ... terminated by BEL or ST. */
const OSC = /\][^]*(?:|\\)/g
/** Two-character escapes, including the cursor save/restore and reverse index. */
const ESC_PAIR = /[()#][0-9A-Za-z]|[78MDEHc]/g

/**
 * Prepares a recorded PTY stream to be written back into a terminal.
 *
 * The backend hands back the tail of the raw stream, cut on a byte count. That
 * stream is the recording of a full-screen program drawing itself: absolute
 * cursor moves, line erases, redraws in place. Replaying a slice of it against a
 * terminal that is not in the state those moves were recorded against paints
 * text over text — which is what a resumed agent pane looked like.
 *
 * Replaying from the last point where the program cleared the screen fixes that:
 * the state is known there, so every move after it lands where it originally
 * did. A tail with no such point is stripped down to its text instead, which
 * loses the layout but never corrupts it.
 */
export function sliceReplayForRestore(raw: string): string {
  if (!raw) return raw
  let anchor = -1
  for (const marker of ANCHORS) {
    const found = raw.lastIndexOf(marker)
    if (found > anchor) anchor = found
  }
  return anchor >= 0 ? raw.slice(anchor) : sanitizeReplay(raw)
}

/**
 * Strips everything that moves the cursor or erases, keeping the text and its
 * colours. Carriage returns are applied rather than kept, so a line redrawn in
 * place — a spinner, a progress bar — shows its final state instead of every
 * frame it went through.
 */
export function sanitizeReplay(raw: string): string {
  const withoutMotion = raw
    .replace(OSC, '')
    .replace(CSI, (match) => (match.endsWith('m') ? match : ''))
    .replace(ESC_PAIR, '')
    .replace(/\r\n/g, '\n')

  const lines = withoutMotion.split('\n').map((line) => {
    const lastReturn = line.lastIndexOf('\r')
    return lastReturn === -1 ? line : line.slice(lastReturn + 1)
  })
  return lines.join('\n')
}
