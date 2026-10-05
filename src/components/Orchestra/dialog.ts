/**
 * Dialogs Claude Code draws in place of its prompt (a permission request, a question with
 * options), read from the terminal's screen. While one is open, pasted text and Enter would
 * answer it instead of reaching the prompt: Enter picks the option under the cursor, which on a
 * permission request is "Yes". Claude Code only reports a permission request to hooks seconds
 * after showing it, so the screen is the first to know.
 */
import { getMirror } from '../../lib/terminalMirror'

export type DialogOption = {
  /** 1-based position, as the dialog numbers it. */
  index: number
  /** The option's text as the terminal shows it, without its number. */
  label: string
  /** The option under the dialog's cursor (❯): Enter picks it. */
  focused: boolean
  /** Esc picks it: Claude Code ends the refusing option of a permission request with "(esc)". */
  deny: boolean
}

export type ScreenDialog = {
  /** The line above the options, e.g. "Do you want to proceed?"; empty when there is none. */
  question: string
  /** Empty for a dialog without numbered options: it can only be answered in its terminal. */
  options: DialogOption[]
  /** A permission request: a question, and one option that refuses with Esc. */
  permission: boolean
}

/** Frames (box drawing) and padding around a dialog's lines are not part of their text. */
const FRAME = /^[\s\u2500-\u257f]+|[\s\u2500-\u257f]+$/gu
/** `❯ 1. Yes`: the cursor, the option's number and its text. */
const OPTION = /^([❯›▸►>])?\s*([1-9])\.\s+(\S.*)$/u
/** Lines a dialog may have under its last option: key hints, a status line. */
const TAIL_LINES = 6
/** Blank lines allowed between the question and the first option. */
const QUESTION_GAP = 1
/** A select without numbers (the folder trust dialog): its cursor line and its key hints. */
const CURSOR_LINE = /^❯ \S/u
const SELECT_HINT = /\b(enter|esc)\b[^·]*\bto (confirm|select|cancel|exit|go back)\b/i

type Line = { text: string; column: number }

/** Column of a line's first character that is not frame or padding; -1 when blank. */
function contentColumn(raw: string): number {
  return raw.search(/[^\s\u2500-\u257f]/u)
}

/**
 * The dialog at the bottom of a screen, or null. Usually a numbered list of at least two
 * options (1, 2, …) with the cursor on exactly one of them and at most a few short lines under
 * it; a long option may wrap onto lines indented under its text. A select without numbers is
 * recognized by its cursor line and its key hints ("Enter to confirm · Esc to cancel").
 */
export function readDialog(screen: readonly string[]): ScreenDialog | null {
  const lines: Line[] = screen.map((raw) => ({
    text: raw.replace(FRAME, ''),
    column: contentColumn(raw),
  }))
  return numberedDialog(lines) ?? unnumberedSelect(lines)
}

function numberedDialog(lines: Line[]): ScreenDialog | null {
  let last = -1
  let below = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i].text)) {
      last = i
      break
    }
    if (lines[i].text && ++below > TAIL_LINES) return null
  }
  if (last === -1) return null

  const options: Omit<DialogOption, 'deny'>[] = []
  // Lines wrapped from the option above them, collected while walking up.
  let wrapped: string[] = []
  // Indented under the last option's text: the end of its label, wrapped.
  const lastColumn = lines[last].column
  for (let i = last + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.text || OPTION.test(line.text) || line.column <= lastColumn + 1) break
    wrapped.push(line.text)
  }

  let first = last
  for (let i = last; i >= 0; i--) {
    const line = lines[i]
    const match = OPTION.exec(line.text)
    if (match) {
      const label = [match[3], ...wrapped].join(' ').replace(/\s+/g, ' ').trim()
      options.unshift({ index: Number(match[2]), label, focused: Boolean(match[1]) })
      wrapped = []
      first = i
      continue
    }
    // Deeper than the options' numbers: the wrapped end of the option above.
    if (line.text && line.column > lines[first].column + 1) {
      wrapped.unshift(line.text)
      continue
    }
    break
  }

  if (options.length < 2) return null
  if (options.some((option, i) => option.index !== i + 1)) return null
  if (options.filter((option) => option.focused).length !== 1) return null

  let question = ''
  for (let i = first - 1, gap = 0; i >= 0 && gap <= QUESTION_GAP; i--) {
    if (!lines[i].text) {
      gap += 1
      continue
    }
    if (lines[i].text.endsWith('?')) question = lines[i].text
    break
  }

  const withDeny = options.map((option) => ({ ...option, deny: /\(esc\)$/i.test(option.label) }))
  const denies = withDeny.filter((option) => option.deny).length
  return { question, options: withDeny, permission: Boolean(question) && denies === 1 }
}

