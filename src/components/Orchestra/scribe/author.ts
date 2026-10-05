/**
 * The scribe's author, on the app side: the prompt it gets, the write plan it answers with,
 * and the checks that plan goes through before anything reaches the vault. Pure functions.
 *
 * The author is a read-only `claude -p` run (see `src-tauri/src/scribe_runner.rs`). It never
 * writes: it returns a plan, and the app redacts secrets, drops links to notes that do not
 * exist, refuses to overwrite notes the scribe did not create, and only ever appends to the
 * owner's own notes.
 */
import { brDate, explorerPath, hhmm, noteName } from './notePath'
import { REDACTED, redactSecrets } from './redact'

/** Frontmatter line that marks a note the scribe created (and may rewrite as a whole). */
export const SCRIBE_MARKER_KEY = 'escriba'
export const SCRIBE_MARKER_VALUE = 'alethe-orchestra'
/** The closing section every new note has, per the owner's rules (H1, exactly this text). */
export const RELATED_HEADING = 'Notas relacionadas'
/** Headings hubs use for their related notes, in the order they are looked for. */
export const RELATED_HEADINGS = [
  RELATED_HEADING,
  'Relacionados',
  'Relacionadas',
  'Links relacionados',
]
/** The token the author uses for the session's own diary note. */
export const DIARY_TOKEN = '@diary'

const MAX_FULL_NOTE = 200_000
const MAX_SECTION = 60_000
const MAX_OTHER_NOTES = 3
const MAX_HUBS = 4
const MAX_HUB_LINES = 6

export type AuthorTriggerKind = 'worker-done' | 'session-end' | 'manual' | 'resume'

export type AuthorAgent = {
  id: string
  area: string
  state: string
  progress: number
  task: string
  note: string
  transcriptPath: string | null
  /** Earlier tasks of the agent, oldest first. */
  history: { task: string; note: string }[]
}

export type AuthorSource = { path: string; content: string; truncated: boolean }

export type AuthorInput = {
  now: number
  trigger: AuthorTriggerKind
  /** Workers whose completion triggered this run. */
  finished: string[]
  /** Last pass of the session: summary, conclusions, notes touched and pending items. */
  final: boolean
  session: {
    id: string
    goal: string
    cwd: string | null
    projectName: string | null
    startedAt: number | null
    endedAt: number | null
  }
  agents: AuthorAgent[]
  /** Absolute path of the vault. */
  vaultPath: string
  /** The note the agents record their own sections in (vault-relative). */
  workNote: string
  diary: {
    /** Vault-relative path the session's diary note has (or will have). */
    path: string
    /** Its content when it already exists. */
    current: { content: string; truncated: boolean } | null
    /** Folder the day's diary notes go to, and the ones already there. */
    folder: string
    todayNotes: string[]
  }
  template: { path: string; content: string; live: boolean }
  rules: { path: string; content: string } | null
  example: { path: string; content: string } | null
  /** Notes read from Obsidian when the session started. */
  contextNotes: string[]
  /** Heads of the agents' task files. */
  sources: AuthorSource[]
  /** The rendered session material. */
  material: string
  /** Folder for a subject note when no related note suggests one. */
  topicFolder: string
  /** The Obsidian MCP server is available to the author. */
  mcp: boolean
}

const CAPS = {
  template: 8_000,
  rules: 8_000,
  example: 10_000,
  diary: 40_000,
  source: 6_000,
  sources: 30_000,
  task: 400,
  note: 300,
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… cortado em ${max} caracteres]`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** A fenced block that cannot be closed early by the text inside it. */
function fenced(text: string, lang = ''): string {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return `${fence}${lang}\n${text.replace(/\s+$/, '')}\n${fence}`
}

function cell(text: string): string {
  return text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '—'
}

/** A diary note the author cannot be shown whole may only get sections, never a rewrite. */
export function diaryAppendOnly(current: { content: string; truncated: boolean } | null): boolean {
  return Boolean(current && (current.truncated || current.content.length > CAPS.diary))
}

function triggerText(input: AuthorInput): string {
  const names = input.finished.length ? input.finished.join(', ') : ''
  switch (input.trigger) {
    case 'worker-done':
      return `Worker(s) ${names || '(unknown)'} just finished. Update the session's diary note: write or refresh the case (\`###\` under "Casos / atividades") of each finished front with its context, what was done and the decision with its reason, validation and gotcha. Keep the rest of the note accurate.`
    case 'session-end':
    case 'resume':
      return 'The session ended. This is the final pass: make the diary note complete — Resumo do dia, every case, Pontos-chave / decisões, O que foi aprendido (gotchas), Conclusões, Notas tocadas and A fazer / pendências — and create or update the subject note when the theme deserves one, linking it from the hubs.'
    default:
      return "The owner asked for the note now. Bring the session's diary note up to date with everything so far (the session may still be running: say what is still open)."
  }
}

