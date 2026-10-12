import { create } from 'zustand'

import {
  ACCOUNT_POLICIES,
  type AccountPolicy,
  DEFAULT_POLICY,
  EMPTY_LAUNCH,
  type LaunchOptions,
  type SessionLaunch,
} from './launch'

const KEY = 'orchestra.launchDefaults'

function load(): SessionLaunch {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SessionLaunch> | null
    if (saved && typeof saved === 'object') {
      const pick = (v: unknown) => (typeof v === 'string' && v ? v : null)
      const policy = ACCOUNT_POLICIES.includes(saved.policy as AccountPolicy)
        ? (saved.policy as AccountPolicy)
        : DEFAULT_POLICY
      return {
        policy,
        account: pick(saved.account),
        model: pick(saved.model),
        effort: pick(saved.effort),
      }
    }
  } catch {
    // Unreadable storage just means no remembered defaults.
  }
  return { ...EMPTY_LAUNCH, policy: DEFAULT_POLICY }
}

type LaunchDefaultsState = SessionLaunch & {
  setDefaults: (patch: Partial<SessionLaunch>) => void
}

/**
 * What the start screen's launch form starts from: account policy, account, model and effort.
 * A new session copies them into its own `launch`; remembered across sessions.
 */
export const useLaunchDefaults = create<LaunchDefaultsState>((set, get) => ({
  ...load(),
  setDefaults: (patch) => {
    set(patch)
    const { policy, account, model, effort } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ policy, account, model, effort }))
    } catch {
      // Non-persistent storage only loses the remembered defaults.
    }
  },
}))

export function launchDefaults(): LaunchOptions {
  const { account, model, effort } = useLaunchDefaults.getState()
  return { account, model, effort }
}

/** The launch form's values as a new session's own launch settings. */
export function sessionLaunchDefaults(): SessionLaunch {
  const { policy, account, model, effort } = useLaunchDefaults.getState()
  return { policy, account, model, effort }
}

/**
 * A session's launch settings. Sessions from before `launch` existed run on one account, the
 * form's current one.
 */
export function sessionLaunchOf(session: { launch?: SessionLaunch | null }): SessionLaunch {
  return session.launch ?? { ...sessionLaunchDefaults(), policy: DEFAULT_POLICY }
}
