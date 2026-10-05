/**
 * One pass of the scribe's author for a session: gather what it needs (the template and the
 * owner's rules read live from the vault, an example note, the session's diary note as it is
 * now, the material, the agents' task files and transcripts), run it, check its plan and
 * queue the writes. Every dependency is injected, so tests never touch a vault or a CLI.
 */
import type {
  ScribeAuthorOutcome,
  ScribeAuthorRequest,
  ScribeSource,
  ScribeSourcesRequest,
} from '../../../lib/tauri/obsidian'
import {
  ABSENT,
  type AuthorTriggerKind,
  buildAuthorPrompt,
  buildVaultIndex,
  contentHash,
  diaryAppendOnly,
  parseAuthorPlan,
  type PreparedPlan,
  preparePlan,
  type VaultIndex,
  type WriteOp,
} from './author'
import type { AuthorFailure, SessionRecord, SessionSnapshot } from './authorStatus'
import {
  authorMaxBudget,
  authorMaxTurns,
  authorTimeoutSecs,
  notePathFor,
  type ScribeConfig,
} from './config'
import { type MaterialEntry, renderMaterial } from './material'
import { diaryFolder, diaryNamePrefix, diaryNotePath, noteTitle, titleFromGoal } from './notePath'
import type { AuthorRequest } from './scheduler'
import { FALLBACK_TEMPLATE } from './template'

export type NoteRead = { content: string; truncated: boolean } | null

export type SynthesisDeps = {
  config: () => ScribeConfig
  now: () => number
  record: (sessionId: string) => SessionRecord | null
  /** The session as it is now, or as it was when it ended. */
  snapshot: (sessionId: string) => SessionSnapshot | null
  material: (sessionId: string) => Promise<MaterialEntry[]>
  /** Notes read from Obsidian when the session started. */
  contextNotes: (sessionId: string) => string[]
  read: (notePath: string) => Promise<NoteRead>
  list: (dir: string) => Promise<string[]>
  index: (vaultPath: string) => Promise<VaultIndex | null>
  /** Heads of the session's task files (the backend skips any other path). */
  sources: (request: ScribeSourcesRequest) => Promise<ScribeSource[]>
  /** `CLAUDE_CONFIG_DIR` of an account id; null when unknown. */
  accountDir: (accountId: string) => string | null
  /** Session defaults of the launch form (account, model, effort). */
  launchDefaults: () => { account: string | null; model: string | null; effort: string | null }
  run: (request: ScribeAuthorRequest) => Promise<ScribeAuthorOutcome>
  enqueue: (batch: { session: string; label: string; ops: WriteOp[] }) => number | null
  runId: (sessionId: string) => string
}

export type SynthesisResult =
  | {
      ok: true
      plan: PreparedPlan
      batchId: number
      diaryPath: string
      title: string
      outcome: ScribeAuthorOutcome
    }
  | { ok: false; failure: AuthorFailure; detail: string | null; outcome?: ScribeAuthorOutcome }

/**
 * Absolute `.md`/`.txt` paths mentioned in a text (task files the orchestrator wrote). URLs
 * are not paths: a drive letter or a leading slash must not follow a word or a scheme.
 */
export function mentionedFiles(text: string): string[] {
  const out = new Set<string>()
  const path =
    /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w:/.])\/)(?:[^\s"'`<>|*?]+[\\/])*[^\s"'`<>|*?\\/]+\.(?:md|txt)\b/g
  for (const match of text.matchAll(path)) out.add(match[0].replace(/[).,;:]+$/, ''))
  return [...out]
}

/**
 * Account, model and effort of the author: the scribe's settings when set, else what the
 * session's orchestrator ran with, else the launch form's defaults.
 */
export function authorLaunch(
  config: ScribeConfig,
  snapshot: SessionSnapshot,
  defaults: { account: string | null; model: string | null; effort: string | null },
): { account: string | null; model: string | null; effort: string | null } {
  const account =
    config.authorAccount === 'default'
      ? null
      : config.authorAccount.trim() || snapshot.account || defaults.account || null
  return {
    account,
    model: config.authorModel.trim() || snapshot.model || defaults.model || null,
    effort: config.authorEffort.trim() || snapshot.effort || defaults.effort || null,
  }
}

/** The diary note path for a title, avoiding a name another note of the vault already has. */
export function freeDiaryPath(
  pattern: string,
  at: number,
  title: string,
  index: VaultIndex | null,
): string {
  const base = diaryNotePath(pattern, at, title)
  if (!index || !index.has(base)) return base
  for (let n = 2; n < 10; n++) {
    const path = diaryNotePath(pattern, at, `${title} (${n})`)
    if (!index.has(path)) return path
  }
  return diaryNotePath(pattern, at, `${title} (${at})`)
}

async function readOrNull(deps: SynthesisDeps, path: string): Promise<NoteRead> {
  if (!path.trim()) return null
  try {
    return await deps.read(path)
  } catch {
    return null
  }
}

function primaryTrigger(triggers: AuthorTriggerKind[], final: boolean): AuthorTriggerKind {
  if (final) return triggers.includes('resume') ? 'resume' : 'session-end'
  if (triggers.includes('manual')) return 'manual'
  return triggers[0] ?? 'manual'
}

