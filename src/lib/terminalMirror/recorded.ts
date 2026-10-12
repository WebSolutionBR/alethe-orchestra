import { Mirror } from './mirror'

/** Bytes written per parse, like the live stream: frames are compared as they complete. */
const CHUNK = 16_384

/**
 * Plain text of a PTY's recorded output, parsed by a throwaway mirror at the size the PTY had (the
 * width the program drew it at), so the text reads as it did on screen instead of scrambled. Its
 * full-screen history is rebuilt frame by frame, as in a live mirror.
 */
export function transcriptOfRecording(
  recorded: string,
  size: { cols: number; rows: number },
): string {
  const mirror = new Mirror('recorded', { cols: size.cols, rows: size.rows })
  try {
    for (let at = 0; at < recorded.length; at += CHUNK) mirror.feed(recorded.slice(at, at + CHUNK))
    return mirror.getText(0, mirror.length).replace(/\s+$/, '')
  } finally {
    mirror.dispose()
  }
}
