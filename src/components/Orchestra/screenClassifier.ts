/**
 * What an agent's terminal is stuck on, read from its screen. Claude Code stops on interactive
 * screens that never reach its hooks (the folder trust dialog, "Login expired", the first-run
 * onboarding, a new MCP server to approve, "Press Enter to continue", the usage limit), and
 * without this the agent reads as "thinking" for hours. Known screens get a reason with a way
 * out; a screen that stays still and matches nothing is still reported, with its last lines,
 * because the wording of these screens changes between CLI versions and the fallback is what
 * keeps a new one from going unnoticed.
 *
 * Pure: the watcher (attention/screenWatch.ts) feeds it the visible lines of the mirror.
 */

export type ScreenKind =
  'trust' | 'login' | 'onboarding' | 'mcp' | 'press-enter' | 'proceed' | 'usage-limit'

export type ScreenVerdict = {
  kind: ScreenKind
  /** The screen's last lines, trimmed: what the user is told the agent sees. */
  text: string
  /** Usage limit only: when the limit resets (epoch ms), null when the screen does not say. */
  resetAt?: number | null
}

/** Lines quoted from a stuck screen. */
export const QUOTED_LINES = 8
const QUOTE_MAX = 600

/** Frames and padding around a line's text. */
const FRAME = /^[\s─-╿│]+|[\s─-╿│]+$/gu

/** Claude Code at work: its spinner line ends with the elapsed time and "esc to interrupt". */
const WORKING = /\besc to interrupt\b/i

type Rule = { kind: ScreenKind; test: RegExp[] }

/**
 * Most specific first. Each rule matches any of its patterns on the screen's joined text, so
 * a pattern may span wrapped lines (whitespace is collapsed first).
 */
const RULES: Rule[] = [
  {
    kind: 'usage-limit',
    test: [
      /usage limit reached/i,
      /you['’]ve hit your (?:usage )?limit/i,
      /\b(?:5-hour|five-hour|weekly|opus) limit reached\b/i,
      /stop and wait for (?:the )?limit to reset/i,
    ],
  },
  {
    kind: 'login',
    test: [
      /login expired/i,
      /please run \/login/i,
      /oauth token has expired/i,
      /\bnot logged in\b/i,
      /invalid api key/i,
      /select login method/i,
      /token (?:has been )?revoked/i,
    ],
  },
  {
    kind: 'trust',
    test: [
      /accessing workspace/i,
      /is this a project you (?:created or one you )?trust/i,
      /do you trust the files in this folder/i,
      /yes, i trust this folder/i,
    ],
  },
  {
    kind: 'onboarding',
    test: [
      /let['’]s get started/i,
      /choose the text style that looks best/i,
      /security notes:/i,
      /use claude code['’]s terminal setup/i,
    ],
  },
  {
    kind: 'mcp',
    test: [
      /new mcp servers? found in/i,
      /mcp servers? may execute code/i,
      /use this mcp server/i,
      /mcp server .* needs authentication/i,
    ],
  },
  { kind: 'press-enter', test: [/press enter to continue/i] },
  { kind: 'proceed', test: [/do you want to proceed\?/i] },
]

function clean(screen: readonly string[]): string[] {
  const lines = screen.map((line) => line.replace(FRAME, '').trimEnd())
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

/** The last non-blank lines of a screen, frames stripped, as one quoted text. */
export function lastLines(screen: readonly string[], count = QUOTED_LINES): string {
  const text = clean(screen)
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n')
  return text.length > QUOTE_MAX ? `…${text.slice(-(QUOTE_MAX - 1))}` : text
}

/** Claude Code shows it is working (spinner with "esc to interrupt"). */
export function looksBusy(screen: readonly string[]): boolean {
  return clean(screen).some((line) => WORKING.test(line))
}

const RESET = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i

/**
 * The next moment the screen's reset time ("resets 6:30pm", "reset at 3pm") comes round, in
 * local time; null when there is none. The zone in parentheses is the user's own, so it is the
 * local clock.
 */
export function resetTime(text: string, now: Date): number | null {
  const match = RESET.exec(text)
  if (!match) return null
  let hours = Number(match[1])
  const minutes = match[2] ? Number(match[2]) : 0
  const half = match[3]?.toLowerCase()
  if (minutes > 59 || hours > 23 || (half && (hours < 1 || hours > 12))) return null
  if (half === 'pm' && hours < 12) hours += 12
  if (half === 'am' && hours === 12) hours = 0
  const at = new Date(now)
  at.setHours(hours, minutes, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/**
 * The known stuck screen on display, or null (working, at its prompt, or unknown). Only the
 * bottom of the screen counts: an old error scrolled above the prompt is not what it shows now.
 */
export function classifyScreen(screen: readonly string[], now = new Date()): ScreenVerdict | null {
  const lines = clean(screen)
  if (lines.some((line) => WORKING.test(line))) return null
  const bottom = lines.slice(-24)
  const joined = bottom.join(' ').replace(/\s+/g, ' ')
  for (const rule of RULES) {
    if (!rule.test.some((pattern) => pattern.test(joined))) continue
    const verdict: ScreenVerdict = { kind: rule.kind, text: lastLines(bottom) }
    if (rule.kind === 'usage-limit') verdict.resetAt = resetTime(joined, now)
    return verdict
  }
  return null
}
