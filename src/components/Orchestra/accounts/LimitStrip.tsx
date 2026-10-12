import { AlertTriangle, Clock } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  cancelLimitWait,
  continueAfterLimitReset,
  limitBlockedAgents,
  limitWaitOf,
  USAGE_LIMIT_REASON,
} from '../../../lib/limitResetWatch'
import { clockTime } from '../sessionActions'
import { useSession, useSessionId } from '../sessionContext'
import styles from './Accounts.module.css'
import { useAccountName, useSessionAccountRow, useSessionLaunch } from './hooks'
import { limitedUntil, limitResetAt, MAX_LIMIT_REARMS, waitingText } from './model'

/**
 * "<account> is at its usage limit until HH:MM" under the session header, while the session's
 * account is full (by its usage) or agents on it are stopped by the limit. It offers switching
 * the session's account (the panel) or waiting: at the reset, those agents get "continue".
 * The reset comes from the usage cache, else from the screen of the agents stopped by the limit
 * (the usage API is often answering 429 right then); without either it shows "?" and only
 * offers the switch.
 */
export function LimitStrip({ onSwitch, now }: { onSwitch: () => void; now: number }) {
  const t = useT()
  const sessionId = useSessionId()
  const launch = useSessionLaunch()
  const nameOf = useAccountName()
  const row = useSessionAccountRow()
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  // Re-read on every render (the session ticks each second); the wait lives in limitResetWatch.
  const [, setWaitTick] = useState(0)
  const blocked = useSession((s) =>
    s.agents.some((a) => (a.blocked?.reason as string | undefined) === USAGE_LIMIT_REASON),
  )
  // Joined into a string so the selector stays stable between the session's ticks.
  const blockedResets = useSession((s) =>
    s.agents
      .filter(
        (a) =>
          (a.blocked?.reason as string | undefined) === USAGE_LIMIT_REASON &&
          (a.launchedWith?.account ?? null) === (launch.account ?? null),
      )
      .map((a) => a.blocked?.resetAt ?? 0)
      .join(','),
  )
  if (stopped) return null
  const until = limitedUntil(row?.usage)
  const full = until !== null && until > now
  const hitByAgents = blocked && limitBlockedAgents(sessionId, launch.account).length > 0
  const wait = limitWaitOf(sessionId)
  const waiting = wait !== null && wait.account === launch.account
  // Armed again after the limit came back, armed by itself, or by the Wait button.
  const label = wait ? waitingText(wait) : null
  if (!full && !hitByAgents && !waiting) return null
  const resetAt = limitResetAt(
    row?.usage,
    blockedResets ? blockedResets.split(',').map(Number) : [],
    now,
  )
  const time = resetAt !== null ? clockTime(resetAt) : '?'

  const onWait = () => {
    if (resetAt === null) return
    continueAfterLimitReset({ sessionId, account: launch.account, resetsAt: resetAt })
    setWaitTick((n) => n + 1)
  }
  const onCancel = () => {
    cancelLimitWait(sessionId)
    setWaitTick((n) => n + 1)
  }

  return (
    <div className={styles.strip} role="status">
      <AlertTriangle size={13} aria-hidden="true" />
      <span className={styles.stripText}>
        {t('orchestra.limit.strip', { name: nameOf(launch.account), time })}
      </span>
      {waiting ? (
        <>
          <span
            className={styles.waiting}
            title={wait.auto ? t('orchestra.limit.waitingAutoTitle') : undefined}
          >
            <Clock size={12} aria-hidden="true" />
            {label?.key === 'orchestra.limit.rearmed'
              ? t(label.key, {
                  time: clockTime(wait.resetsAt),
                  count: label.count,
                  max: MAX_LIMIT_REARMS,
                })
              : t(label?.key ?? 'orchestra.limit.waiting', { time: clockTime(wait.resetsAt) })}
          </span>
          <button type="button" className={styles.btn} onClick={onCancel}>
            {t('orchestra.limit.cancelWait')}
          </button>
        </>
      ) : resetAt !== null ? (
        <button
          type="button"
          className={styles.btn}
          title={t('orchestra.limit.waitTitle')}
          onClick={onWait}
        >
          {t('orchestra.limit.wait')}
        </button>
      ) : null}
      <button type="button" className={styles.btn} onClick={onSwitch}>
        {t('orchestra.limit.switch')}
      </button>
    </div>
  )
}
