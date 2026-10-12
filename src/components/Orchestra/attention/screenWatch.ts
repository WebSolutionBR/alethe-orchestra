/**
 * Watches the screens of running agents for what hooks never report: a known stuck screen
 * (trust dialog, login, onboarding, MCP approval, "Press Enter", usage limit) becomes a block
 * with its reason, a screen that stays still and matches nothing becomes "unknown screen", and a
 * busy agent with no output and no report for too long becomes "stalled?". Reads the terminal
 * mirrors on a timer; never writes to a PTY. Installed once by the store (main window only).
 */
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { AgentBlock, OrchestraAgent, OrchestraSession } from '../../../stores/orchestraStore'
import { screenLines } from '../dialog'
import { classifyScreen, lastLines, looksBusy } from '../screenClassifier'
import { isAccountBlock, isScreenBlock } from './blocking'
import { readEscalation } from './prefs'
import { isBusyState } from './rules'

/** How often screens are read. */
export const TICK_MS = 5000
/** A known screen counts once it held this long (a redraw passes faster). */
export const KNOWN_STILL_MS = 4000
/** "Do you want to proceed?" waits longer: its permission hook usually arrives first. */
export const PROCEED_STILL_MS = 20_000
/** A still screen nothing matches is reported after this long. */
export const UNKNOWN_STILL_MS = 90_000

type Sessions = Record<string, OrchestraSession>

export type ScreenWatchSource = {
  getState: () => { sessions: Sessions }
  subscribe: (
    listener: (state: { sessions: Sessions }, prev: { sessions: Sessions }) => void,
  ) => () => void
  /** Sets (or, with null, clears) a screen block; hook blocks are never overwritten. */
  screenBlock: (sessionId: string, agentId: string, block: AgentBlock | null) => void
  setStalled: (sessionId: string, agentId: string, since: number | null) => void
}

export type ScreenWatchDeps = {
  now: () => number
  screen: (ptyId: string) => string[] | null
  stallMs: () => number
  isMainWindow: () => boolean
  /** Starts the timer; returns its stop. Tests drive `tick` themselves. */
  every: (ms: number, run: () => void) => () => void
}

type Seen = {
  ptyId: string
  text: string
  changedAt: number
  activeAt: number
  /** A usage limit screen released at its reset time: it does not block again until it moves. */
  released?: string
}

function ended(agent: OrchestraAgent): boolean {
  return agent.state === 'exited' || agent.exitReason != null
}

/** What in an agent counts as a sign of life besides its screen: reports, hooks, new lines. */
function pulse(agent: OrchestraAgent): string {
  return `${agent.state}|${agent.progress}|${agent.note}|${agent.toolCalls}|${agent.lines.length}`
}

function isMain(): boolean {
  try {
    return getCurrentWindow().label === 'main'
  } catch {
    // No Tauri window (tests, the plain browser build): nothing to watch from.
    return false
  }
}

function defaults(): ScreenWatchDeps {
  return {
    now: Date.now,
    screen: screenLines,
    stallMs: () => readEscalation().stallMin * 60_000,
    isMainWindow: isMain,
    every: (ms, run) => {
      const timer = setInterval(run, ms)
      return () => clearInterval(timer)
    },
  }
}

