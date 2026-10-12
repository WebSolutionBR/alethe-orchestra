/**
 * Blocks the user has to clear that Claude Code never reports to hooks: a stuck screen (see
 * screenClassifier.ts) or an account the preflight refused before the PTY opened. Only types
 * come from the store, which imports this module.
 */
import type { MessageKey } from '../../../lib/i18n'
import { accountPreflight, type Preflight } from '../../../lib/tauri/accountPreflight'
import type {
  AgentBlock,
  BlockReason,
  OrchestraAgent,
  OrchestraSession,
} from '../../../stores/orchestraStore'
import type { ScreenKind } from '../screenClassifier'

/**
 * `login`: signed out, sign-in lapsed or the token could not be renewed; `account`: signed in
 * to another Anthropic account than expected; `unknown-screen`: a still screen nothing matched.
 */
export type ScreenBlockReason = ScreenKind | 'account' | 'unknown-screen'

export const SCREEN_REASONS: ReadonlySet<BlockReason> = new Set<ScreenBlockReason>([
  'trust',
  'login',
  'account',
  'onboarding',
  'mcp',
  'press-enter',
  'proceed',
  'usage-limit',
  'unknown-screen',
])

export function isScreenBlock(block: Pick<AgentBlock, 'reason'> | null | undefined): boolean {
  return Boolean(block && SCREEN_REASONS.has(block.reason))
}

/** Blocks raised before the PTY opened: no terminal exists, only a new launch clears them. */
export function isAccountBlock(block: Pick<AgentBlock, 'reason' | 'text'> | null | undefined) {
  return Boolean(block && (block.reason === 'login' || block.reason === 'account'))
}

/**
 * A failed preflight as a block. Its text is data the views translate: for `account` the e-mail
 * it is signed in as and the expected one ("got|expected"); for `login` the status
 * (`no_login` or `login_expired`).
 */
export function preflightBlock(result: Preflight, at: number): AgentBlock | null {
  if (result.status === 'ready') return null
  if (result.status === 'account_mismatch') {
    return { reason: 'account', text: `${result.email ?? ''}|${result.expected_email ?? ''}`, at }
  }
  return { reason: 'login', text: result.status, at }
}

/** The e-mails of an `account` block: who it is signed in as, who it should be. */
export function accountBlockEmails(text: string): { got: string; expected: string } {
  const [got = '', expected = ''] = text.split('|')
  return { got, expected }
}

/** A preflight block in the words the orchestrator reads. */
export function preflightNotice(block: AgentBlock): string {
  if (block.reason === 'account') {
    const { got, expected } = accountBlockEmails(block.text)
    return `cannot start: its account is signed in as ${got || 'another account'} instead of ${expected || 'the expected one'}`
  }
  return block.text === 'no_login'
    ? 'cannot start: its account is not signed in'
    : 'cannot start: its account login expired'
}

export type PreflightInput = {
  /** The agent's account dir; null for Claude Code's default one. */
  configDir: string | null
  expectedEmail: string | null
  cwd: string
  /** Config dirs of other accounts to trust the folder in (the orchestrator's); '' = default. */
  alsoSeed: string[]
}

/**
 * Runs the preflight of one launch. A backend error never holds a launch back: the screen
 * watcher still catches a login screen, so only a clear answer blocks.
 */
