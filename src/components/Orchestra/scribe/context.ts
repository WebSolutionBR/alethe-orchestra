/**
 * The Obsidian context of a new orchestration. Before the orchestrator starts, the vault is
 * consulted: the day's session note, the notes of the Orchestra folder and one search per
 * keyword of the project name, the goal and the session folder. The best notes are ranked,
 * their relevant lines are cut to size and everything goes into a compact markdown block that
 * every agent of the session reads from a file.
 *
 * Pure helpers plus `gatherObsidianContext`, whose Obsidian calls are injected: the scribe
 * wires the real ones, tests pass mocks, and nothing here writes to the vault.
 */
import type { ObsidianNote, ObsidianSearchResult } from './api'

/** The whole consultation; past it the session starts with what arrived, or without context. */
export const CONTEXT_BUDGET_MS = 5_000
/** Size limit of the markdown block. */
export const CONTEXT_MAX_CHARS = 8_000
/** Characters the search keeps around each match. */
export const SEARCH_CONTEXT_LENGTH = 80
const MAX_TERMS = 6
/** One search per term, plus the unaccented spelling: the plugin's search is accent-sensitive. */
const MAX_SEARCHES = 8
const MIN_TERM_LENGTH = 3
/** Time kept for writing the file once the reads are over. */
const WRITE_RESERVE_MS = 400
/** The write is local and fast; it gets at least this long even when the reads used the budget. */
const MIN_WRITE_MS = 1_500
const SESSION_NOTE_CHARS = 2_600
const SNIPPET_CHARS = 240
const HEADING_CHARS = 60
/** Room a related note takes besides its lines: link, folder and terms. */
const NOTE_OVERHEAD = 170
const HEADER_CHARS = 700

const STOP_WORDS = new Set(
  [
    // Portuguese: articles, prepositions, pronouns, common verbs and filler of task goals.
    'umas uns uma das dos dum duma nas nos num numa por pelo pela pelos pelas para pra pro com sem',
    'sob sobre entre ate apos mas nem que como quando onde qual quais quem cujo cuja aos este esta',
    'estes estas isto esse essa esses essas isso aquele aquela aquilo meu minha meus minhas seu sua',
    'seus suas nosso nossa nossos nossas ele ela eles elas voce voces lhe lhes nao sim mais menos',
    'muito muita muitos muitas pouco pouca todo toda todos todas tudo cada outro outra outros outras',
    'mesmo mesma tambem ainda bem aqui ali agora entao depois antes sempre nunca ser estar ter haver',
    'foi era sao estao tem vai vamos pode podem deve devem fazer faz faca feito feita criar crie',
    'melhorar melhore corrigir corrija ajustar ajuste adicionar adicione implementar implemente',
    'incluir inclua revisar revise verificar verifique atualizar atualize resolver resolva mudar',
    'mude trocar troque deixar deixe colocar coloque usar use quero queremos preciso precisa',
    'precisamos favor coisa coisas parte forma jeito novo nova novos novas tarefa tarefas leia ler',
    'execute executar rode rodar veja ver completa completo arquivo arquivos pasta',
    // English.
    'the and but for with without from into about over under then than not yes all any some each',
    'more most less very can could should would will shall does did done make makes add adds fix',
    'fixes improve improves create build update implement change new please need needs want wants',
    'task tasks read run see file files folder this that these those are was were been being its',
    // Path parts that ride along with goals that name files.
    'users profile documents desktop downloads appdata local roaming temp github src http https',
    'www com html json tsx',
  ]
    .join(' ')
    .split(/\s+/),
)

/** Lowercase without accents: how terms and texts are compared. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** Words worth searching for: no stop words, no short words, no bare numbers. */
export function keywords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const word = raw.toLowerCase()
    const folded = foldText(word)
    if (folded.length < MIN_TERM_LENGTH || /^\d+$/.test(folded) || STOP_WORDS.has(folded)) continue
    out.push(word)
  }
  return out
}

