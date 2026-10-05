const ESC = '\x1b'

/** Points after which the stream redraws from a state it defines itself. */
const ANCHORS = [`${ESC}[2J`, `${ESC}[3J`, `${ESC}[?1049h`]
/** DECSET / DECRST: state setters (alt screen, mouse, bracketed paste, cursor) safe to replay. */
const PRIVATE_MODES = /\x1b\[\?[0-9;]*[hl]/g

/**
 * The part of a PTY recording an empty mirror should replay. The recording is a byte-count tail that
 * may span several widths, so it is replayed from the last point the program cleared the screen,
 * preceded by every private mode the earlier part set (in order, so the last one wins). Without such
 * a point it is replayed raw: the emulator keeps every space the ConPTY encoded as cursor moves,
 * which a text-only fallback would lose.
 */
export function seedReplay(raw: string): string {
  let anchor = -1
  for (const marker of ANCHORS) {
    const found = raw.lastIndexOf(marker)
    if (found > anchor) anchor = found
  }
  if (anchor <= 0) return raw
  const modes = raw.slice(0, anchor).match(PRIVATE_MODES)?.join('') ?? ''
  return modes + raw.slice(anchor)
}
