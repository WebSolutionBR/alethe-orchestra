/**
 * Attention notices for the Orchestra: an agent asking for approval or an answer, one that stops
 * before finishing, a session whose workers are all done, and an orchestrator idle and waiting on
 * the user. Installed once by the store (main window only); it never touches a PTY.
 */
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'

import { getLocale, type MessageKey, translate } from '../../../lib/i18n'
import { notifyAgentDone } from '../../../lib/notifications'
import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import type { OrchestraAgent, OrchestraSession } from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { blockDetail, blockReasonKey, isScreenBlock } from './blocking'
import { dueEscalations, type Escalation } from './escalation'
import { type EscalationPrefs, readAlertsEnabled, readEscalation } from './prefs'
import {
  type AttentionEvent,
  attentionEvents,
  isOrchestratorActive,
  isOrchestratorIdleNotice,
  ORCHESTRATOR,
} from './rules'
import { forgetSessions, setLastNotice, setWaiting, useAttentionStore } from './store'

type Sessions = Record<string, OrchestraSession>
type SourceState = { sessions: Sessions }

export type AttentionSource<S extends SourceState = SourceState> = {
  getState: () => S
  subscribe: (listener: (state: S, prev: S) => void) => () => void
  /** Bus events of the running sessions, after the store applied them. */
  listen: (handler: (event: OrchestraEvent) => void) => () => void
  /** Sessions on screen in the Orchestra view. */
  shown: (state: S) => string[]
}

export type AttentionDeps = {
  notify: (title: string, body: string) => void | Promise<void>
  /** The user is looking at this session: app focused, Orchestra view open, session on screen. */
  watching: (sessionId: string) => boolean
  /** The Alerts switch; when off, only the badge and the live region keep counting. */
  alerts: () => boolean
  /** Name of a session in a notice, to tell orchestrations apart. */
  label: (session: OrchestraSession) => string
  isMainWindow: () => boolean
  /** Long-block reminders: when they start and how often they repeat. */
  escalation: () => EscalationPrefs
  /** Blocks the user silenced. */
  muted: () => Record<string, true>
  /** Asks the OS to flag the app (taskbar flash). */
  flash: () => void
  /** Runs `run` every `ms`; returns its stop. */
  every: (ms: number, run: () => void) => () => void
}

/** How often long blocks are checked for a reminder. */
export const ESCALATION_TICK_MS = 30_000

/** Events closer than this go out as one notice. */
export const BATCH_MS = 1200
/** The same agent and kind notify at most once per this period. */
export const COOLDOWN_MS = 60_000
/** An occurrence already announced is ignored for this long. */
export const DEDUPE_MS = 10 * 60_000

const MAX_BODY = 220

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(getLocale(), key, params)

const clip = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_BODY ? `${line.slice(0, MAX_BODY - 1)}…` : line
}

