/** Which Claude account, model and effort an Orchestra agent runs with. `null` = CLI default. */
export type LaunchOptions = {
  account: string | null
  model: string | null
  effort: string | null
}

export const EMPTY_LAUNCH: LaunchOptions = { account: null, model: null, effort: null }

/**
 * How a session uses the Claude accounts: `single` runs every agent on the session's account
 * (an `orch spawn --account` is ignored); `spread` lets the orchestrator pick one per worker.
 */
export type AccountPolicy = 'single' | 'spread'
export const ACCOUNT_POLICIES: readonly AccountPolicy[] = ['single', 'spread']
export const DEFAULT_POLICY: AccountPolicy = 'single'

/** A session's own launch settings: its account policy plus the defaults its agents run with. */
export type SessionLaunch = LaunchOptions & { policy: AccountPolicy }

/** The session's account changed from the accounts panel. `null` is the default account. */
export type AccountSwitch = { at: number; from: string | null; to: string | null }

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

/**
 * What an agent of a session runs with. Its own spawn flags win over the session's model and
 * effort; under the `single` policy the account is always the session's, whatever it asked for.
 */
export function agentLaunch(
  agent: Partial<LaunchOptions> | undefined,
  session: SessionLaunch,
): LaunchOptions {
  const resolved = resolveLaunch(agent, session)
  return session.policy === 'single' ? { ...resolved, account: session.account } : resolved
}

/** The `--account` a `single` session ignores for this agent; null when nothing is dropped. */
export function ignoredAccount(
  agent: Partial<LaunchOptions> | undefined,
  session: SessionLaunch,
): string | null {
  const asked = clean(agent?.account)
  return session.policy === 'single' && asked && asked !== session.account ? asked : null
}

function optionalText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? clean(value) : undefined
}

/** A saved `SessionLaunch` (resume manifest), or null when it is missing or malformed. */
export function parseSessionLaunch(raw: unknown): SessionLaunch | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const policy = value.policy
  if (!ACCOUNT_POLICIES.includes(policy as AccountPolicy)) return null
  const account = optionalText(value.account)
  const model = optionalText(value.model)
  const effort = optionalText(value.effort)
  if (account === undefined || model === undefined || effort === undefined) return null
  return { policy: policy as AccountPolicy, account, model, effort }
}

/** Saved account switches, keeping only well-formed entries, oldest first. */
export function parseAccountSwitches(raw: unknown): AccountSwitch[] {
  if (!Array.isArray(raw)) return []
  const out: AccountSwitch[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { at, from, to } = item as Record<string, unknown>
    const fromId = optionalText(from)
    const toId = optionalText(to)
    if (
      typeof at !== 'number' ||
      !Number.isFinite(at) ||
      fromId === undefined ||
      toId === undefined
    )
      continue
    out.push({ at, from: fromId, to: toId })
  }
  return out.sort((a, b) => a.at - b.at)
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
 * One line for the orchestrator prompt about `orch spawn` flags. Under the `single` policy it
 * neither lists the accounts nor suggests spreading work: every agent runs on the session's
 * account. Under `spread` it lists the accounts it can pass with `--account`, reduced to
 * ASCII-safe text.
 */
export function accountsPromptHint(
  accounts: { id: string; name: string }[],
  policy: AccountPolicy = DEFAULT_POLICY,
): string {
  const flags = `"orch spawn" also accepts --model <${MODEL_CHOICES.join('|')}> and --effort <${EFFORT_CHOICES.join('|')}> before the task (omit them to use the session defaults).`
  if (policy === 'single')
    return `${flags} Every agent of this session runs on the one Claude account the user chose; do not pass --account, it is ignored.`
  const spread = `${flags} Spread heavy work across accounts to stay under usage limits.`
  if (accounts.length === 0) return spread
  const list = accounts
    .map((a) => `${a.id}=${a.name.normalize('NFD').replace(/[^\w .-]/g, '')}`)
    .join(', ')
  return `${spread} Claude accounts available for --account <id>: ${list}.`
}

/**
 * Launch settings of a resumed session: the saved ones, else (older manifests) one account,
 * the orchestrator's last one, with the form's model and effort.
 */
export function restoredLaunch(
  saved: unknown,
  orchestratorAccount: string | null | undefined,
  defaults: SessionLaunch,
): SessionLaunch {
  return (
    parseSessionLaunch(saved) ?? {
      ...defaults,
      policy: DEFAULT_POLICY,
      account: orchestratorAccount ?? defaults.account,
    }
  )
}

/**
 * What restarting an agent on `target` does: nothing to move (`same`), carry its conversation
 * there and continue it (`carry`; it starts over if the copy finds nothing), or start its task
 * over because no conversation is known (`fresh`).
 */
export type MoveOutcome = 'same' | 'carry' | 'fresh'

export function moveOutcome(
  agent: {
    account?: string | null
    launchedWith?: LaunchOptions | null
    claudeSessionId?: string | null
  },
  target: string | null,
): MoveOutcome {
  const current = agent.launchedWith ? agent.launchedWith.account : (agent.account ?? null)
  if (current === target) return 'same'
  return agent.claudeSessionId ? 'carry' : 'fresh'
}
