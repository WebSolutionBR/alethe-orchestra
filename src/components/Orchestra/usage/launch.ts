/** Which Claude account, model and effort an Orchestra agent runs with. `null` = CLI default. */
export type LaunchOptions = {
  account: string | null
  model: string | null
  effort: string | null
}

export const EMPTY_LAUNCH: LaunchOptions = { account: null, model: null, effort: null }

/** Model choices offered in the UI; any other value from `orch spawn --model` is passed through. */
export const MODEL_CHOICES = ['opus', 'sonnet', 'haiku', 'claude-fable-5-1'] as const

/** Levels accepted by `claude --effort`. */
export const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Per-agent values win; anything unset falls back to the session defaults. */
export function resolveLaunch(
  agent: Partial<LaunchOptions> | undefined,
  defaults: LaunchOptions,
): LaunchOptions {
  return {
    account: clean(agent?.account) ?? defaults.account,
    model: clean(agent?.model) ?? defaults.model,
    effort: clean(agent?.effort) ?? defaults.effort,
  }
}

/** Extra `claude` CLI args for a launch; the account is applied through the env instead. */
export function launchArgs(options: LaunchOptions): string[] {
  const args: string[] = []
  if (options.model) args.push('--model', options.model)
  if (options.effort && (EFFORT_CHOICES as readonly string[]).includes(options.effort))
    args.push('--effort', options.effort)
  return args
}

/** Short model label for chips: `claude-fable-5-1` → `fable-5-1`. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

/**
 * One line for the orchestrator prompt listing the accounts it can pass with
 * `orch spawn --account`. Names are reduced to ASCII-safe text.
 */
export function accountsPromptHint(accounts: { id: string; name: string }[]): string {
  const flags = `"orch.cmd spawn" also accepts --model <${MODEL_CHOICES.join('|')}> and --effort <${EFFORT_CHOICES.join('|')}> before the task (omit them to use the session defaults); spread heavy work across accounts to stay under usage limits.`
  if (accounts.length === 0) return flags
  const list = accounts
    .map((a) => `${a.id}=${a.name.normalize('NFD').replace(/[^\w .-]/g, '')}`)
    .join(', ')
  return `${flags} Claude accounts available for --account <id>: ${list}.`
}