/** Runs the author once for `request` and queues what it wrote; never rejects. */
export async function runSynthesis(
  request: AuthorRequest,
  deps: SynthesisDeps,
): Promise<SynthesisResult> {
  const config = deps.config()
  const vaultPath = config.vaultPath.trim()
  if (!vaultPath) return { ok: false, failure: 'no-vault', detail: null }
  const snapshot = deps.snapshot(request.sessionId)
  if (!snapshot) return { ok: false, failure: 'no-session', detail: null }
  const now = deps.now()
  const record = deps.record(request.sessionId)
  const startedAt = snapshot.startedAt ?? now
  const pattern = config.diaryPattern

  try {
    const fallbackTitle = record?.title ?? titleFromGoal(snapshot.goal, snapshot.projectName)
    const knownDiary = record?.diaryPath ?? null
    // The author must see the note as it is now, and Obsidian has to answer for the writes:
    // when it does not, no run is spent writing blind.
    let current: NoteRead = null
    let template: NoteRead = null
    try {
      current = knownDiary ? await deps.read(knownDiary) : null
      template = config.templatePath.trim() ? await deps.read(config.templatePath) : null
    } catch (error) {
      return {
        ok: false,
        failure: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    const folder = diaryFolder(pattern, startedAt)
    const [listing, rules, example, index, material] = await Promise.all([
      deps.list(folder).catch(() => [] as string[]),
      readOrNull(deps, config.rulesNotePath),
      readOrNull(deps, config.examplePath),
      deps.index(vaultPath).catch(() => null),
      deps.material(request.sessionId).catch(() => [] as MaterialEntry[]),
    ])
    const todayPrefix = diaryNamePrefix(pattern, startedAt)
    const todayNotes = listing
      .filter(
        (name) =>
          name.toLowerCase().endsWith('.md') && (!todayPrefix || name.startsWith(todayPrefix)),
      )
      .map((name) => `${folder}/${name}`)
      .filter((path) => !knownDiary || path.toLowerCase() !== knownDiary.toLowerCase())

    const taskText = [
      ...snapshot.agents.flatMap((a) => [a.task, ...a.history.map((h) => h.task)]),
      ...material.filter((e) => e.kind === 'spawn' || e.kind === 'message').map((e) => e.text),
    ].join('\n')
    // Only the session's own task files and its agents' transcripts are handed to the author.
    const sourcePaths = mentionedFiles(taskText).slice(0, 24)
    const sources = await deps
      .sources({ sessionId: snapshot.id, sessionFolder: snapshot.cwd, paths: sourcePaths })
      .catch(() => [])
    const transcripts = snapshot.agents
      .filter((a) => a.transcriptPath)
      .map((a) => ({ name: a.id, path: a.transcriptPath as string }))
    const launch = authorLaunch(config, snapshot, deps.launchDefaults())
    const configDir = launch.account ? deps.accountDir(launch.account) : null

    const provisional = knownDiary ?? diaryNotePath(pattern, startedAt, '{title}')
    const prompt = buildAuthorPrompt({
      now,
      trigger: primaryTrigger(request.triggers, request.final),
      finished: request.finished,
      final: request.final,
      session: {
        id: snapshot.id,
        goal: snapshot.goal,
        cwd: snapshot.cwd,
        projectName: snapshot.projectName,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt,
      },
      agents: snapshot.agents,
      vaultPath,
      workNote: notePathFor(config, startedAt),
      diary: { path: provisional, current, folder, todayNotes },
      template: template
        ? { path: config.templatePath, content: template.content, live: true }
        : { path: config.templatePath, content: FALLBACK_TEMPLATE, live: false },
      rules: rules ? { path: config.rulesNotePath, content: rules.content } : null,
      example: example ? { path: config.examplePath, content: example.content } : null,
      contextNotes: deps.contextNotes(request.sessionId),
      sources,
      material: renderMaterial(material),
      topicFolder: config.topicFolder.trim(),
      mcp: true,
    })

    const outcome = await deps.run({
      runId: deps.runId(request.sessionId),
      sessionId: snapshot.id,
      prompt,
      model: launch.model,
      effort: launch.effort,
      configDir,
      vaultPath,
      sessionFolder: snapshot.cwd,
      transcripts,
      sources: sourcePaths,
      timeoutSecs: authorTimeoutSecs(config),
      maxTurns: authorMaxTurns(config),
      maxBudgetUsd: authorMaxBudget(config),
    })
    if (!outcome.ok) {
      return {
        ok: false,
        failure: (outcome.error ?? 'cli-error') as AuthorFailure,
        detail: outcome.detail,
        outcome,
      }
    }
    const plan = parseAuthorPlan(outcome.result)
    if (!plan) return { ok: false, failure: 'plan', detail: outcome.result.slice(0, 300), outcome }

    const title = noteTitle(record?.title ?? plan.title ?? fallbackTitle) || fallbackTitle
    const diaryPath = knownDiary ?? freeDiaryPath(pattern, startedAt, title, index)
    const prepared = preparePlan(plan, {
      diaryPath,
      diaryFolder: folder,
      diaryExpect: current ? contentHash(current.content) : ABSENT,
      diaryAppendOnly: diaryAppendOnly(current),
      index,
      protectedPaths: [config.templatePath, config.rulesNotePath, config.examplePath].filter(
        Boolean,
      ),
    })
    if (prepared.ops.length === 0)
      return { ok: false, failure: 'empty', detail: prepared.issues.join(' · ') || null, outcome }
    const batchId = deps.enqueue({
      session: request.sessionId,
      label: prepared.summary ?? title,
      ops: prepared.ops,
    })
    if (batchId === null) return { ok: false, failure: 'write', detail: null, outcome }
    return { ok: true, plan: prepared, batchId, diaryPath, title, outcome }
  } catch (error) {
    return {
      ok: false,
      failure: 'spawn',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Builds the vault index used to keep only links to notes that exist. */
export function vaultIndexFrom(paths: string[] | null): VaultIndex | null {
  return paths ? buildVaultIndex(paths) : null
}