/** One pass over every running agent; exported for tests. */
export function createScreenWatch(
  source: ScreenWatchSource,
  overrides: Partial<ScreenWatchDeps> = {},
) {
  const deps: ScreenWatchDeps = { ...defaults(), ...overrides }
  const seen = new Map<string, Seen>()
  const pulses = new Map<string, string>()

  const touch = (key: string, at: number) => {
    const entry = seen.get(key)
    if (entry) entry.activeAt = at
  }

  const onState = (state: { sessions: Sessions }, prev: { sessions: Sessions }) => {
    if (state.sessions === prev.sessions) return
    const at = deps.now()
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      for (const agent of session.agents) {
        const key = `${sessionId}:${agent.id}`
        const next = pulse(agent)
        if (pulses.get(key) !== next) {
          pulses.set(key, next)
          touch(key, at)
        }
      }
    }
  }

  const check = (sessionId: string, agent: OrchestraAgent, now: number) => {
    const key = `${sessionId}:${agent.id}`
    const ptyId = agent.ptyId
    if (!ptyId || ended(agent)) {
      seen.delete(key)
      return
    }
    const lines = deps.screen(ptyId)
    if (!lines) return
    const text = lines.join('\n')
    let entry = seen.get(key)
    if (!entry || entry.ptyId !== ptyId) {
      entry = { ptyId, text, changedAt: now, activeAt: now }
      seen.set(key, entry)
    }
    const changed = entry.text !== text
    if (changed) {
      entry.text = text
      entry.changedAt = now
      entry.activeAt = now
      entry.released = undefined
    }
    const still = now - entry.changedAt
    const block = agent.state === 'blocked' ? agent.blocked : null

    // A screen block ends when the screen moves on to something else.
    if (block && isScreenBlock(block) && !isAccountBlock(block)) {
      // The limit is over by the clock: release it even though the screen still quotes it (at
      // the prompt, "usage limit reached" stays above the input box after the menu is gone).
      if (block.reason === 'usage-limit' && block.resetAt && now >= block.resetAt) {
        entry.released = text
        source.screenBlock(sessionId, agent.id, null)
        return
      }
      if (!changed) return
      const verdict = classifyScreen(lines, new Date(now))
      if (!verdict || verdict.kind !== block.reason) source.screenBlock(sessionId, agent.id, null)
      return
    }
    if (block && isScreenBlock(block)) return
    if (!isBusyState(agent.state)) {
      if (agent.stalledSince) source.setStalled(sessionId, agent.id, null)
      return
    }

    const verdict = entry.released === text ? null : classifyScreen(lines, new Date(now))
    const wait = verdict?.kind === 'proceed' ? PROCEED_STILL_MS : KNOWN_STILL_MS
    if (verdict && still >= wait) {
      source.screenBlock(sessionId, agent.id, {
        reason: verdict.kind,
        text: verdict.text,
        at: now,
        ...(verdict.kind === 'usage-limit' ? { resetAt: verdict.resetAt ?? null } : {}),
      })
      return
    }
    const quoted = lastLines(lines)
    if (
      !verdict &&
      entry.released !== text &&
      still >= UNKNOWN_STILL_MS &&
      quoted &&
      !looksBusy(lines)
    ) {
      source.screenBlock(sessionId, agent.id, { reason: 'unknown-screen', text: quoted, at: now })
      return
    }
    // Busy with a moving screen or fresh reports: alive. Otherwise "stalled?" past the limit.
    const quiet = now - Math.max(entry.changedAt, entry.activeAt)
    if (quiet >= deps.stallMs()) {
      if (!agent.stalledSince) source.setStalled(sessionId, agent.id, now - quiet)
    } else if (agent.stalledSince) {
      source.setStalled(sessionId, agent.id, null)
    }
  }

  const tick = () => {
    const now = deps.now()
    const alive = new Set<string>()
    for (const [sessionId, session] of Object.entries(source.getState().sessions)) {
      if (session.stoppedAt) continue
      for (const agent of session.agents) {
        alive.add(`${sessionId}:${agent.id}`)
        try {
          check(sessionId, agent, now)
        } catch (error) {
          console.warn('[orchestra] screen watch failed', error)
        }
      }
    }
    for (const key of seen.keys()) if (!alive.has(key)) seen.delete(key)
    for (const key of pulses.keys()) if (!alive.has(key)) pulses.delete(key)
  }

  return { tick, onState, deps }
}

export function installScreenWatch(
  source: ScreenWatchSource,
  overrides: Partial<ScreenWatchDeps> = {},
): () => void {
  const watch = createScreenWatch(source, overrides)
  if (!watch.deps.isMainWindow()) return () => {}
  const unsubscribe = source.subscribe(watch.onState)
  const stop = watch.deps.every(TICK_MS, watch.tick)
  return () => {
    unsubscribe()
    stop()
  }
}
