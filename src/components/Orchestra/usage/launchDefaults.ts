import { create } from 'zustand'

import { EMPTY_LAUNCH, type LaunchOptions } from './launch'

const KEY = 'orchestra.launchDefaults'

function load(): LaunchOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LaunchOptions> | null
    if (saved && typeof saved === 'object') {
      const pick = (v: unknown) => (typeof v === 'string' && v ? v : null)
      return { account: pick(saved.account), model: pick(saved.model), effort: pick(saved.effort) }
    }
  } catch {
    // Unreadable storage just means no remembered defaults.
  }
  return EMPTY_LAUNCH
}

type LaunchDefaultsState = LaunchOptions & {
  setDefaults: (patch: Partial<LaunchOptions>) => void
}

/**
 * Account / model / effort used for the orchestrator and for any worker spawned
 * without `--account`, `--model` or `--effort`. Remembered across sessions.
 */
export const useLaunchDefaults = create<LaunchDefaultsState>((set, get) => ({
  ...load(),
  setDefaults: (patch) => {
    set(patch)
    const { account, model, effort } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ account, model, effort }))
    } catch {
      // Non-persistent storage only loses the remembered defaults.
    }
  },
}))

export function launchDefaults(): LaunchOptions {
  const { account, model, effort } = useLaunchDefaults.getState()
  return { account, model, effort }
}
