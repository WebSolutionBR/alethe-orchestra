import { create } from 'zustand'

import type { useT } from '../../../lib/i18n'
import { cancelLimitWait, continueAfterLimitReset, limitWaitOf } from '../../../lib/limitResetWatch'
import { confirmStop, type LimitWait, useOrchestraStore } from '../../../stores/orchestraStore'
import { sessionLaunchOf } from '../usage/launchDefaults'
import type { SwitchRisk } from './model'

type Translate = ReturnType<typeof useT>

/** How long the "Session account: A → B [Undo]" toast stays. */
export const UNDO_SWITCH_MS = 10_000

/** The last switch of each session, while its undo toast is up. */
export type AccountSwitchUndo = {
  from: string | null
  to: string | null
  /** When the toast goes away (epoch ms); meaningless while `paused`. */
  until: number
  /** The wait for the limit reset the switch cancelled: undo arms it again if still ahead. */
  wait: LimitWait | null
  /** Hovered or focused: the time that was left, kept until it resumes. */
  paused?: number | null
}

type UndoState = {
  bySession: Record<string, AccountSwitchUndo>
  clear: (sessionId: string) => void
  /** Stops the toast's countdown (pointer over it, focus inside it). */
  pause: (sessionId: string, now?: number) => void
  /** Restarts it with the time that was left. */
  resume: (sessionId: string, now?: number) => void
}

export const useAccountSwitchUndo = create<UndoState>((set) => ({
  bySession: {},
  clear: (sessionId) =>
    set((s) => {
      const { [sessionId]: _gone, ...rest } = s.bySession
      return { bySession: rest }
    }),
  pause: (sessionId, now = Date.now()) =>
    set((s) => {
      const undo = s.bySession[sessionId]
      if (!undo || undo.paused != null) return s
      const left = Math.max(0, undo.until - now)
      return { bySession: { ...s.bySession, [sessionId]: { ...undo, paused: left } } }
    }),
  resume: (sessionId, now = Date.now()) =>
    set((s) => {
      const undo = s.bySession[sessionId]
      if (!undo || undo.paused == null) return s
      const next = { ...undo, until: now + undo.paused, paused: null }
      return { bySession: { ...s.bySession, [sessionId]: next } }
    }),
}))

/**
 * Switches the session's account (null: the default account). A pending "wait for the limit
 * reset" belongs to the old account, so it is dropped.
 */
export function switchSessionAccount(sessionId: string, account: string | null): void {
  cancelLimitWait(sessionId)
  useOrchestraStore.getState().setSessionAccount(sessionId, account)
}

/**
 * "Use in this session": switches and offers the undo toast for UNDO_SWITCH_MS. A target with
 * risks (an error, >= 90% of a window, a duplicate sign-in) is only used after a confirmation.
 * Resolves to whether it switched.
 */
export async function switchSessionAccountGuarded(
  sessionId: string,
  account: string | null,
  risks: SwitchRisk[],
  targetName: string,
  t: Translate,
  now: () => number = Date.now,
): Promise<boolean> {
  const session = useOrchestraStore.getState().sessions[sessionId]
  if (!session || session.stoppedAt) return false
  const from = sessionLaunchOf(session).account
  if ((from ?? null) === (account ?? null)) return false
  if (risks.length > 0) {
    const reasons = risks.map((risk) => t(`orchestra.accounts.risk.${risk}`)).join(' ')
    const ok = await confirmStop(
      t('orchestra.accounts.riskConfirm', { name: targetName, reasons }),
      {
        title: t('orchestra.accounts.riskTitle', { name: targetName }),
        okLabel: t('orchestra.accounts.useHere'),
        cancelLabel: t('common.cancel'),
      },
    )
    if (!ok) return false
  }
  const wait = limitWaitOf(sessionId)
  switchSessionAccount(sessionId, account)
  useAccountSwitchUndo.setState((s) => ({
    bySession: {
      ...s.bySession,
      [sessionId]: { from, to: account, until: now() + UNDO_SWITCH_MS, wait },
    },
  }))
  return true
}

/**
 * The toast's "Undo": back to the account the session had before the last switch, and its wait
 * for the limit reset (which the switch cancelled) armed again while that reset is still ahead.
 */
export function undoAccountSwitch(sessionId: string, now: () => number = Date.now): void {
  const undo = useAccountSwitchUndo.getState().bySession[sessionId]
  useAccountSwitchUndo.getState().clear(sessionId)
  if (!undo) return
  const session = useOrchestraStore.getState().sessions[sessionId]
  if (!session || session.stoppedAt) return
  switchSessionAccount(sessionId, undo.from)
  const wait = undo.wait
  if (wait && wait.account === undo.from && wait.resetsAt > now())
    continueAfterLimitReset({
      sessionId,
      account: wait.account,
      resetsAt: wait.resetsAt,
      ...(wait.auto ? { auto: true } : {}),
    })
}