function folderName(cwd: string | null): string {
  return (
    (cwd ?? '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === 'main'
  } catch {
    // No Tauri window (tests, the plain browser build): nothing to notify from.
    return false
  }
}

function defaults<S extends SourceState>(source: AttentionSource<S>): AttentionDeps {
  return {
    notify: (title, body) => notifyAgentDone(title, body, { agent: 'claude' }),
    watching: (sessionId) => {
      try {
        if (!document.hasFocus()) return false
      } catch {
        return false
      }
      if (useUiStore.getState().activeView !== 'orchestra') return false
      return source.shown(source.getState()).includes(sessionId)
    },
    alerts: readAlertsEnabled,
    label: (session) =>
      (session.projectId
        ? useProjectsStore.getState().projects.find((p) => p.id === session.projectId)?.name
        : undefined) ||
      folderName(session.cwd) ||
      session.id,
    isMainWindow,
    escalation: readEscalation,
    muted: () => useAttentionStore.getState().muted,
    flash: () => {
      try {
        void getCurrentWindow()
          .requestUserAttention(UserAttentionType.Critical)
          .catch(() => {})
      } catch {
        // No window to flag.
      }
    },
    every: (ms, run) => {
      const timer = setInterval(run, ms)
      return () => clearInterval(timer)
    },
  }
}

function agentName(agent: Pick<OrchestraAgent, 'id' | 'area'> | undefined, id: string): string {
  if (id === ORCHESTRATOR) return tr('orchestra.orchestrator')
  return agent?.area && agent.area !== id ? `${id} (${agent.area})` : id
}

/** How an agent ended, in the agent cards' words (`exitDescription` in shared.ts, which imports the store). */
function exitSummary(agent: OrchestraAgent | undefined): string {
  switch (agent?.exitReason) {
    case 'launch-failed':
      return tr('orchestra.agents.exit.launchFailed')
    case 'launch-timeout':
      return tr('orchestra.agents.exit.launchTimeout')
    case 'killed':
      return tr('orchestra.agents.exit.killed')
    case 'suspended':
      return tr('orchestra.agents.exit.suspended')
    case 'restarted':
      return tr('orchestra.agents.exit.restarted')
    default:
      return typeof agent?.exitCode === 'number'
        ? tr('orchestra.agents.exit.exited', { code: agent.exitCode })
        : tr('orchestra.agents.exit.exitedNoCode')
  }
}

/** Title and body of one event, in the user's language. */
export function describe(
  event: AttentionEvent,
  session: OrchestraSession,
): { title: string; body: string } {
  const agent = session.agents.find((a) => a.id === event.agentId)
  const name = agentName(agent, event.agentId ?? '')
  switch (event.kind) {
    case 'blocked': {
      const block = agent?.state === 'blocked' ? agent.blocked : null
      if (block && isScreenBlock(block)) {
        return {
          title: tr('orchestra.attention.screenTitle', {
            agent: name,
            reason: tr(blockReasonKey(block.reason)),
          }),
          body: clip(blockDetail(block, tr) || tr('orchestra.agents.blocked.noText')),
        }
      }
      return {
        title: tr('orchestra.attention.blockedTitle', { agent: name }),
        body: clip(event.text || tr('orchestra.agents.blocked.noText')),
      }
    }
    case 'failed': {
      const why = exitSummary(agent)
      return {
        title: tr('orchestra.attention.failedTitle', { agent: name }),
        body: clip(event.text ? `${why} · ${event.text}` : why),
      }
    }
    case 'allDone': {
      const count = session.agents.filter((a) => a.id !== ORCHESTRATOR).length
      return {
        title: tr('orchestra.attention.allDoneTitle'),
        body:
          count === 1
            ? tr('orchestra.attention.allDoneBodyOne')
            : tr('orchestra.attention.allDoneBody', { count }),
      }
    }
    case 'waiting':
      return {
        title: tr('orchestra.attention.waitingTitle'),
        body: clip(event.text || tr('orchestra.attention.waitingFallback')),
      }
  }
}

export function installAttention<S extends SourceState>(
  source: AttentionSource<S>,
  overrides: Partial<AttentionDeps> = {},
): () => void {
  const deps: AttentionDeps = { ...defaults(source), ...overrides }
  if (!deps.isMainWindow()) return () => {}

  let pending: AttentionEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const seen = new Map<string, number>()
  const lastTopic = new Map<string, number>()
  const lastAnswer = new Map<string, string>()

  const flush = () => {
    timer = null
    const batch = pending
    pending = []
    const sessions = source.getState().sessions
    const many = Object.keys(sessions).length > 1
    const notices: { title: string; body: string }[] = []
    for (const event of batch) {
      const session = sessions[event.sessionId]
      if (!session) continue
      const { title, body } = describe(event, session)
      // The session's live region announces everything, on screen or not, alerts on or off.
      setLastNotice(event.sessionId, { text: `${title}. ${body}`, at: event.at })
      // The orchestrator stuck on a screen stops the whole session: the user hears of it at once.
      const urgent = event.kind === 'blocked' && event.agentId === ORCHESTRATOR
      if (!deps.alerts() || (deps.watching(event.sessionId) && !urgent)) continue
      const topic = `${event.sessionId}:${event.agentId ?? '*'}:${event.kind}`
      const last = lastTopic.get(topic)
      if (last !== undefined && event.at - last < COOLDOWN_MS) continue
      lastTopic.set(topic, event.at)
      notices.push({ title, body: many ? `${deps.label(session)} · ${body}` : body })
    }
    if (notices.length === 0) return
    if (notices.length === 1) {
      void deps.notify(notices[0].title, notices[0].body)
      return
    }
    void deps.notify(
      tr('orchestra.attention.manyTitle', { count: notices.length }),
      clip(notices.map((n) => n.title).join(' · ')),
    )
  }

  const queue = (event: AttentionEvent) => {
    const before = seen.get(event.key)
    if (before !== undefined && event.at - before < DEDUPE_MS) return
    seen.set(event.key, event.at)
    if (seen.size > 500) {
      for (const [key, at] of seen) if (event.at - at >= DEDUPE_MS) seen.delete(key)
    }
    pending.push(event)
    if (timer === null) timer = setTimeout(flush, BATCH_MS)
  }

  const unsubscribe = source.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return
    for (const event of attentionEvents(prev.sessions, state.sessions, Date.now())) queue(event)
    // Stopping a session ends its orchestrator's wait: there is nobody left to answer.
    for (const [id, session] of Object.entries(state.sessions))
      if (session.stoppedAt && !prev.sessions[id]?.stoppedAt) setWaiting(id, null)
    if (Object.keys(state.sessions).length !== Object.keys(prev.sessions).length) {
      const alive = new Set(Object.keys(state.sessions))
      forgetSessions(alive)
      for (const id of lastAnswer.keys()) if (!alive.has(id)) lastAnswer.delete(id)
    }
  })

  const unlisten = source.listen((event) => {
    if (event.kind !== 'hook') return
    const session = source.getState().sessions[event.session]
    if (!session) return
    if (
      event.agent_id === ORCHESTRATOR &&
      event.hook.hook_event_name === 'Stop' &&
      event.hook.last_assistant_message
    ) {
      lastAnswer.set(event.session, event.hook.last_assistant_message)
    }
    if (isOrchestratorActive(event)) setWaiting(event.session, null)
    if (isOrchestratorIdleNotice(event, session.agents)) {
      const text = (lastAnswer.get(event.session) ?? '').trim()
      setWaiting(event.session, { text, at: event.at })
      queue({
        kind: 'waiting',
        sessionId: event.session,
        agentId: ORCHESTRATOR,
        text,
        key: `${event.session}:waiting:${event.at}`,
        at: event.at,
      })
    }
  })

  const sent = new Map<string, number>()
  const remind = () => {
    const sessions = source.getState().sessions
    const due = dueEscalations(sessions, Date.now(), deps.escalation(), sent, deps.muted())
    if (due.length === 0 || !deps.alerts()) return
    const notices = due.map((item: Escalation) => {
      const session = sessions[item.sessionId]
      const agent = session?.agents.find((a) => a.id === item.agentId)
      const reason = tr(blockReasonKey(item.block.reason))
      return {
        title: tr('orchestra.attention.longBlockTitle', {
          agent: agentName(agent, item.agentId),
          minutes: item.minutes,
        }),
        body: clip(
          `${reason}${Object.keys(sessions).length > 1 && session ? ` · ${deps.label(session)}` : ''}`,
        ),
      }
    })
    deps.flash()
    if (notices.length === 1) void deps.notify(notices[0].title, notices[0].body)
    else
      void deps.notify(
        tr('orchestra.attention.manyTitle', { count: notices.length }),
        clip(notices.map((n) => n.title).join(' · ')),
      )
  }
  const stopReminders = deps.every(ESCALATION_TICK_MS, remind)

  return () => {
    stopReminders()
    unsubscribe()
    unlisten()
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = []
  }
}