/** The whole prompt of a run, sent to the author through stdin. */
export function buildAuthorPrompt(input: AuthorInput): string {
  const vault = explorerPath(input.vaultPath)
  const transcripts = input.agents.filter((a) => a.transcriptPath)
  const parts: string[] = []

  parts.push(
    [
      'You are the author of the Obsidian notes of an Alethe Orchestra session (the "Escriba Obsidian").',
      'The owner of the vault wants knowledge notes, not logs. In his own words:',
      '> "A minha ideia não era ele registrar logs de tudo que é do Alethe Orchestra, e sim registrar com base nos padrões de anotações que eu tenho no Obsidian, de forma a linkar os raciocínios, ter um conteúdo realmente útil, que no futuro a IA possa vasculhar e traçar caminhos e linhas de raciocínio a partir das anotações. Ou seja, elas têm começo, meio e fim, têm propósito, aprendizado, os links relacionados, objetivos futuros, próximos passos. São anotações completas, que servem tanto para mim consultar quanto para as IAs."',
    ].join('\n'),
  )

  parts.push(`## Your job now\n${triggerText(input)}`)

  parts.push(
    [
      '## Rules (mandatory)',
      '1. Write in Brazilian Portuguese. Dates in the text as DD/MM/AAAA; the frontmatter `data:` field and file names keep AAAA-MM-DD, as the template shows.',
      "2. Follow the template and the owner's rules below. A note has a beginning, a middle and an end: purpose and context, what was done with each decision and its reason, how it was validated, the gotchas (what almost went wrong or misled), conclusions, next steps and future goals.",
      '3. Knowledge, never a log: no command transcripts, no raw tool output, no event-by-event timestamps. Summarize. Write file paths in full Windows Explorer form (C:\\Users\\...) and only when they matter.',
      `4. Links: write [[Note name]] only for notes that exist in the vault (check with Glob/Grep on the vault folder${input.mcp ? ' or the obsidian MCP read tools' : ''}) or that you create in this plan. Never invent a note name; the app removes links to notes that do not exist.`,
      `5. Every note you create ends with a line \`---\` and then \`# ${RELATED_HEADING}\` (H1, exactly this text) listing 3 to 5 real links, each followed by " — " and a short comment. When you add to an existing note, never remove or rewrite what is there: only add.`,
      '6. Hubs: link each note you create from the hub(s) of its theme (for example [[Alethe]] or the subject note) under their related-notes heading ("Notas relacionadas", or "Relacionados" when that is what the hub has).',
      "7. A subject note (nota de assunto) only when the theme deserves its own note: a feature, a recurring problem, a decision with history. Put it in the theme's folder, next to its related notes, never at the vault root; prefer adding a dated section to an existing subject note over creating a near-duplicate.",
      `8. Never write secrets: tokens, keys, passwords, credentials in URLs, dump contents, the Obsidian API key. Write "${REDACTED}" instead.`,
      '9. You have no write tools and cannot delete anything: you only return the plan below. Alethe Orchestra checks it and writes it.',
      '10. The transcripts and the task files are there for you to understand WHY each decision was taken. Read only what you need (Grep for keywords, Read with offset/limit) and never paste them into the note.',
    ].join('\n'),
  )

  parts.push(
    [
      '## Tools',
      `- Read, Grep and Glob on the vault folder "${vault}" (leave its .obsidian folder alone) and on your working folder${transcripts.length ? ", where the agents' transcripts are in transcripts/ (one JSONL per agent)" : ''}${input.sources.length ? ' and copies of their task files in tarefas/' : ''}. Nothing else on this computer is readable.`,
      input.mcp
        ? '- The read tools of the obsidian MCP server (search, get file contents, list files).'
        : '',
      '- No shell, no edits, no web access.',
    ]
      .filter(Boolean)
      .join('\n'),
  )

  const s = input.session
  const sessionLines = [
    '## The session',
    s.projectName ? `- Projeto: ${s.projectName}` : '',
    s.cwd ? `- Pasta: ${explorerPath(s.cwd)}` : '',
    `- Objetivo: ${oneLine(s.goal, 1_500) || '—'}`,
    s.startedAt ? `- Início: ${brDate(s.startedAt)} ${hhmm(s.startedAt)}` : '',
    s.endedAt ? `- Fim: ${brDate(s.endedAt)} ${hhmm(s.endedAt)}` : '- Fim: ainda em andamento',
    `- Hoje: ${brDate(input.now)}`,
    `- Nota de trabalho dos agentes (cada worker registra a própria seção ali): [[${noteName(input.workNote)}]] em "${input.workNote}". Leia as seções dos agentes desta sessão e linke essa nota na nota do diário.`,
    input.contextNotes.length
      ? `- Notas consultadas no Obsidian quando a sessão começou: ${input.contextNotes.map((p) => `[[${noteName(p)}]]`).join(', ')}`
      : '',
  ]
  parts.push(sessionLines.filter(Boolean).join('\n'))

  if (input.agents.length) {
    const rows = input.agents.map((a) => {
      const earlier = a.history.length
        ? ` (antes: ${a.history.map((h) => oneLine(h.task, 80)).join('; ')})`
        : ''
      return `| ${a.id} | ${cell(a.area)} | ${cell(a.state)} | ${a.progress}% | ${cell(`${oneLine(a.task, CAPS.task)}${earlier}`)} | ${cell(oneLine(a.note, CAPS.note))} | ${a.transcriptPath ? `transcripts/${a.id}.jsonl` : '—'} |`
    })
    parts.push(
      [
        '## Agents',
        '| id | área | estado | progresso | tarefa | última nota | transcript (JSONL) |',
        '|---|---|---|---|---|---|---|',
        ...rows,
      ].join('\n'),
    )
  }

  if (input.sources.length) {
    let budget = CAPS.sources
    const blocks: string[] = []
    for (const source of input.sources) {
      if (budget <= 0) break
      const text = cap(redactSecrets(source.content), Math.min(CAPS.source, budget))
      budget -= text.length
      blocks.push(
        `### ${explorerPath(source.path)}${source.truncated ? ' (início)' : ''}\n${fenced(text, 'markdown')}`,
      )
    }
    parts.push(
      `## Task files of the agents (whole copies in tarefas/ of your working folder)\n${blocks.join('\n\n')}`,
    )
  }

  const diary = input.diary
  const diaryLines = [
    "## The session's diary note",
    diary.current
      ? `- Path: "${diary.path}". Its block in the plan uses path="${DIARY_TOKEN}"; link to it as [[${DIARY_TOKEN}]].`
      : `- The app names it from your TITLE: "${diary.path}", with your title in place of {title}. Its block in the plan uses path="${DIARY_TOKEN}"; link to it as [[${DIARY_TOKEN}]] (in hubs and subject notes) and the app writes the final name.`,
  ]
  if (diary.current) {
    diaryLines.push(
      diaryAppendOnly(diary.current)
        ? '- It already exists and is too long to rewrite: only add to it, with mode="section" blocks under its headings (for example "Casos / atividades").'
        : '- It already exists. Rewrite it whole (mode="full"): keep what is still right, update the rest, and never drop what the owner or the agents added to it.',
      fenced(cap(redactSecrets(diary.current.content), CAPS.diary), 'markdown'),
    )
  } else {
    diaryLines.push(
      `- It does not exist yet. Diary notes already written today in "${diary.folder}": ${diary.todayNotes.length ? diary.todayNotes.map((n) => `[[${noteName(n)}]]`).join(', ') : 'none'}.`,
      '- If one of those covers the same subject, do not create a duplicate: add a new case to it with mode="section" (heading "Casos / atividades", or the heading that note uses for its cases) and leave out the @diary note.',
    )
  }
  parts.push(diaryLines.join('\n'))

  parts.push(
    `## Template${input.template.live ? ` (read live from "${input.template.path}")` : ' (built-in copy; the vault template could not be read)'}\n${fenced(cap(input.template.content, CAPS.template), 'markdown')}`,
  )
  if (input.rules) {
    parts.push(
      `## The owner's rules for notes (read live from "${input.rules.path}")\n${fenced(cap(redactSecrets(input.rules.content), CAPS.rules), 'markdown')}`,
    )
  }
  if (input.example) {
    parts.push(
      `## Example of a good note ("${input.example.path}")\n${fenced(cap(redactSecrets(input.example.content), CAPS.example), 'markdown')}`,
    )
  }

  parts.push(
    `## Session material (local events: requests, decisions, reports, messages, files touched, checks; secrets already masked)\n${fenced(input.material || '(vazio)', 'text')}`,
  )

  parts.push(
    [
      '## Reply format',
      'Reply with the plan only, nothing before or after it, in exactly this format:',
      '',
      '=== TITLE ===',
      'Short subject of the session in Portuguese, no date (it names the diary note).',
      '=== END ===',
      '=== SUMMARY ===',
      'One line in Portuguese saying what this pass added.',
      '=== END ===',
      `=== NOTE path="${DIARY_TOKEN}" mode="full" ===`,
      'The whole diary note, frontmatter included.',
      '=== END ===',
      '',
      'Optional blocks, as needed:',
      `=== NOTE path="${input.topicFolder ? `${input.topicFolder}/` : ''}<Subject note>.md" mode="full" ===   (a NEW subject note; full vault-relative path)`,
      '=== NOTE path="<existing note>.md" mode="section" heading="<heading of that note>" ===   (text appended under that heading of an existing note)',
      `=== HUB path="<hub note>.md" heading="${RELATED_HEADING}" ===   (one link per line, e.g. "- [[New note]] — short comment")`,
      'Each block ends with a line "=== END ===". mode="full" is only for the @diary note and for notes that do not exist yet.',
    ].join('\n'),
  )

  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ the plan */

export type PlanNote = {
  path: string
  mode: 'full' | 'section'
  heading: string | null
  content: string
}
export type PlanHub = { path: string; heading: string; lines: string[] }
export type AuthorPlan = {
  title: string | null
  summary: string | null
  notes: PlanNote[]
  hubs: PlanHub[]
}

const BLOCK_HEAD = /^\s*===\s*(TITLE|SUMMARY|NOTE|HUB)\b(.*?)===\s*$/
const BLOCK_END = /^\s*===\s*END\s*===\s*$/

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of text.matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g))
    out[match[1].toLowerCase()] = match[2]
  return out
}