/** The folder a session runs in: the last part of its cwd. */
export function folderName(cwd: string | null | undefined): string {
  return (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
}

export type ContextSubject = {
  projectName?: string | null
  cwd?: string | null
  goal?: string | null
}

/**
 * What to search for: the keywords of the project name, of the goal and of the session folder,
 * in that order, without repeats (case and accents aside), at most six.
 */
export function contextTerms(subject: ContextSubject): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const source of [subject.projectName ?? '', subject.goal ?? '', folderName(subject.cwd)]) {
    for (const word of keywords(source)) {
      const key = foldText(word)
      if (seen.has(key)) continue
      seen.add(key)
      terms.push(word)
      if (terms.length === MAX_TERMS) return terms
    }
  }
  return terms
}

export type SearchQuery = { term: string; query: string }

/** Each term, then its unaccented spelling when it has accents; at most eight searches. */
export function searchQueries(terms: string[]): SearchQuery[] {
  const queries: SearchQuery[] = []
  for (const term of terms) {
    queries.push({ term, query: term })
    const plain = foldText(term)
    if (plain !== term.toLowerCase()) queries.push({ term, query: plain })
  }
  return queries.slice(0, MAX_SEARCHES)
}

export type SearchRun = { term: string; result: ObsidianSearchResult }

export type RankedNote = {
  path: string
  score: number
  /** Terms the note matched, in its text or in its path. */
  terms: string[]
  /** Search contexts, quoted when the note itself cannot be read in time. */
  contexts: string[]
  inFolder: boolean
}

const DATE_IN_PATH = /(\d{4})-(\d{2})-(\d{2})/

function dayNumber(date: string): number | null {
  const match = DATE_IN_PATH.exec(date)
  if (!match) return null
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000
  return Number.isFinite(day) ? day : null
}

/** 1 for a note dated today (in its path), fading to 0 at 30 days; 0 without a date. */
export function recency(path: string, today: string): number {
  const note = dayNumber(path)
  const now = dayNumber(today)
  if (note === null || now === null) return 0
  return Math.max(0, 1 - Math.abs(now - note) / 30)
}

/**
 * Ranks the notes the searches found plus the notes of the Orchestra folder. A term weighs more
 * the fewer notes it matched; matching it in the note's path (its title or folders) counts more
 * than in its text; folder notes and recently dated notes get a small lift. Ties keep the
 * plugin's order. Notes in `exclude` (the session note) are left out.
 */
export function rankNotes(input: {
  runs: SearchRun[]
  terms: string[]
  folderNotes: string[]
  exclude: string[]
  today: string
}): RankedNote[] {
  type Acc = {
    path: string
    matches: Map<string, { term: string; count: number }>
    contexts: string[]
    best: number
    inFolder: boolean
  }
  const excluded = new Set(input.exclude.map((path) => path.toLowerCase()))
  const notes = new Map<string, Acc>()
  const noteOf = (path: string): Acc | null => {
    if (!/\.md$/i.test(path) || excluded.has(path.toLowerCase())) return null
    let acc = notes.get(path)
    if (!acc) {
      acc = {
        path,
        matches: new Map(),
        contexts: [],
        best: Number.MAX_SAFE_INTEGER,
        inFolder: false,
      }
      notes.set(path, acc)
    }
    return acc
  }

  // How many notes each term matched, over its spellings.
  const totals = new Map<string, number>()
  for (const run of input.runs) {
    const key = foldText(run.term)
    totals.set(key, Math.max(totals.get(key) ?? 0, run.result.total))
  }
  // Unknown (its search failed): treated as a moderately common word.
  const weight = (key: string) => 1 / Math.log2(2 + (totals.get(key) ?? 20))

  for (const run of input.runs) {
    const key = foldText(run.term)
    run.result.hits.forEach((hit, index) => {
      const acc = noteOf(hit.filename)
      if (!acc) return
      acc.best = Math.min(acc.best, index)
      const seen = acc.matches.get(key)
      acc.matches.set(key, { term: run.term, count: (seen?.count ?? 0) + hit.match_count })
      for (const context of hit.contexts) {
        if (acc.contexts.length < 6 && !acc.contexts.includes(context)) acc.contexts.push(context)
      }
    })
  }
  for (const path of input.folderNotes) {
    const acc = noteOf(path)
    if (acc) acc.inFolder = true
  }

  const ranked = [...notes.values()].map((acc): RankedNote & { best: number } => {
    let score = 0
    const terms = new Map<string, string>()
    for (const [key, match] of acc.matches) {
      score += weight(key) * (1 + Math.min(match.count, 20) / 20)
      terms.set(key, match.term)
    }
    const path = foldText(acc.path)
    for (const term of input.terms) {
      const key = foldText(term)
      if (!key || !path.includes(key)) continue
      score += 2 * weight(key) + 0.5
      terms.set(key, term)
    }
    if (acc.inFolder) score += 0.3
    score += 0.4 * recency(acc.path, input.today)
    return {
      path: acc.path,
      score,
      terms: [...terms.values()],
      contexts: acc.contexts,
      inFolder: acc.inFolder,
      best: acc.best,
    }
  })
  ranked.sort((a, b) => b.score - a.score || a.best - b.best || a.path.localeCompare(b.path))
  return ranked.map(({ best: _best, ...note }) => note)
}

