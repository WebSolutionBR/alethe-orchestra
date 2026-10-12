import type { SessionLaunch } from '../usage/launch'

/**
 * localStorage key of "On hitting the limit: wait for the reset and continue". '1' on, '0' off;
 * unset follows the session's policy (see `readAutoWaitOnLimit`).
 */
export const AUTO_WAIT_STORAGE_KEY = 'orchestra.accounts.autoWaitOnLimit'

/** The choice made in this run: read first, so it holds even where storage is unavailable. */
let memory: boolean | null = null

/**
 * Whether the first agent of a session stopped by the usage limit arms the wait for the reset
 * by itself. Unset: on in the "One account" policy (every worker shares one quota, so waiting
 * is the only way on), off when spreading across accounts. Storage errors fall back to that.
 */
export function readAutoWaitOnLimit(policy: SessionLaunch['policy']): boolean {
  if (memory !== null) return memory
  try {
    const saved = localStorage.getItem(AUTO_WAIT_STORAGE_KEY)
    if (saved === '1') return true
    if (saved === '0') return false
  } catch {
    // Unavailable storage: the default below.
  }
  return policy === 'single'
}

export function writeAutoWaitOnLimit(on: boolean): void {
  memory = on
  try {
    localStorage.setItem(AUTO_WAIT_STORAGE_KEY, on ? '1' : '0')
  } catch {
    // Unavailable storage: the switch still applies until the app restarts.
  }
}

/** Tests only: forgets the in-memory choice so storage is read again. */
export function resetAutoWaitMemory(): void {
  memory = null
}
