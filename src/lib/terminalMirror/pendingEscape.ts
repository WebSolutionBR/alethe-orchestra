const ESC = '\x1b'
const BEL = '\x07'
/** An unterminated string (OSC, DCS…) longer than this is dropped instead of carried along. */
const MAX_PENDING = 4096

function inRange(code: number, low: number, high: number): boolean {
  return code >= low && code <= high
}

/** Whether `sequence` (starting with ESC, holding no other ESC) still waits for its final byte. */
function isIncomplete(sequence: string): boolean {
  if (sequence.length === 1) return true
  const kind = sequence.charCodeAt(1)
  // OSC, DCS, SOS, PM, APC: a string closed by BEL (OSC) or ST (ESC \), the next ESC.
  if (kind === 0x5d) return !sequence.includes(BEL, 2)
  if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) return true
  if (kind === 0x5b) {
    // CSI: parameter and intermediate bytes until a final byte in 0x40-0x7e.
    for (let i = 2; i < sequence.length; i++) {
      const code = sequence.charCodeAt(i)
      if (inRange(code, 0x40, 0x7e)) return false
      if (!inRange(code, 0x20, 0x3f)) return false
    }
    return true
  }
  // ESC with intermediates (charset designations and the like) until a final byte.
  for (let i = 1; i < sequence.length; i++) {
    if (!inRange(sequence.charCodeAt(i), 0x20, 0x2f)) return false
  }
  return true
}

/**
 * The escape sequence a stream ends in the middle of, given what was pending before `chunk`; ''
 * when the stream ends between sequences. A terminal restored from a snapshot is handed this tail
 * too, so the rest of the sequence, arriving with the next chunk, is parsed instead of printed.
 */
export function pendingEscape(pending: string, chunk: string): string {
  const at = chunk.lastIndexOf(ESC)
  const tail = at >= 0 ? chunk.slice(at) : pending + chunk
  if (!tail.startsWith(ESC) || tail.length > MAX_PENDING) return ''
  return isIncomplete(tail) ? tail : ''
}
