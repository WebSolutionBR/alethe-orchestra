import { getScribeConfig, notePathFor, type ScribeConfig } from './config'
import type { ContextStatus } from './context'

/** What the prompts need to know about the session's Obsidian context. */
export type ContextHintInput = { status: ContextStatus; file: string | null } | null | undefined

/**
 * The fixed Obsidian rule appended to every orchestrator and worker prompt: consult the vault
 * before starting (when consulting is on) and record each part of the work in the session note
 * the owner's way: context, decision and why, validation, gotcha, next steps; never a command
 * log, never a secret. It never says where the Local REST API key lives: agents write through
 * the obsidian MCP tools, or file the text with `orch note` and the app writes it.
 * Returns '' when injection is turned off in Preferences.
 */
export function obsidianRule(
  config: ScribeConfig = getScribeConfig(),
  at: number = Date.now(),
): string {
  if (!config.injectRule) return ''
  const note = notePathFor(config, at)
  const vault = config.vaultPath.trim().replace(/\\/g, '/')
  const consult = config.consultContext
    ? [
        'Fixed user rule (mandatory): before you start, consult Obsidian: read the session note',
        'and search the vault for related subjects (project, area, feature) to pick up earlier',
        'decisions and history; if you touch something with a history (for example the terminal),',
        'read the notes of that area in full first. Also,',
      ]
    : ['Fixed user rule (mandatory):']
  return [
    ...consult,
    `before you report done, record your part in the Obsidian session note "${note}"`,
    `${vault ? `of the vault at "${vault}" ` : ''}with the obsidian MCP tools; when they are not`,
    'available, file the text with "orch.cmd note --stdin" (or "orch.cmd note --file <path>")',
    'and Alethe Orchestra writes it for you. Write knowledge, not a log, in Brazilian Portuguese',
    'with dates as DD/MM/AAAA: the context or request, what you did and each decision with its',
    'reason, how it was validated, the gotcha (what almost went wrong or misled you) and the next',
    'steps. No command logs or raw output; full Windows Explorer paths (C:\\...) only when they',
    'matter; [[links]] only to notes that exist; never secrets (tokens, keys, passwords). A note',
    'you create ends with a line "---" and "# Notas relacionadas" listing 3 to 5 real links; when',
    'you edit an existing note, only add to it. The Orchestra scribe turns the session into the',
    "day's diary note in the owner's pattern from these records, so make the reasons explicit.",
    'If Obsidian times out, retry later instead of skipping the note.',
  ].join(' ')
}

/** `base` plus the rule, separated by a space; unchanged when the rule is off. */
export function withObsidianRule(base: string, config?: ScribeConfig): string {
  const rule = obsidianRule(config)
  return rule ? `${base} ${rule}` : base
}

/**
 * What an agent is told about the context file written when its session started: the
 * orchestrator reads it before splitting the work, a worker before starting. Without a file
 * (Obsidian did not answer) the orchestrator is asked to consult the vault itself; '' when
 * consulting is off.
 */
export function contextHint(
  role: 'orchestrator' | 'worker',
  context: ContextHintInput,
  config: ScribeConfig = getScribeConfig(),
): string {
  if (!config.consultContext || !context || context.status === 'off') return ''
  const file = context.file?.replace(/\\/g, '/') ?? ''
  if (role === 'orchestrator') {
    return file
      ? [
          'Obsidian context: when this session started, Alethe Orchestra consulted the Obsidian',
          'vault (the session note and the notes related to the project and the goal) and saved',
          `a summary to "${file}". Read that file before you split the work, then search the vault`,
          'for related subjects yourself and tell each worker which notes cover its area.',
        ].join(' ')
      : [
          'Alethe Orchestra could not consult Obsidian when this session started: before you split',
          'the work, read the session note and search the vault for related subjects with the',
          'obsidian MCP tools, if Obsidian answers.',
        ].join(' ')
  }
  return file
    ? `The Obsidian context of this session (the session note and related notes, gathered when it started) is in "${file}": read it before you start.`
    : ''
}
