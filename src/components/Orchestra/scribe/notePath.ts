/**
 * Where the scribe's author writes: the session's diary note, named after the owner's own
 * pattern (`Diário/2026/10 - Outubro/Sessão 2026-10-04 — <title>.md`), and the titles inside
 * those names. Pure functions.
 */

/** Month names as the vault's diary folders spell them. */
export const MONTHS_PT = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
] as const

/**
 * Tokens: `{yyyy}`, `{mm}`, `{dd}`, `{date}` (YYYY-MM-DD), `{Mes}` (month name), `{mes}`
 * (lower case) and `{title}`.
 */
export const DEFAULT_DIARY_PATTERN = 'Diário/{yyyy}/{mm} - {Mes}/Sessão {date} — {title}.md'

const MAX_TITLE = 80
/** Characters Windows or Obsidian links cannot carry in a note name. */
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]\p{Cc}]/gu

const pad = (n: number) => String(n).padStart(2, '0')

/** A note title: one line, no characters a file name or a wikilink cannot hold. */
export function noteTitle(text: string, max = MAX_TITLE): string {
  const flat = text
    .replace(UNSAFE_NAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : flat.slice(0, max)).replace(/[\s,;.:-]+$/, '')
}

/**
 * A first title for the diary note, from the goal: its first sentence, short. The author
 * usually proposes a better one; this is the fallback.
 */
export function titleFromGoal(goal: string, projectName?: string | null): string {
  const first = goal
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .find(Boolean)
  const title = noteTitle(first ?? '', 70)
  if (title) return title
  return noteTitle(projectName?.trim() || 'Orquestração', 70)
}

function dateTokens(at: number): Record<string, string> {
  const d = new Date(at)
  const month = MONTHS_PT[d.getMonth()]
  return {
    yyyy: String(d.getFullYear()),
    mm: pad(d.getMonth() + 1),
    dd: pad(d.getDate()),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    Mes: month,
    mes: month.toLowerCase(),
  }
}

function fill(pattern: string, tokens: Record<string, string>): string {
  return pattern.replace(/\{(yyyy|mm|dd|date|Mes|mes|title)\}/g, (match, name: string) =>
    name in tokens ? tokens[name] : match,
  )
}

/** Vault-relative folders only: no absolute paths, no `.`/`..`, no hidden folders. */
function cleanSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[:*?"<>|\p{Cc}]/gu, '-').trim())
    .filter((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'))
}

/** Vault-relative path of a session's diary note for `title`, always a `.md` file. */
export function diaryNotePath(pattern: string, at: number, title: string): string {
  const safeTitle = noteTitle(title) || 'Sessão'
  const source = pattern.trim() || DEFAULT_DIARY_PATTERN
  const filled = fill(source, { ...dateTokens(at), title: safeTitle })
  const segments = cleanSegments(filled)
  if (segments.length === 0)
    return fill(DEFAULT_DIARY_PATTERN, { ...dateTokens(at), title: safeTitle })
  const name = segments.pop() as string
  const file = /\.md$/i.test(name) ? name : `${name}.md`
  return [...segments, file].join('/')
}

/** The folder the diary notes of `at`'s day go to: where same-day notes are looked for. */
export function diaryFolder(pattern: string, at: number): string {
  const path = diaryNotePath(pattern, at, 'x')
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/** The note name a pattern gives for `at`'s day before the title: `Sessão 2026-10-04 — `. */
export function diaryNamePrefix(pattern: string, at: number): string {
  const source = pattern.trim() || DEFAULT_DIARY_PATTERN
  const name = cleanSegments(fill(source, dateTokens(at))).pop() ?? ''
  const cut = name.indexOf('{title}')
  return cut < 0 ? '' : name.slice(0, cut)
}

/** File name without folders or `.md`: what a wikilink to the note says. */
export function noteName(path: string): string {
  const file = path.replace(/\\/g, '/').split('/').pop() ?? path
  return file.replace(/\.md$/i, '')
}

/** DD/MM/AAAA, the date format the owner's notes use in text. */
export function brDate(at: number): string {
  const d = new Date(at)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** HH:MM in local time. */
export function hhmm(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A path in the form Windows Explorer shows it (`C:\Users\...`). */
export function explorerPath(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\//g, '\\') : path
}
