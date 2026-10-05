import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CREATIVE_AREA,
  CREATIVE_STORAGE_KEY,
  creativePromptHint,
  creativeWorkerTask,
  GOAL_PLACEHOLDER,
  isCreativeArea,
  readCreativeEnabled,
  writeCreativeEnabled,
} from './role'

/** Characters that cmd.exe, PowerShell or bash would interpret inside an `orch spawn` line. */
const SHELL_SPECIAL = /["'`%!$^&|<>\r\n]/

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('creative switch preference', () => {
  it('is on by default', () => {
    expect(readCreativeEnabled()).toBe(true)
  })

  it('remembers off and on', () => {
    writeCreativeEnabled(false)
    expect(localStorage.getItem(CREATIVE_STORAGE_KEY)).toBe('0')
    expect(readCreativeEnabled()).toBe(false)
    writeCreativeEnabled(true)
    expect(localStorage.getItem(CREATIVE_STORAGE_KEY)).toBe('1')
    expect(readCreativeEnabled()).toBe(true)
  })

  it('treats unknown values as on and a stored false as off', () => {
    localStorage.setItem(CREATIVE_STORAGE_KEY, 'garbage')
    expect(readCreativeEnabled()).toBe(true)
    localStorage.setItem(CREATIVE_STORAGE_KEY, 'false')
    expect(readCreativeEnabled()).toBe(false)
  })

  it('tolerates storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(readCreativeEnabled()).toBe(true)
    expect(() => writeCreativeEnabled(false)).not.toThrow()
  })
})

describe('isCreativeArea', () => {
  it('matches the creative area only', () => {
    expect(isCreativeArea(CREATIVE_AREA)).toBe(true)
    expect(isCreativeArea(' Criativo ')).toBe(true)
    expect(isCreativeArea('criativo-ui')).toBe(false)
    expect(isCreativeArea('orchestrator')).toBe(false)
    expect(isCreativeArea('')).toBe(false)
    expect(isCreativeArea(null)).toBe(false)
    expect(isCreativeArea(undefined)).toBe(false)
  })
})

describe('creativeWorkerTask', () => {
  it('carries the goal and every fundamental the role checks', () => {
    const task = creativeWorkerTask('Improve the terminal views')
    expect(task).toContain('Session goal: Improve the terminal views.')
    for (const topic of [
      'useful features',
      'design',
      'empty and error states',
      'undo',
      'persistence',
      'shortcuts and discoverability',
      'accessibility',
      'i18n',
      'performance',
      'progress',
      'data safety',
    ]) {
      expect(task).toContain(topic)
    }
    expect(task).toContain('never edit a file')
    expect(task).toContain('orch.cmd send orchestrator')
    expect(task).toContain('Implement only what the orchestrator')
  })

  it('stays one shell-safe line whatever the goal holds', () => {
    const task = creativeWorkerTask('Fix "login" & 100% <fast> | ok!\nnext line $HOME `x`')
    expect(task).not.toMatch(SHELL_SPECIAL)
    expect(task).toContain('Session goal: Fix login 100 fast ok next line HOME x.')
  })

  it('falls back to a neutral goal when none is given', () => {
    expect(creativeWorkerTask('  ')).toContain('Session goal: the goal the orchestrator gives you.')
  })
})

describe('creativePromptHint', () => {
  it('is empty when the switch is off', () => {
    expect(creativePromptHint({ enabled: false })).toBe('')
    writeCreativeEnabled(false)
    expect(creativePromptHint()).toBe('')
  })

  it('asks the orchestrator to keep the creative worker, with the placeholder task', () => {
    const hint = creativePromptHint()
    expect(hint).toContain(`orch.cmd spawn ${CREATIVE_AREA}`)
    expect(hint).toContain('does not count toward the worker limit')
    expect(hint).toContain(`with ${GOAL_PLACEHOLDER} replaced by the user goal`)
    expect(hint).toContain('implements only what you approve')
    expect(hint).toContain(creativeWorkerTask(GOAL_PLACEHOLDER))
    expect(hint).not.toMatch(SHELL_SPECIAL)
  })

  it('embeds the session goal when it is known', () => {
    const hint = creativePromptHint({ goal: 'Ship the scribe', enabled: true })
    expect(hint).toContain('Session goal: Ship the scribe.')
    expect(hint).not.toContain(`with ${GOAL_PLACEHOLDER} replaced`)
    expect(hint).not.toMatch(SHELL_SPECIAL)
  })

  it('stays short enough for a command-line system prompt', () => {
    expect(creativePromptHint().length).toBeLessThan(2000)
  })
})