function unnumberedSelect(lines: Line[]): ScreenDialog | null {
  const bottom = lines.slice(-(TAIL_LINES * 3))
  const cursors = bottom.filter((line) => CURSOR_LINE.test(line.text))
  if (cursors.length !== 1) return null
  const after = bottom.slice(bottom.indexOf(cursors[0]) + 1)
  if (!after.some((line) => SELECT_HINT.test(line.text))) return null
  return { question: '', options: [], permission: false }
}

/** The lines on the visible screen of a PTY's mirror; null without a mirror. */
export function screenLines(ptyId: string): string[] | null {
  try {
    const mirror = getMirror(ptyId)
    if (!mirror) return null
    return mirror.getText(mirror.baseY, mirror.baseY + mirror.rows).split('\n')
  } catch {
    return null
  }
}

/** The dialog an agent's terminal shows right now, or null. */
export function dialogOnScreen(ptyId: string | null | undefined): ScreenDialog | null {
  if (!ptyId) return null
  const lines = screenLines(ptyId)
  return lines ? readDialog(lines) : null
}

/** Same dialog, same choice: the option the user picked is still offered as it was. */
export function sameOption(dialog: ScreenDialog | null, choice: DialogOption): DialogOption | null {
  return (
    dialog?.options.find(
      (option) => option.index === choice.index && option.label === choice.label,
    ) ?? null
  )
}

const KEY_ESC = '\x1b'
const KEY_ENTER = '\r'
/** How long a dialog gets to move its cursor, or to close, after a key. */
export const DIALOG_SETTLE_MS = 1500
const SETTLE_POLL_MS = 40

/** Whether the terminal asked for application cursor keys (arrows as ESC O x). */
function applicationCursor(ptyId: string): boolean {
  try {
    return Boolean(getMirror(ptyId)?.modes.applicationCursorKeys)
  } catch {
    return false
  }
}

/** An arrow key, encoded the way the terminal asked for. */
function arrowKey(ptyId: string, down: boolean): string {
  return `${KEY_ESC}${applicationCursor(ptyId) ? 'O' : '['}${down ? 'B' : 'A'}`
}

/** Resolves true as soon as `check` holds, false when it still does not after `ms`. */
function settled(check: () => boolean, ms = DIALOG_SETTLE_MS): Promise<boolean> {
  const started = Date.now()
  return new Promise((resolve) => {
    const poll = () => {
      if (check()) resolve(true)
      else if (Date.now() - started >= ms) resolve(false)
      else setTimeout(poll, SETTLE_POLL_MS)
    }
    poll()
  })
}

/**
 * Picks an option of the permission request on a terminal's screen, only if it is still
 * offered as the user saw it. The refusing option is Esc. Any other one is reached with the
 * arrows, and Enter goes only once the dialog shows its cursor on it (Enter picks whatever the
 * cursor is on). Resolves true when the dialog took the answer and closed; false when nothing
 * was sent, or it is still open.
 */
export async function chooseOption(
  ptyId: string,
  choice: DialogOption,
  press: (keys: string) => Promise<unknown>,
): Promise<boolean> {
  const request = () => {
    const dialog = dialogOnScreen(ptyId)
    return dialog?.permission ? dialog : null
  }
  const shown = request()
  const option = sameOption(shown, choice)
  if (!shown || !option) return false
  if (option.deny) {
    await press(KEY_ESC)
  } else {
    const focused = shown.options.find((o) => o.focused)
    if (!focused) return false
    const steps = option.index - focused.index
    for (let i = 0; i < Math.abs(steps); i++) await press(arrowKey(ptyId, steps > 0))
    if (!(await settled(() => Boolean(sameOption(request(), choice)?.focused)))) return false
    await press(KEY_ENTER)
  }
  return settled(() => !sameOption(request(), choice))
}
