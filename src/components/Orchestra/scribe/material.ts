/**
 * Session material: what the scribe's author writes from. Bus events become short, redacted
 * entries (who did what, and the agents' own words) kept per session in memory and in the
 * app data folder, never in the vault. Reads, routine tool calls and duplicates are dropped
 * here, so the author reads decisions and outcomes, not a command log.
 */
import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import { explorerPath, hhmm } from './notePath'
import { redactSecrets } from './redact'

export type MaterialKind =
  /** The session started: goal, project, folder. */
  | 'start'
  /** Notes consulted in Obsidian before the orchestrator started. */
  | 'context'
  /** The session ended (or the app closed with it running). */
  | 'end'
  | 'spawn'
  | 'report'
  | 'done'
  | 'blocked'
  | 'message'
  /** A note an agent filed with `orch note` (its decision and why). */
  | 'note'
  /** Text typed straight into an agent's terminal. */
  | 'prompt'
  /** The agent's last message at the end of a turn. */
  | 'turn'
  | 'edit'
  | 'verify'
  | 'deploy'
  | 'failure'
  | 'waiting'
  /** A synthesis the author already wrote, so the next one builds on it. */
  | 'synthesis'

export type MaterialEntry = { at: number; kind: MaterialKind; agent?: string; text: string }

/** Kinds the author needs most; they are kept first when the material is cut. */
const HIGH_VALUE = new Set<MaterialKind>([
  'start',
  'context',
  'end',
  'spawn',
  'report',
  'done',
  'blocked',
  'message',
  'note',
  'prompt',
  'deploy',
  'synthesis',
])

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const DEPLOY =
  /\b(deploy|wrangler|vercel|netlify|firebase deploy|git push|npm publish|cargo publish|gh release|kubectl apply|terraform apply)\b/i
/** Commands that prove something: tests, type checks, builds, linters. */
const VERIFY =
  /\b(vitest|jest|pytest|cargo (test|check|clippy|build)|npm (test|run (build|test|lint|check))|npx (tsc|vitest|eslint|prettier)|tsc\b|eslint|go test|dotnet test|mvn test|gradle test|playwright)/i
const RELAY = /^\[orchestra · from [^\]]*\]/

const LIMITS: Partial<Record<MaterialKind, number>> = {
  spawn: 1500,
  note: 6000,
  message: 900,
  report: 500,
  done: 700,
  blocked: 600,
  prompt: 700,
  turn: 900,
  start: 1500,
}

export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function entry(at: number, kind: MaterialKind, text: string, agent?: string): MaterialEntry {
  const clean = clipText(redactSecrets(text), LIMITS[kind] ?? 300)
  return agent ? { at, kind, agent, text: clean } : { at, kind, text: clean }
}

const STATUS_PT: Record<string, string> = {
  thinking: 'pensando',
  editing: 'editando',
  testing: 'testando',
  blocked: 'bloqueado',
  done: 'concluído',
  idle: 'ocioso',
}

/**
 * The material entries one bus event yields (often none). Pure; deduplication across events
 * happens in `MaterialLog`.
 */
export function materialFromEvent(event: OrchestraEvent): MaterialEntry[] {
  const kind = (event as { kind: string }).kind
  // `orch note`: an agent's own record of a decision, the most valuable material there is.
  if (kind === 'note') {
    const note = event as unknown as { at: number; agent_id: string; text: string }
    return note.text?.trim() ? [entry(note.at, 'note', note.text, note.agent_id)] : []
  }
  switch (event.kind) {
    case 'spawn': {
      const after = event.after.length ? ` (depois de ${event.after.join(', ')})` : ''
      const area = event.area && event.area !== event.id ? ` · área ${event.area}` : ''
      return [entry(event.at, 'spawn', `criado${area}${after}: ${event.task}`, event.id)]
    }
    case 'report': {
      const note = event.note.trim()
      if (event.status === 'done' || event.progress === 100)
        return [entry(event.at, 'done', note || 'concluiu', event.agent_id)]
      if (event.status === 'blocked')
        return [entry(event.at, 'blocked', note || 'bloqueado', event.agent_id)]
      if (!note) return []
      const pct = event.progress === null ? '' : `${event.progress}% `
      const status = event.status ? `${STATUS_PT[event.status] ?? event.status}: ` : ''
      return [entry(event.at, 'report', `${pct}${status}${note}`, event.agent_id)]
    }
    case 'message':
      return [entry(event.at, 'message', `${event.from} → ${event.to}: ${event.text}`)]
    case 'hook': {
      const { agent_id: id, hook, at } = event
      const tool = hook.tool_name ?? ''
      const target = hook.target ?? ''
      switch (hook.hook_event_name) {
        case 'PreToolUse':
          if (FILE_TOOLS.has(tool) && target) return [entry(at, 'edit', explorerPath(target), id)]
          if (SHELL_TOOLS.has(tool) && DEPLOY.test(target)) return [entry(at, 'deploy', target, id)]
          if (SHELL_TOOLS.has(tool) && VERIFY.test(target)) return [entry(at, 'verify', target, id)]
          return []
        case 'PostToolUse':
          return hook.failed ? [entry(at, 'failure', `${tool || 'ferramenta'} falhou`, id)] : []
        case 'Notification':
          return hook.message ? [entry(at, 'waiting', hook.message, id)] : []
        case 'UserPromptSubmit': {
          const prompt = hook.prompt?.trim() ?? ''
          // Relayed bus messages are already material; only what was typed by hand is new.
          return prompt && !RELAY.test(prompt) ? [entry(at, 'prompt', prompt, id)] : []
        }
        case 'Stop':
          return hook.last_assistant_message
            ? [entry(at, 'turn', hook.last_assistant_message, id)]
            : []
        default:
          return []
      }
    }
    default:
      return []
  }
}