export async function runPreflight(
  input: PreflightInput,
  at = Date.now(),
): Promise<AgentBlock | null> {
  try {
    const result = await accountPreflight({
      configDir: input.configDir,
      expectedEmail: input.expectedEmail,
      folders: [input.cwd],
      alsoSeed: input.alsoSeed,
    })
    if (result.seed_errors.length) console.warn('[orchestra] trust seed failed', result.seed_errors)
    return preflightBlock(result, at)
  } catch (error) {
    console.warn('[orchestra] account preflight failed', error)
    return null
  }
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A screen block in the words the orchestrator and the activity log read. */
export function screenNotice(block: AgentBlock): string {
  switch (block.reason) {
    case 'login':
    case 'account':
      return block.text.includes('\n') ? 'is stuck on a login screen' : preflightNotice(block)
    case 'trust':
      return 'is stuck on the folder trust dialog'
    case 'onboarding':
      return 'is stuck on the first-run onboarding'
    case 'mcp':
      return 'is stuck on an MCP server approval'
    case 'press-enter':
      return 'is stuck on "Press Enter to continue"'
    case 'proceed':
      return 'is stuck on "Do you want to proceed?"'
    case 'usage-limit':
      return block.resetAt
        ? `hit the usage limit of its account until ${clock(block.resetAt)}`
        : 'hit the usage limit of its account'
    default:
      return 'is stuck on a screen nobody recognizes'
  }
}

/** Short title of each block reason, as the cards and the notices show it. */
const REASON_KEYS: Record<BlockReason, MessageKey> = {
  permission: 'orchestra.agents.blocked.permission',
  question: 'orchestra.agents.blocked.question',
  report: 'orchestra.agents.blocked.report',
  dependency: 'orchestra.agents.blocked.dependencyShort',
  trust: 'orchestra.agents.blocked.trust',
  login: 'orchestra.agents.blocked.login',
  account: 'orchestra.agents.blocked.account',
  onboarding: 'orchestra.agents.blocked.onboarding',
  mcp: 'orchestra.agents.blocked.mcp',
  'press-enter': 'orchestra.agents.blocked.pressEnter',
  proceed: 'orchestra.agents.blocked.proceed',
  'usage-limit': 'orchestra.agents.blocked.usageLimit',
  'unknown-screen': 'orchestra.agents.blocked.unknownScreen',
}

export function blockReasonKey(reason: BlockReason): MessageKey {
  return REASON_KEYS[reason]
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** What a block says in the user's words: the e-mails, the login state or the screen's lines. */
export function blockDetail(block: Pick<AgentBlock, 'reason' | 'text'>, t: Translate): string {
  const oneLine = !block.text.includes('\n')
  if (block.reason === 'account' && oneLine && block.text.includes('|')) {
    const { got, expected } = accountBlockEmails(block.text)
    return t('orchestra.agents.blocked.accountDetail', {
      got: got || '?',
      expected: expected || '?',
    })
  }
  if (block.reason === 'login' && block.text === 'no_login') {
    return t('orchestra.agents.blocked.noLoginDetail')
  }
  if (block.reason === 'login' && block.text === 'login_expired') {
    return t('orchestra.agents.blocked.loginExpiredDetail')
  }
  return block.text.trim()
}

/**
 * The sign-in command's reject (see lib/tauri/accountLogin.ts) as a sentence: its known codes
 * get their own words, anything else is quoted.
 */
export function signInErrorText(reason: string, t: Translate): string {
  const mismatch = /^account_mismatch:\s*(.*)$/.exec(reason)
  if (mismatch) return t('orchestra.attention.signIn.mismatch', { email: mismatch[1] || '?' })
  if (reason === 'account_busy') return t('orchestra.attention.signIn.busy')
  if (reason === 'login_timeout') return t('orchestra.attention.signIn.timeout')
  if (reason === 'login_incomplete') return t('orchestra.attention.signIn.incomplete')
  if (reason === 'claude_not_found') return t('orchestra.attention.signIn.noClaude')
  if (reason === 'chrome_not_found') return t('orchestra.attention.signIn.noChrome')
  if (reason === 'bad_profile') return t('orchestra.attention.signIn.badProfile')
  return t('orchestra.attention.signIn.failed', {
    message: reason.replace(/^login_failed:\s*/, ''),
  })
}

/** The account an agent runs (or last ran) in; null is Claude Code's default one. */
export function agentAccount(
  agent: Pick<OrchestraAgent, 'launchedWith' | 'account'>,
): string | null {
  return agent.launchedWith?.account ?? agent.account ?? null
}

/** What one click clears: a sign-in clears login and account blocks alike. */
function releaseGroup(block: Pick<AgentBlock, 'reason'> | null | undefined): string | null {
  if (!block) return null
  if (block.reason === 'login' || block.reason === 'account') return 'login'
  if (block.reason === 'trust') return 'trust'
  return null
}

/**
 * The other agents a sign-in or a folder trust of `agentId` clears too: in a one-account
 * session, every agent blocked for the same reason on the same account (the folder is the
 * session's, the same for all). In a spread session each agent is cleared on its own card.
 */
export function blockedAlike(
  session: Pick<OrchestraSession, 'agents' | 'launch' | 'stoppedAt'>,
  agentId: string,
): string[] {
  if (session.stoppedAt || session.launch?.policy !== 'single') return []
  const self = session.agents.find((a) => a.id === agentId)
  const group = self?.state === 'blocked' ? releaseGroup(self.blocked) : null
  if (!self || !group) return []
  const account = agentAccount(self)
  return session.agents
    .filter(
      (a) =>
        a.id !== agentId &&
        a.state === 'blocked' &&
        releaseGroup(a.blocked) === group &&
        agentAccount(a) === account,
    )
    .map((a) => a.id)
}
