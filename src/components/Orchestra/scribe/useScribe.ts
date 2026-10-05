import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { intlLocale, type MessageKey, useT } from '../../../lib/i18n'
import type { BusMessage } from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useAuthorStatus } from './authorStatus'
import { useScribeConfig } from './config'
import { type ScribeState, scribeState, scribeStateColor } from './health'
import { SCRIBE_ID } from './identity'
import { useScribeStatus } from './service'

export type ScribeView = {
  state: ScribeState
  /** Short state text: listening, writing, 3 pending, failing, off. */
  label: string
  /** Theme token for the state. */
  color: string
  /** Why the scribe cannot write, in the user's language; null while it can. */
  reason: string | null
}

/**
 * The scribe's state as every mark shows it (chip, nodes, cards, tiles). With a session, its
 * author counts too: a note being written, scheduled, or a synthesis that failed.
 */
export function useScribeView(sessionId: string | null = null): ScribeView {
  const t = useT()
  const enabled = useScribeConfig((s) => s.enabled)
  const author = useAuthorStatus(sessionId)
  const { issue, sending, pending, failures, lastError } = useScribeStatus(
    useShallow((s) => ({
      issue: s.health.issue,
      sending: s.sending,
      pending: s.pending,
      failures: s.failures,
      lastError: s.lastError,
    })),
  )
  const state = scribeState({ enabled, issue, sending, pending, failures, author: author.phase })
  const label =
    state === 'pending'
      ? t('orchestra.scribe.state.pending', { count: pending })
      : t(`orchestra.scribe.state.${state}` as MessageKey)
  const reason = !enabled
    ? t('orchestra.scribe.offHint')
    : issue
      ? t(`orchestra.scribe.issue.${issue}` as MessageKey)
      : failures > 0 && lastError
        ? t('orchestra.scribe.issue.write', { error: lastError })
        : author.phase === 'failed' && author.failure
          ? t('orchestra.scribe.author.failedReason', {
              reason: t(`orchestra.scribe.author.failure.${author.failure}` as MessageKey),
            })
          : null
  return { state, label, color: scribeStateColor(state), reason }
}

/** The scribe's `obsidian → <note>` lines among a session's bus messages. */
export function useScribeLines(messages: BusMessage[]): BusMessage[] {
  return useMemo(() => messages.filter((m) => m.from === SCRIBE_ID), [messages])
}

/** "12 s ago" / "há 12 s" style labels in the user's language; refreshed every few seconds. */
export function useRelativeTime(live = true): (at: number) => string {
  const locale = useProjectsStore((s) => s.preferences.language)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setTick((n) => n + 1), 5_000)
    return () => window.clearInterval(timer)
  }, [live])
  const format = useMemo(
    () => new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto', style: 'short' }),
    [locale],
  )
  return (at: number) => {
    const seconds = Math.round((at - Date.now()) / 1000)
    const abs = Math.abs(seconds)
    if (abs < 60) return format.format(seconds, 'second')
    if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
    if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
    return format.format(Math.round(seconds / 86_400), 'day')
  }
}