/** Identity of an entry for deduplication: edits and checks count once per agent and file. */
function dedupeKey(e: MaterialEntry): string | null {
  switch (e.kind) {
    case 'edit':
    case 'verify':
    case 'deploy':
      return `${e.kind}|${e.agent ?? ''}|${e.text.toLowerCase()}`
    case 'turn':
    case 'report':
    case 'waiting':
      return `${e.kind}|${e.agent ?? ''}|${e.text}`
    default:
      return null
  }
}

function line(e: MaterialEntry): string {
  return `${hhmm(e.at)} · ${e.kind}${e.agent ? ` · ${e.agent}` : ''} · ${e.text}`
}

/**
 * The material as the author reads it: one line per entry, oldest first, within `maxChars`.
 * When it does not fit, the newest entries win, the high-value kinds before edits and
 * checks, and a first line says how many were left out.
 */
export function renderMaterial(entries: MaterialEntry[], maxChars = 40_000): string {
  const lines = entries.map((e, index) => ({ index, e, text: line(e) }))
  const total = lines.reduce((sum, l) => sum + l.text.length + 1, 0)
  let kept = lines
  if (total > maxChars) {
    const picked = new Set<number>()
    let size = 0
    for (const tier of [true, false]) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]
        if (HIGH_VALUE.has(l.e.kind) !== tier || picked.has(l.index)) continue
        if (size + l.text.length + 1 > maxChars) continue
        picked.add(l.index)
        size += l.text.length + 1
      }
    }
    kept = lines.filter((l) => picked.has(l.index))
  }
  const omitted = lines.length - kept.length
  const head = omitted > 0 ? [`(${omitted} entradas mais antigas ou de rotina omitidas)`] : []
  return [...head, ...kept.map((l) => l.text)].join('\n')
}

/** Parses stored material (one JSON entry per line); bad lines are skipped. */
export function parseMaterial(text: string): MaterialEntry[] {
  const out: MaterialEntry[] = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed) as Partial<MaterialEntry>
      if (
        typeof value.at === 'number' &&
        typeof value.kind === 'string' &&
        typeof value.text === 'string'
      )
        out.push({
          at: value.at,
          kind: value.kind as MaterialKind,
          text: value.text,
          ...(typeof value.agent === 'string' ? { agent: value.agent } : {}),
        })
    } catch {
      // A torn last line (crash mid-write) is skipped.
    }
  }
  return out
}

export type MaterialStorage = {
  append: (sessionId: string, lines: string[]) => Promise<void>
  read: (sessionId: string) => Promise<string>
  remove: (sessionId: string) => Promise<void>
}

const MAX_MEMORY = 3_000
const FLUSH_MS = 1_500

type SessionMaterial = { entries: MaterialEntry[]; seen: Set<string>; unsaved: string[] }

/**
 * Per-session material in memory, saved to disk in small batches. Disk failures are only
 * logged: the material in memory still feeds this run's syntheses.
 */
export class MaterialLog {
  private sessions = new Map<string, SessionMaterial>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> | null = null

  constructor(private readonly storage: MaterialStorage) {}

  private slot(sessionId: string): SessionMaterial {
    let slot = this.sessions.get(sessionId)
    if (!slot) {
      slot = { entries: [], seen: new Set(), unsaved: [] }
      this.sessions.set(sessionId, slot)
    }
    return slot
  }

  /** Adds entries (duplicates dropped); returns what was actually added. */
  record(sessionId: string, entries: MaterialEntry[]): MaterialEntry[] {
    if (entries.length === 0) return []
    const slot = this.slot(sessionId)
    const added: MaterialEntry[] = []
    for (const e of entries) {
      const key = dedupeKey(e)
      if (key) {
        if (slot.seen.has(key)) continue
        slot.seen.add(key)
      }
      slot.entries.push(e)
      slot.unsaved.push(JSON.stringify(e))
      added.push(e)
    }
    if (slot.entries.length > MAX_MEMORY) slot.entries = slot.entries.slice(-MAX_MEMORY)
    if (added.length && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, FLUSH_MS)
    }
    return added
  }

  /** In-memory entries of a session, oldest first. */
  entries(sessionId: string): MaterialEntry[] {
    return this.sessions.get(sessionId)?.entries ?? []
  }

  /**
   * The session's material, from memory when this run recorded it, else from disk (a final
   * synthesis resumed after a restart).
   */
  async load(sessionId: string): Promise<MaterialEntry[]> {
    const memory = this.sessions.get(sessionId)
    if (memory && memory.entries.length > 0) return memory.entries
    try {
      return parseMaterial(await this.storage.read(sessionId))
    } catch {
      return []
    }
  }

  /** Saves what was not saved yet; never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const run = (this.saving ?? Promise.resolve()).then(async () => {
      for (const [sessionId, slot] of this.sessions) {
        if (slot.unsaved.length === 0) continue
        const lines = slot.unsaved
        slot.unsaved = []
        try {
          await this.storage.append(sessionId, lines)
        } catch (error) {
          console.warn('[scribe] material not saved', error)
        }
      }
    })
    this.saving = run.finally(() => {
      if (this.saving === run) this.saving = null
    })
    return run
  }

  /** Drops a session from memory; `removeFile` also deletes its saved material. */
  forget(sessionId: string, removeFile = false): void {
    this.sessions.delete(sessionId)
    if (removeFile) void this.storage.remove(sessionId).catch(() => {})
  }
}