/** Reads the author's answer; null when it holds no block at all. */
export function parseAuthorPlan(text: string): AuthorPlan | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const plan: AuthorPlan = { title: null, summary: null, notes: [], hubs: [] }
  let found = false
  let i = 0
  while (i < lines.length) {
    const head = BLOCK_HEAD.exec(lines[i])
    if (!head) {
      i++
      continue
    }
    found = true
    const kind = head[1]
    const attrs = attributes(head[2])
    const body: string[] = []
    i++
    while (i < lines.length && !BLOCK_END.test(lines[i]) && !BLOCK_HEAD.test(lines[i])) {
      body.push(lines[i])
      i++
    }
    if (i < lines.length && BLOCK_END.test(lines[i])) i++
    const content = body.join('\n').replace(/^\n+|\s+$/g, '')
    if (kind === 'TITLE') plan.title = oneLine(content, 200) || null
    else if (kind === 'SUMMARY') plan.summary = oneLine(content, 400) || null
    else if (kind === 'NOTE' && attrs.path)
      plan.notes.push({
        path: attrs.path.trim(),
        mode: attrs.mode === 'section' ? 'section' : 'full',
        heading: attrs.heading?.trim() || null,
        content,
      })
    else if (kind === 'HUB' && attrs.path)
      plan.hubs.push({
        path: attrs.path.trim(),
        heading: attrs.heading?.trim() || RELATED_HEADING,
        lines: content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('-') && l.includes('[[')),
      })
  }
  return found ? plan : null
}

