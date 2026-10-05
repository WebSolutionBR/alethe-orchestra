/** Pure helpers for the composer's attachments: classification, dedup and the outgoing message. */

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'file'

export type Attachment = {
  id: string
  /** Absolute path on disk; the agent reads the file from here. */
  path: string
  name: string
  kind: AttachmentKind
  /** Object URL for an in-memory preview (pasted images); paths on disk have no preview. */
  previewUrl?: string
}

export type ComposerDraft = { text: string; attachments: Attachment[] }

export const EMPTY_DRAFT: ComposerDraft = { text: '', attachments: [] }

/** Revokes the in-memory previews of a draft that is being thrown away. */
export function releaseDraft(draft: ComposerDraft): void {
  for (const a of draft.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
}

const KINDS: Record<Exclude<AttachmentKind, 'file'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'wma'],
  pdf: ['pdf'],
  text: [
    'txt',
    'md',
    'markdown',
    'json',
    'jsonc',
    'yaml',
    'yml',
    'toml',
    'csv',
    'tsv',
    'log',
    'xml',
    'html',
    'htm',
    'css',
    'scss',
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'rs',
    'py',
    'go',
    'java',
    'kt',
    'rb',
    'php',
    'cs',
    'c',
    'h',
    'cpp',
    'hpp',
    'sh',
    'ps1',
    'bat',
    'cmd',
    'sql',
    'ini',
    'env',
  ],
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar'],
}

export function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

export function extensionOf(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function kindOf(path: string): AttachmentKind {
  const ext = extensionOf(path)
  if (!ext) return 'file'
  for (const [kind, exts] of Object.entries(KINDS)) {
    if (exts.includes(ext)) return kind as AttachmentKind
  }
  return 'file'
}

let counter = 0

export function makeAttachment(path: string, previewUrl?: string): Attachment {
  counter += 1
  return {
    id: `att-${Date.now().toString(36)}-${counter}`,
    path,
    name: fileName(path),
    kind: kindOf(path),
    previewUrl,
  }
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/** Appends the new paths, skipping blanks and files that are already attached. */
export function addPaths(
  current: Attachment[],
  paths: string[],
  previewUrl?: string,
): Attachment[] {
  const next = [...current]
  for (const raw of paths) {
    const path = raw.trim()
    if (!path || next.some((a) => samePath(a.path, path))) continue
    next.push(makeAttachment(path, previewUrl))
  }
  return next
}

/**
 * The text that is pasted into the agent's terminal. Claude Code reads files referenced by
 * absolute path (images included), so attachments travel as one path per line after the text.
 */
export function buildMessage(text: string, attachments: Attachment[], heading: string): string {
  const body = text.trim()
  if (attachments.length === 0) return body
  const list = attachments.map((a) => `- ${a.path}`).join('\n')
  return body ? `${body}\n\n${heading}\n${list}` : `${heading}\n${list}`
}
