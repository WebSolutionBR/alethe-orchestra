/**
 * Applies one write of the author's plan to the vault, through the Local REST API. Whole
 * notes are written only when the scribe created them (its marker is in the frontmatter) and
 * nobody changed them since the author read them; every other note only gets text appended
 * under a heading. Nothing is ever deleted.
 */
import {
  ABSENT,
  contentHash,
  hasScribeMarker,
  headingPath,
  linkTargets,
  RELATED_HEADING,
  RELATED_HEADINGS,
  sectionIsLast,
  topHeading,
  type WriteOp,
} from './author'
import { noteName } from './notePath'
import { type ApplyResult, ConflictWriteError, PermanentWriteError } from './queue'

export type WriterDeps = {
  /** The note's markdown; null when it does not exist. `tail` reads the end of long notes. */
  read: (
    notePath: string,
    tail?: boolean,
  ) => Promise<{ content: string; truncated: boolean } | null>
  put: (notePath: string, content: string) => Promise<void>
  patch: (
    notePath: string,
    heading: string[],
    content: string,
  ) => Promise<{ applied: boolean; preexisting: boolean }>
  append: (notePath: string, content: string) => Promise<void>
}

/** Errors from the backend that mean the request itself was wrong, not that Obsidian is away. */
function permanentFromBackend(message: string): boolean {
  return /invalid (note path|heading|folder)|too large|answered 4\d\d|empty (note|section)/i.test(
    message,
  )
}

async function guarded<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof PermanentWriteError) throw error
    if (permanentFromBackend(message)) throw new PermanentWriteError(message)
    throw error instanceof Error ? error : new Error(message)
  }
}

/** Text that goes at the end of a section: on a line of its own, ending with a newline. */
function sectionText(markdown: string, path: string[], text: string): string {
  const lead = sectionIsLast(markdown, path) && !/\n$/.test(markdown) ? '\n' : ''
  return `${lead}${text.trim()}\n`
}

async function applyPut(
  op: Extract<WriteOp, { kind: 'put' }>,
  deps: WriterDeps,
): Promise<ApplyResult> {
  const current = await guarded(() => deps.read(op.notePath))
  if (current !== null) {
    if (contentHash(current.content) === contentHash(op.content)) return { status: 'unchanged' }
    if (!hasScribeMarker(current.content))
      throw new PermanentWriteError(
        'a nota já existe e não foi criada pelo escriba: não é sobrescrita',
      )
    // A subject note the author meant to create already exists: it only gets sections.
    if (op.expect === ABSENT && !op.diary)
      throw new PermanentWriteError('a nota já existe: o autor deve acrescentar uma seção a ela')
    if (op.expect === ABSENT)
      throw new ConflictWriteError(
        'a nota passou a existir depois que o autor começou: não é sobrescrita',
      )
    if (current.truncated || contentHash(current.content) !== op.expect)
      throw new ConflictWriteError('a nota mudou depois que o autor a leu: a próxima passada refaz')
  }
  await guarded(() => deps.put(op.notePath, op.content))
  return { status: 'written' }
}

async function applySection(
  op: Extract<WriteOp, { kind: 'section' }>,
  deps: WriterDeps,
): Promise<ApplyResult> {
  const current = await guarded(() => deps.read(op.notePath))
  const text = op.content.trim()
  if (current === null) {
    if (!op.createIfMissing) throw new PermanentWriteError('a nota não existe')
    await guarded(() =>
      deps.put(op.notePath, `# ${noteName(op.notePath)}\n\n## ${op.heading}\n${text}\n`),
    )
    return { status: 'written' }
  }
  if (current.truncated) {
    // Too long to map its headings: the text goes at the end, once.
    const tail = await guarded(() => deps.read(op.notePath, true))
    if (tail?.content.includes(text)) return { status: 'unchanged' }
    await guarded(() => deps.append(op.notePath, `\n\n## ${op.heading}\n${text}\n`))
    return { status: 'written' }
  }
  const found = headingPath(current.content, op.heading)
  const top = topHeading(current.content)
  const path = found ?? (top ? [top, op.heading] : null)
  if (!path) {
    if (current.content.includes(text)) return { status: 'unchanged' }
    await guarded(() => deps.append(op.notePath, `\n\n## ${op.heading}\n${text}\n`))
    return { status: 'written' }
  }
  const result = await guarded(() =>
    deps.patch(op.notePath, path, sectionText(current.content, path, text)),
  )
  return { status: result.preexisting ? 'unchanged' : 'written' }
}

async function applyHub(
  op: Extract<WriteOp, { kind: 'hub' }>,
  done: string[],
  deps: WriterDeps,
): Promise<ApplyResult> {
  const missing = op.requires.filter(
    (path) => !done.some((d) => d.toLowerCase() === path.toLowerCase()),
  )
  if (missing.length)
    throw new PermanentWriteError(
      `a nota que o hub linkaria não foi gravada: ${missing.join(', ')}`,
    )
  const current = await guarded(() => deps.read(op.notePath))
  if (current === null) throw new PermanentWriteError('o hub não existe')
  const view = current.truncated ? await guarded(() => deps.read(op.notePath, true)) : current
  const markdown = view?.content ?? current.content
  const linked = new Set(linkTargets(markdown).map((t) => noteName(t).toLowerCase()))
  const lines = op.lines.filter((line) =>
    linkTargets(line).some((target) => !linked.has(noteName(target).toLowerCase())),
  )
  if (lines.length === 0) return { status: 'unchanged' }
  const text = lines.join('\n')
  const candidates = [op.heading, ...RELATED_HEADINGS.filter((h) => h !== op.heading)]
  const path = current.truncated
    ? null
    : (candidates.map((heading) => headingPath(markdown, heading)).find(Boolean) ?? null)
  if (path) {
    await guarded(() => deps.patch(op.notePath, path, sectionText(markdown, path, text)))
    return { status: 'written' }
  }
  // No related-notes section yet: the owner's closing goes at the end of the note.
  const closing = headingPath(markdown, RELATED_HEADING)
    ? `\n${text}\n`
    : `\n\n---\n\n# ${RELATED_HEADING}\n${text}\n`
  await guarded(() => deps.append(op.notePath, closing))
  return { status: 'written' }
}

/** Applies one operation; throws `PermanentWriteError` when it can never be written. */
export function applyWriteOp(op: WriteOp, done: string[], deps: WriterDeps): Promise<ApplyResult> {
  switch (op.kind) {
    case 'put':
      return applyPut(op, deps)
    case 'section':
      return applySection(op, deps)
    case 'hub':
      return applyHub(op, done, deps)
  }
}
