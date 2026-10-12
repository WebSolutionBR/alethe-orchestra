/**
 * The built-in creative agent: an extra worker the orchestrator keeps for the whole session. It
 * studies the goal and the product, sends prioritized proposals to the orchestrator and implements
 * only what gets approved. Pure helpers, safe to import from the store, the views and the tests.
 */

/** Worker area of the creative agent (`orch spawn criativo <task>`). */
export const CREATIVE_AREA = 'criativo'

/** localStorage key of the start screen switch: '1' on, '0' off. */
export const CREATIVE_STORAGE_KEY = 'orchestra.creativeAgent'

/** Stands for the session goal in the task embedded in the orchestrator hint. */
export const GOAL_PLACEHOLDER = 'GOAL'

/** On by default; storage errors and unknown values keep it on. */
export function readCreativeEnabled(): boolean {
  try {
    const saved = localStorage.getItem(CREATIVE_STORAGE_KEY)
    return saved !== '0' && saved !== 'false'
  } catch {
    return true
  }
}

export function writeCreativeEnabled(on: boolean): void {
  try {
    localStorage.setItem(CREATIVE_STORAGE_KEY, on ? '1' : '0')
  } catch {
    // Unavailable storage: the switch still applies to sessions started in this run.
  }
}

/** True for the creative area, whatever its case or surrounding spaces. */
export function isCreativeArea(area: string | null | undefined): boolean {
  return (area ?? '').trim().toLowerCase() === CREATIVE_AREA
}

/**
 * The prompt text crosses cmd.exe, PowerShell and bash on its way to `orch spawn`, so it keeps to
 * characters none of them treat specially: no quotes, `%`, `!`, `$`, backticks, `^`, `&`, `|`,
 * `<` or `>`, and no line breaks.
 */
function shellSafe(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'`%!$^&|<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The default task of the creative worker for a session goal. */
export function creativeWorkerTask(goal: string): string {
  const target = shellSafe(goal) || 'the goal the orchestrator gives you'
  return [
    `You are the creative agent of this orchestration. Session goal: ${target}.`,
    'Study the goal, the product and what the other workers are building, and never edit a file',
    'another worker owns. Look for useful features the goal implies but nobody asked for, clean',
    'design refinements, and the fundamentals that go unnoticed: empty and error states, undo,',
    'persistence, shortcuts and discoverability, accessibility, i18n, performance, progress',
    'feedback and data safety. Send the orchestrator a short list ranked by impact versus effort',
    'with orch send orchestrator, at most 5 items per message, each with the problem, the',
    'proposal, where in the code it goes and the risk. Implement only what the orchestrator',
    'approves, inside the files it assigns you, and report progress like any other worker.',
  ].join(' ')
}

/**
 * Instruction appended to the orchestrator prompt: '' when the switch is off. Without a goal the
 * embedded task keeps the GOAL placeholder for the orchestrator to fill in.
 */
export function creativePromptHint(options: { goal?: string; enabled?: boolean } = {}): string {
  const { goal = '', enabled = readCreativeEnabled() } = options
  if (!enabled) return ''
  const filled = shellSafe(goal).length > 0
  return [
    'Creative agent, on for this session: besides the task workers, keep one extra worker in area',
    `${CREATIVE_AREA} for the whole session; it does not count toward the worker limit. Spawn it`,
    `early with orch spawn ${CREATIVE_AREA} followed by its default task below`,
    filled ? 'in one line.' : `in one line, with ${GOAL_PLACEHOLDER} replaced by the user goal.`,
    'It never edits files other workers own: it studies the goal and the product and sends you',
    'prioritized proposals. Review them, approve only what fits the goal and the file ownership',
    'you planned, reply with orch send, and assign the files for each approved item; it',
    'implements only what you approve. Default task:',
    creativeWorkerTask(filled ? goal : GOAL_PLACEHOLDER),
  ].join(' ')
}
