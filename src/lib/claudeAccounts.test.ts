import { describe, expect, it } from 'vitest'

import { accountErrorKey, LOGIN_EXPIRY_WARN_DAYS, loginDaysLeft } from './claudeAccounts'

describe('accountErrorKey', () => {
  it('maps each backend error to its message', () => {
    expect(accountErrorKey('no_token')).toBe('claudeAccounts.signedOut')
    expect(accountErrorKey('login_expired')).toBe('claudeAccounts.loginExpired')
    expect(accountErrorKey('token_expired')).toBe('claudeAccounts.tokenExpired')
    expect(accountErrorKey('unauthorized')).toBe('claudeAccounts.tokenExpired')
    expect(accountErrorKey('API returned 500')).toBe('claudeAccounts.usageError')
  })
})

describe('loginDaysLeft', () => {
  const now = 1_000_000_000_000
  const day = 86_400_000

  it('warns only inside the window', () => {
    expect(loginDaysLeft(now + 2 * day, now)).toBe(2)
    expect(loginDaysLeft(now + LOGIN_EXPIRY_WARN_DAYS * day, now)).toBe(LOGIN_EXPIRY_WARN_DAYS)
    expect(loginDaysLeft(now + (LOGIN_EXPIRY_WARN_DAYS + 1) * day, now)).toBeNull()
  })

  it('stays quiet when unknown or already lapsed', () => {
    expect(loginDaysLeft(null, now)).toBeNull()
    expect(loginDaysLeft(undefined, now)).toBeNull()
    expect(loginDaysLeft(now - day, now)).toBeNull()
  })
})
