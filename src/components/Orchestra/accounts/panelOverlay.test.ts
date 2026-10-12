import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Read from disk (vitest runs from the repo root): it stubs CSS imports, `?raw` included.
const css = readFileSync(resolve('src/components/Orchestra/accounts/Accounts.module.css'), 'utf8')
const index = readFileSync(resolve('src/components/Orchestra/index.tsx'), 'utf8')

function rule(selector: string): string {
  const match = new RegExp(`\\n\\${selector} \\{([^}]*)\\}`).exec(css)
  return match?.[1] ?? ''
}

describe('accounts panel over the main area', () => {
  // A panel in the flex row would take width from <main>, and every agent terminal in it
  // would resize its PTY on each open and close. Placed over it, <main> keeps its size.
  it('is positioned absolutely over the session body, with a token shadow', () => {
    const panel = rule('.panel')
    expect(panel).toMatch(/position:\s*absolute/)
    expect(panel).not.toMatch(/\bflex:\s*none/)
    expect(panel).toMatch(/box-shadow:\s*var\(--shadow-/)
    expect(rule('.host')).toMatch(/position:\s*relative/)
  })

  it('the session body is the positioned host the panel is placed in', () => {
    expect(index).toContain('className={`${styles.body} ${accountStyles.host}`}')
  })
})