/* ------------------------------------------------------------------ links */

export type VaultIndex = { has: (target: string) => boolean }

/** Resolves wikilink targets the way Obsidian does: by name anywhere, or by a path suffix. */
export function buildVaultIndex(paths: string[]): VaultIndex {
  const names = new Set<string>()
  const full = new Set<string>()
  const list: string[] = []
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    if (!path) continue
    const bare = path.replace(/\.md$/, '')
    full.add(bare)
    full.add(path)
    list.push(bare)
    const file = path.split('/').pop() as string
    names.add(file)
    names.add(file.replace(/\.md$/, ''))
  }
  return {
    has: (target) => {
      const t = target.replace(/\\/g, '/').replace(/^\/+/, '').trim().toLowerCase()
      if (!t) return false
      const bare = t.replace(/\.md$/, '')
      if (full.has(bare) || full.has(t)) return true
      if (!t.includes('/')) return names.has(t) || names.has(bare)
      return list.some((p) => p.endsWith(`/${bare}`))
    },
  }
}

const WIKILINK = /(!?)\[\[([^\]|#^\n]*)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g

/** Targets of every wikilink in `text` (headings and aliases left out). */
export function linkTargets(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[2].trim()
    if (target) out.push(target)
  }
  return out
}

/**
 * Keeps links whose note exists (or is in `extra`); the others become plain text: the alias
 * when there is one, else the note name. Returns the new text and the dropped targets.
 */
export function pruneLinks(
  text: string,
  index: VaultIndex | null,
  extra: string[] = [],
): { text: string; dropped: string[] } {
  if (!index) return { text, dropped: [] }
  const known = buildVaultIndex(extra)
  const dropped: string[] = []
  const out = text.replace(
    WIKILINK,
    (
      match: string,
      _embed: string,
      target: string,
      _sub: string | undefined,
      alias: string | undefined,
    ) => {
      const name = target.trim()
      // `[[#Heading]]` points inside the same note.
      if (!name || index.has(name) || known.has(name)) return match
      dropped.push(name)
      return alias?.trim() || noteName(name)
    },
  )
  return { text: out, dropped }
}

/* ------------------------------------------------------------------ markdown helpers */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** True when the note carries the scribe's marker in its frontmatter. */
export function hasScribeMarker(markdown: string): boolean {
  const front = FRONTMATTER.exec(markdown)
  if (!front) return false
  return new RegExp(`^${SCRIBE_MARKER_KEY}:\\s*["']?${SCRIBE_MARKER_VALUE}["']?\\s*$`, 'm').test(
    front[1],
  )
}

/** Adds the scribe's marker to the frontmatter (creating one when the note has none). */
export function withScribeMarker(markdown: string): string {
  if (hasScribeMarker(markdown)) return markdown
  const line = `${SCRIBE_MARKER_KEY}: ${SCRIBE_MARKER_VALUE}`
  const front = FRONTMATTER.exec(markdown)
  if (!front) return `---\n${line}\n---\n\n${markdown.replace(/^\n+/, '')}`
  const end = front.index + front[0].length
  const block = front[0].replace(/\r?\n---[ \t]*(\r?\n|$)$/, `\n${line}\n---$1`)
  return `${block}${markdown.slice(end)}`
}

type Heading = { level: number; text: string; line: number }

function headings(markdown: string): Heading[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: Heading[] = []
  let i = 0
  const front = FRONTMATTER.exec(markdown)
  if (front) i = front[0].replace(/\r\n?/g, '\n').split('\n').length - 1
  let fence: string | null = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (opener) {
      if (fence === null) fence = opener[1][0]
      else if (opener[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (match) out.push({ level: match[1].length, text: match[2].trim(), line: i })
  }
  return out
}

/**
 * The path from the top heading down to the first heading called `name` (case and spacing
 * ignored), as the Local REST API wants it for a heading patch; null when there is none.
 */
export function headingPath(markdown: string, name: string): string[] | null {
  const wanted = name.replace(/\s+/g, ' ').trim().toLowerCase()
  const stack: Heading[] = []
  for (const heading of headings(markdown)) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack.push(heading)
    if (heading.text.replace(/\s+/g, ' ').toLowerCase() === wanted) return stack.map((h) => h.text)
  }
  return null
}

/** The note's first H1, which a new section goes under. */
export function topHeading(markdown: string): string | null {
  return headings(markdown).find((h) => h.level === 1)?.text ?? null
}

/** Whether the section a heading path names runs to the end of the note. */
export function sectionIsLast(markdown: string, path: string[]): boolean {
  const all = headings(markdown)
  const leaf = path[path.length - 1]?.toLowerCase()
  const index = all.findIndex((h) => h.text.toLowerCase() === leaf)
  if (index < 0) return true
  const level = all[index].level
  return !all.slice(index + 1).some((h) => h.level <= level)
}

/**
 * Makes sure a new note ends with the owner's closing section; when the author forgot it,
 * one is added with the note's own links (at most five). Unchanged when there are none.
 */
export function withRelatedClosing(markdown: string): string {
  if (headingPath(markdown, RELATED_HEADING)) return markdown
  const seen = new Set<string>()
  const links: string[] = []
  for (const target of linkTargets(markdown)) {
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    links.push(`- [[${target}]] — citada nesta nota`)
    if (links.length === 5) break
  }
  if (links.length === 0) return markdown
  return `${markdown.replace(/\s+$/, '')}\n\n---\n\n# ${RELATED_HEADING}\n${links.join('\n')}\n`
}

/** FNV-1a of the note with line endings and trailing spaces normalized: change detection. */
export function contentHash(markdown: string): string {
  const text = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/* ------------------------------------------------------------------ preparing the plan */

/** `expect` of a whole-note write: the hash the author saw, or `absent` for a new note. */
export const ABSENT = 'absent'

export type WriteOp =
  | { kind: 'put'; notePath: string; content: string; expect: string; diary: boolean }
  | {
      kind: 'section'
      notePath: string
      heading: string
      content: string
      diary: boolean
      /** Creates the note (titled after its name) when it does not exist yet. */
      createIfMissing?: boolean
    }
  | { kind: 'hub'; notePath: string; heading: string; lines: string[]; requires: string[] }

export type PreparedPlan = {
  ops: WriteOp[]
  title: string | null
  summary: string | null
  /** The note the session points to (the diary note, or the same-day note it added to). */
  sessionNote: string | null
  /** What was dropped or refused, in Portuguese, for the panel. */
  issues: string[]
}

export type PrepareContext = {
  diaryPath: string
  /** Folder of the day's diary notes: a section added to a note there names the session. */
  diaryFolder: string
  /** Hash of the diary note the author was shown, or ABSENT when it did not exist. */
  diaryExpect: string
  /** The diary note is too long to have been shown whole: it may only get sections. */
  diaryAppendOnly: boolean
  index: VaultIndex | null
  /** Notes the author must never write as a whole (template, rules, example). */
  protectedPaths: string[]
}

/** A vault-relative `.md` path the scribe may write, or null. */
export function safeNotePath(path: string): string | null {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  if (
    parts.some(
      (p) =>
        p === '.' || p === '..' || p.startsWith('.') || /[:*?"<>|]/.test(p) || /\p{Cc}/u.test(p),
    )
  )
    return null
  const file = parts[parts.length - 1]
  if (!/\.md$/i.test(file) || file.length < 4) return null
  return parts.join('/')
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Turns the author's plan into write operations the app can trust: secrets masked, links to
 * missing notes unlinked, paths kept inside the vault, the scribe's marker on its own notes,
 * the owner's closing section on new notes, and caps on how much one pass may touch.
 */
export function preparePlan(plan: AuthorPlan, ctx: PrepareContext): PreparedPlan {
  const issues: string[] = []
  const ops: WriteOp[] = []
  const title = plan.title ? redactSecrets(plan.title) : null
  const summary = plan.summary ? redactSecrets(plan.summary) : null
  let sessionNote: string | null = null
  let others = 0

  // Paths this plan creates count as existing for its links.
  const planned: string[] = []
  for (const note of plan.notes) {
    if (note.path === DIARY_TOKEN) planned.push(ctx.diaryPath)
    else if (note.mode === 'full') {
      const path = safeNotePath(note.path)
      if (path) planned.push(path)
    }
  }

  // `[[@diary]]` stands for the session's diary note, whose name the app decides.
  const diaryLink = (text: string) =>
    text.replace(/\[\[\s*@diary\s*(?=[\]|#])/gi, `[[${noteName(ctx.diaryPath)}`)
  const clean = (text: string) => {
    const { text: linked, dropped } = pruneLinks(diaryLink(redactSecrets(text)), ctx.index, planned)
    if (dropped.length)
      issues.push(`Links removidos (nota inexistente): ${[...new Set(dropped)].join(', ')}`)
    return linked
  }

  let diaryDone = false
  for (const note of plan.notes) {
    const isDiary = note.path === DIARY_TOKEN || samePath(note.path, ctx.diaryPath)
    const path = isDiary ? ctx.diaryPath : safeNotePath(note.path)
    if (!path) {
      issues.push(`Caminho recusado: ${note.path}`)
      continue
    }
    if (ctx.protectedPaths.some((p) => samePath(p, path))) {
      issues.push(`Nota protegida, não alterada: ${path}`)
      continue
    }
    if (!note.content.trim()) continue
    if (isDiary && diaryDone) {
      issues.push('Mais de uma versão da nota do diário: só a primeira foi usada')
      continue
    }
    if (!isDiary && others >= MAX_OTHER_NOTES) {
      issues.push(`Limite de ${MAX_OTHER_NOTES} notas por passada: ${path} ficou de fora`)
      continue
    }
    if (isDiary && note.mode === 'full' && ctx.diaryAppendOnly) {
      issues.push('A nota do diário é longa demais para ser reescrita: só seções são aceitas')
      continue
    }
    if (note.mode === 'section') {
      if (isDiary && ctx.diaryExpect === ABSENT) {
        issues.push('Seção para uma nota do diário que ainda não existe, ignorada')
        continue
      }
      if (!note.heading) {
        issues.push(`Seção sem título, ignorada: ${path}`)
        continue
      }
      const content = clean(note.content)
      if (content.length > MAX_SECTION) {
        issues.push(`Seção grande demais, ignorada: ${path}`)
        continue
      }
      ops.push({ kind: 'section', notePath: path, heading: note.heading, content, diary: isDiary })
    } else {
      const content = withScribeMarker(withRelatedClosing(clean(note.content)))
      if (content.length > MAX_FULL_NOTE) {
        issues.push(`Nota grande demais, ignorada: ${path}`)
        continue
      }
      ops.push({
        kind: 'put',
        notePath: path,
        content,
        expect: isDiary ? ctx.diaryExpect : ABSENT,
        diary: isDiary,
      })
    }
    if (isDiary) {
      diaryDone = true
      sessionNote = path
    } else {
      others++
      // An existing same-day note the author added the session's case to.
      const folder = ctx.diaryFolder.toLowerCase()
      if (
        !sessionNote &&
        note.mode === 'section' &&
        folder &&
        path.toLowerCase().startsWith(`${folder}/`)
      )
        sessionNote = path
    }
  }

  const written = ops.map((op) => op.notePath)
  const writtenMatch = (target: string) =>
    written.find(
      (w) =>
        samePath(noteName(w), noteName(target)) ||
        samePath(w.replace(/\.md$/i, ''), target.replace(/\.md$/i, '')),
    )
  for (const hub of plan.hubs.slice(0, MAX_HUBS)) {
    const path = safeNotePath(hub.path)
    if (!path) {
      issues.push(`Hub recusado: ${hub.path}`)
      continue
    }
    if (ctx.protectedPaths.some((p) => samePath(p, path))) continue
    const lines: string[] = []
    const requires = new Set<string>()
    for (const raw of hub.lines.slice(0, MAX_HUB_LINES)) {
      const line = diaryLink(redactSecrets(raw))
      const targets = linkTargets(line)
      // A hub line is only worth adding when every note it links exists or is written now.
      const missing = targets.filter(
        (t) => !writtenMatch(t) && ctx.index !== null && !ctx.index.has(t),
      )
      if (targets.length === 0 || missing.length > 0) {
        issues.push(`Link de hub sem nota, ignorado: ${line}`)
        continue
      }
      for (const target of targets) {
        const match = writtenMatch(target)
        if (match) requires.add(match)
      }
      lines.push(line)
    }
    if (lines.length)
      ops.push({
        kind: 'hub',
        notePath: path,
        heading: hub.heading,
        lines,
        requires: [...requires],
      })
  }
  if (plan.hubs.length > MAX_HUBS) issues.push(`Limite de ${MAX_HUBS} hubs por passada`)

  return { ops, title, summary, sessionNote, issues }
}