/**
 * The best `max` notes, with at most a third of them (two at least) from the same top-level
 * folder, so one busy folder (a diary of sessions) does not crowd out the subject notes. The
 * Orchestra folder and notes at the vault root are not capped; when variety runs out, the best
 * of the rest fill the remaining places. Rank order is kept.
 */
export function pickNotes(ranked: RankedNote[], max: number, freeFolder = ''): RankedNote[] {
  const limit = Math.max(0, Math.floor(max))
  const perFolder = Math.max(2, Math.ceil(limit / 3))
  const free = freeFolder.split('/')[0]
  const counts = new Map<string, number>()
  const picked = new Set<RankedNote>()
  for (const note of ranked) {
    if (picked.size >= limit) break
    const top = note.path.includes('/') ? note.path.split('/')[0] : ''
    const count = counts.get(top) ?? 0
    if (top && top !== free && count >= perFolder) continue
    counts.set(top, count + 1)
    picked.add(note)
  }
  for (const note of ranked) {
    if (picked.size >= limit) break
    picked.add(note)
  }
  return ranked.filter((note) => picked.has(note))
}

/** Whitespace collapsed, at most `max` chars; an ellipsis marks a cut. */
export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Without the YAML frontmatter. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}

const HEADING = /^(#{1,6})\s+(.+)$/

/** A line without its list or quote marker. */
function lineText(line: string): string {
  return line
    .replace(/^>\s*(?:\[![\w-]+\][+-]?\s*)?/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
}

/**
 * The lines of a note that mention the terms, each after its nearest heading: the lines with
 * more terms first, within `maxChars`, then back in reading order. A note that mentions none of
 * them gives its opening lines.
 */
export function noteSnippets(markdown: string, terms: string[], maxChars: number): string[] {
  const keys = [...new Set(terms.map(foldText))].filter(Boolean)
  const found: { index: number; hits: number; text: string }[] = []
  const opening: { index: number; hits: number; text: string }[] = []
  let heading = ''
  let fenced = false
  stripFrontmatter(markdown)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim()
      if (line.startsWith('```') || line.startsWith('~~~')) {
        fenced = !fenced
        return
      }
      if (!line) return
      const title = fenced ? null : HEADING.exec(line)
      if (title) {
        // The H1 is the note's own title, already in the link: no prefix under it.
        heading =
          title[1].length === 1 ? '' : clipText(title[2].replace(/[*_`]/g, ''), HEADING_CHARS)
        return
      }
      const text = clipText(lineText(line), SNIPPET_CHARS)
      if (!text || /^[-|:\s]+$/.test(text)) return
      if (opening.length < 3) opening.push({ index, hits: 0, text })
      const folded = foldText(line)
      const hits = keys.filter((key) => folded.includes(key)).length
      if (hits > 0) found.push({ index, hits, text: heading ? `${heading} › ${text}` : text })
    })
  const pool =
    found.length > 0 ? found.sort((a, b) => b.hits - a.hits || a.index - b.index) : opening
  const picked: { index: number; text: string }[] = []
  const seen = new Set<string>()
  let used = 0
  for (const item of pool) {
    if (seen.has(item.text)) continue
    const cost = item.text.length + 3
    if (used + cost > maxChars) {
      if (picked.length === 0 && maxChars > 20) {
        picked.push({ index: item.index, text: clipText(item.text, maxChars - 3) })
        used = maxChars
      }
      continue
    }
    seen.add(item.text)
    picked.push(item)
    used += cost
  }
  return picked.sort((a, b) => a.index - b.index).map((item) => item.text)
}

/** Headings of the scribe's own timestamped blocks: event logs rather than decisions. */
const SCRIBE_BLOCK =
  /^#{3,4}\s+\d{1,2}:\d{2}\s+·\s+(?:Escriba Orchestra|Sessao Orchestra (?:iniciada|encerrada))/

type Section = { level: number; title: string; text: string }

function splitSections(markdown: string): Section[] {
  const sections: Section[] = []
  let current: Section = { level: 0, title: '', text: '' }
  let fenced = false
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : HEADING.exec(line)
    if (heading) {
      sections.push(current)
      current = { level: heading[1].length, title: heading[2].trim(), text: '' }
    }
    current.text += `${line}\n`
  }
  sections.push(current)
  return sections
    .map((section) => ({ ...section, text: section.text.replace(/\n{3,}/g, '\n\n').trim() }))
    .filter((section) => section.text)
}

/** The end of `text` within `max` chars, starting on a fresh line when one is near. */
function tailOf(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max + 1)
  const line = cut.indexOf('\n')
  return `…${line >= 0 && line < 400 ? cut.slice(line + 1) : cut}`
}

/**
 * The final part of the day's session note: an outline of its main sections, then the last
 * sections the agents wrote, within `maxChars`. The scribe's own timestamped log blocks are
 * left out.
 */
export function sessionNoteDigest(markdown: string, maxChars: number): string {
  const sections = splitSections(stripFrontmatter(markdown)).filter(
    (section) => !SCRIBE_BLOCK.test(`${'#'.repeat(section.level)} ${section.title}`),
  )
  const titles = sections.filter((section) => section.level === 2).map((section) => section.title)
  const outline = titles.length
    ? clipText(`Seções do dia: ${titles.join(' · ')}`, Math.floor(maxChars / 4))
    : ''
  let room = maxChars - outline.length - 2
  const tail: string[] = []
  for (let i = sections.length - 1; i >= 0 && room > 0; i--) {
    const text = sections[i].text
    // The note's own title adds nothing to the outline.
    if (sections[i].level === 1 && i === 0) continue
    if (text.length + 2 <= room) {
      tail.unshift(text)
      room -= text.length + 2
      continue
    }
    if (room > 200) tail.unshift(tailOf(text, room - 2))
    break
  }
  return [outline, ...tail].filter(Boolean).join('\n\n')
}

/** `[[path|title]]`, or `[[title]]` for a note at the vault root. */
export function wikiLink(path: string): string {
  const target = path.replace(/\.md$/i, '')
  const title = noteTitle(path)
  return target === title ? `[[${title}]]` : `[[${target}|${title}]]`
}

export function noteTitle(path: string): string {
  return path.replace(/\.md$/i, '').split('/').pop() || path
}

function noteFolder(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

function stamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type ContextSource = {
  path: string
  terms: string[]
  /** Lines to quote, already cut to size. */
  snippets: string[]
}

export type ContextBlockInput = {
  at: number
  vaultPath: string
  terms: string[]
  /** Vault-relative path of the day's session note. */
  sessionNote: string
  /** Its digest; null when the note does not exist yet or did not answer in time. */
  sessionDigest: string | null
  notes: ContextSource[]
  maxChars?: number
}

/**
 * The block the agents read (PT-BR, like the vault): where it came from, the end of the session
 * note and the relevant lines of each related note, within `maxChars`. When it runs long, the
 * lines of the lowest-ranked notes go first; the links always stay.
 */
export function buildContextMarkdown(input: ContextBlockInput): string {
  const max = input.maxChars ?? CONTEXT_MAX_CHARS
  const vault = input.vaultPath.trim().replace(/\\/g, '/')
  const terms = input.terms.length ? input.terms.join(', ') : 'nenhum'
  const header = [
    `# Contexto do Obsidian (consultado em ${stamp(input.at)})`,
    '',
    `Consultado pelo Alethe Orchestra ao iniciar a sessão${vault ? `, no cofre \`${vault}\`` : ''}.`,
    `Termos buscados: ${terms}.`,
    'São trechos: leia a nota inteira (MCP do Obsidian, `obsidian_get_file_contents`) quando o assunto for o seu; se a área tem histórico, leia as notas dela por inteiro antes de mexer.',
    '',
    `## Nota da sessão: ${wikiLink(input.sessionNote)} (parte final)`,
    '',
    input.sessionDigest?.trim() ||
      '_Ainda não existe (primeira sessão do dia) ou não respondeu a tempo._',
    '',
    '## Notas relacionadas',
    '',
  ]
  const notes = input.notes.map((note) => ({ ...note, snippets: [...note.snippets] }))
  const render = () => {
    const related = notes.length
      ? notes.flatMap((note) => {
          const folder = noteFolder(note.path)
          const where = [
            folder ? `\`${folder}\`` : '',
            note.terms.length ? `termos: ${note.terms.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
          return [
            `### ${wikiLink(note.path)}`,
            ...(where ? [where] : []),
            ...note.snippets.map((line) => `- ${line}`),
            '',
          ]
        })
      : ['Nenhuma nota encontrada para estes termos.', '']
    return [...header, ...related].join('\n').trimEnd() + '\n'
  }
  let text = render()
  while (text.length > max) {
    const victim = [...notes].reverse().find((note) => note.snippets.length > 0)
    if (!victim) break
    victim.snippets.pop()
    text = render()
  }
  return text.length > max ? `${text.slice(0, max - 2).trimEnd()}…\n` : text
}

export type ContextStatus = 'pending' | 'ready' | 'failed' | 'off'

/** Why the vault could not be consulted. */
export type ContextFailure = 'no-vault' | 'unreachable' | 'timeout' | 'write'

export type ContextNote = {
  path: string
  title: string
  /** The day's session note, a note of the Orchestra folder, or a search hit. */
  kind: 'session' | 'folder' | 'search'
  terms: string[]
}

export type ObsidianContext = {
  status: ContextStatus
  /** When the consultation started. */
  at: number
  notes: ContextNote[]
  terms: string[]
  /** Absolute path of the file the agents read; null until it is written. */
  file: string | null
  failure: ContextFailure | null
  /** Backend detail of the failure. */
  detail: string | null
  elapsedMs: number
  /** Size of the block written to the file. */
  chars: number
}

export function contextState(
  status: ContextStatus,
  at: number,
  patch: Partial<Omit<ObsidianContext, 'status' | 'at'>> = {},
): ObsidianContext {
  return {
    status,
    at,
    notes: [],
    terms: [],
    file: null,
    failure: null,
    detail: null,
    elapsedMs: 0,
    chars: 0,
    ...patch,
  }
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; timeout: boolean }

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/**
 * Starts `run` and settles with its outcome, or with a timeout once `ms` ran out. Never
 * rejects, and nothing starts when no time is left.
 */
export function settleWithin<T>(run: () => Promise<T>, ms: number): Promise<Outcome<T>> {
  if (ms <= 0) return Promise.resolve({ ok: false, error: 'timeout', timeout: true })
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout', timeout: true }), ms)
    const settle = (outcome: Outcome<T>) => {
      clearTimeout(timer)
      resolve(outcome)
    }
    try {
      run().then(
        (value) => settle({ ok: true, value }),
        (error: unknown) => settle({ ok: false, error: errorText(error), timeout: false }),
      )
    } catch (error) {
      settle({ ok: false, error: errorText(error), timeout: false })
    }
  })
}

/** The Obsidian calls the consultation makes, injected so tests never reach a real vault. */
export type ContextDeps = {
  search: (query: string) => Promise<ObsidianSearchResult>
  read: (notePath: string, tail: boolean) => Promise<ObsidianNote>
  list: (dir: string) => Promise<string[]>
  /** Saves the block where the agents read it; resolves to the file path. */
  write: (markdown: string) => Promise<string>
  now?: () => number
}

export type ContextRequest = {
  at: number
  subject: ContextSubject
  vaultPath: string
  /** Vault-relative path of the day's session note; its folder is the Orchestra folder. */
  sessionNote: string
  /** Related notes kept besides the session note. */
  maxNotes: number
  budgetMs?: number
  maxChars?: number
}

function localDay(at: number): string {
  return stamp(at).slice(0, 10)
}

/**
 * Consults the vault for a session about to start and writes the block for its agents. Bounded
 * by `budgetMs` and never rejects: when Obsidian does not answer at all the result is `failed`
 * (with the reason), and what answers in time is used even if the rest did not.
 */
export async function gatherObsidianContext(
  request: ContextRequest,
  deps: ContextDeps,
): Promise<ObsidianContext> {
  const now = deps.now ?? Date.now
  const started = now()
  const deadline = started + (request.budgetMs ?? CONTEXT_BUDGET_MS)
  const left = (reserve = 0) => deadline - now() - reserve
  const finish = (status: ContextStatus, patch: Partial<ObsidianContext> = {}) =>
    contextState(status, request.at, { ...patch, elapsedMs: now() - started })

  const terms = contextTerms(request.subject)
  const queries = searchQueries(terms)
  const folder = noteFolder(request.sessionNote)

  // Everything that does not depend on another answer, at once.
  const [session, listing, searches] = await Promise.all([
    settleWithin(() => deps.read(request.sessionNote, true), left(WRITE_RESERVE_MS)),
    settleWithin(() => deps.list(folder), left(WRITE_RESERVE_MS)),
    Promise.all(
      queries.map((query) => settleWithin(() => deps.search(query.query), left(WRITE_RESERVE_MS))),
    ),
  ])
  const answers: Outcome<unknown>[] = [session, listing, ...searches]
  // A session note that does not exist yet is still an answer: Obsidian is up.
  const sessionMissing = !session.ok && /not found/i.test(session.error)
  if (!sessionMissing && !answers.some((outcome) => outcome.ok)) {
    const failures = answers.filter(
      (outcome): outcome is Extract<Outcome<unknown>, { ok: false }> => !outcome.ok,
    )
    const timedOut = failures.every((outcome) => outcome.timeout)
    return finish('failed', {
      terms,
      failure: timedOut ? 'timeout' : 'unreachable',
      detail: failures.find((outcome) => !outcome.timeout)?.error ?? 'timeout',
    })
  }

  const folderNotes = listing.ok
    ? listing.value
        .filter((entry) => /\.md$/i.test(entry) && !entry.endsWith('/'))
        .map((entry) => (folder ? `${folder}/${entry}` : entry))
    : []
  const runs: SearchRun[] = []
  searches.forEach((outcome, index) => {
    if (outcome.ok) runs.push({ term: queries[index].term, result: outcome.value })
  })
  const ranked = pickNotes(
    rankNotes({
      runs,
      terms,
      folderNotes,
      exclude: [request.sessionNote],
      today: localDay(request.at),
    }),
    request.maxNotes,
    folder,
  )

  // The best notes are read for their relevant lines; one that does not answer in time is
  // quoted from its search contexts.
  const maxChars = request.maxChars ?? CONTEXT_MAX_CHARS
  const perNote = Math.max(
    240,
    Math.floor(
      (maxChars - HEADER_CHARS - SESSION_NOTE_CHARS - ranked.length * NOTE_OVERHEAD) /
        Math.max(1, ranked.length),
    ),
  )
  const reads = await Promise.all(
    ranked.map((note) => settleWithin(() => deps.read(note.path, false), left(WRITE_RESERVE_MS))),
  )
  const sources: ContextSource[] = ranked.map((note, index) => {
    const read = reads[index]
    const snippets = read.ok
      ? noteSnippets(read.value.content, terms, perNote)
      : noteSnippets(note.contexts.join('\n'), terms, perNote)
    return { path: note.path, terms: note.terms, snippets }
  })

  const sessionDigest = session.ok
    ? sessionNoteDigest(session.value.content, SESSION_NOTE_CHARS)
    : null
  const markdown = buildContextMarkdown({
    at: request.at,
    vaultPath: request.vaultPath,
    terms,
    sessionNote: request.sessionNote,
    sessionDigest,
    notes: sources,
    maxChars,
  })
  const notes: ContextNote[] = [
    ...(session.ok
      ? [
          {
            path: request.sessionNote,
            title: noteTitle(request.sessionNote),
            kind: 'session' as const,
            terms: [],
          },
        ]
      : []),
    ...ranked.map((note) => ({
      path: note.path,
      title: noteTitle(note.path),
      kind: note.inFolder ? ('folder' as const) : ('search' as const),
      terms: note.terms,
    })),
  ]

  const written = await settleWithin(() => deps.write(markdown), Math.max(left(), MIN_WRITE_MS))
  if (!written.ok) {
    return finish('failed', { notes, terms, failure: 'write', detail: written.error })
  }
  return finish('ready', { notes, terms, file: written.value, chars: markdown.length })
}
