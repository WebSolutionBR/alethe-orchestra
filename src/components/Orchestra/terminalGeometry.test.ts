import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SPAWN_SIZE,
  rememberViewSize,
  resetTerminalGeometryCache,
  spawnTerminalSize,
  TERMINAL_SIZE_KEY,
  validTerminalSize,
} from './terminalGeometry'

describe('validTerminalSize', () => {
  it('floors real measurements', () => {
    expect(validTerminalSize(96.7, 30.2)).toEqual({ cols: 96, rows: 30 })
  })

  it('rejects boxes no one reads and glitches', () => {
    expect(validTerminalSize(0, 0)).toBeNull()
    expect(validTerminalSize(12, 30)).toBeNull()
    expect(validTerminalSize(100, 2)).toBeNull()
    expect(validTerminalSize(5000, 30)).toBeNull()
    expect(validTerminalSize(Number.NaN, 30)).toBeNull()
    expect(validTerminalSize('100', 30)).toBeNull()
  })
})

describe('spawn size rule', () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(TERMINAL_SIZE_KEY)
    resetTerminalGeometryCache()
  })

  it('uses 100x30 until a view has measured a terminal', () => {
    expect(DEFAULT_SPAWN_SIZE).toEqual({ cols: 100, rows: 30 })
    expect(spawnTerminalSize('orchestrator')).toEqual({ cols: 100, rows: 30 })
    expect(spawnTerminalSize('worker')).toEqual({ cols: 100, rows: 30 })
  })

  it('spawns each role at the size its last view had, borrowing the other role first', () => {
    expect(rememberViewSize('worker', 72, 24)).toBe(true)
    expect(spawnTerminalSize('worker')).toEqual({ cols: 72, rows: 24 })
    expect(spawnTerminalSize('orchestrator')).toEqual({ cols: 72, rows: 24 })

    rememberViewSize('orchestrator', 140, 42)
    expect(spawnTerminalSize('orchestrator')).toEqual({ cols: 140, rows: 42 })
    expect(spawnTerminalSize('worker')).toEqual({ cols: 72, rows: 24 })
  })

  it('keeps the last valid size: hidden or collapsing views do not count', () => {
    rememberViewSize('worker', 90, 28)
    expect(rememberViewSize('worker', 3, 1)).toBe(false)
    expect(rememberViewSize('worker', 90, 28)).toBe(false)
    expect(spawnTerminalSize('worker')).toEqual({ cols: 90, rows: 28 })
  })

  it('survives a restart through storage and ignores corrupt entries', () => {
    rememberViewSize('worker', 81, 27)
    resetTerminalGeometryCache()
    expect(spawnTerminalSize('worker')).toEqual({ cols: 81, rows: 27 })

    localStorage.setItem(
      TERMINAL_SIZE_KEY,
      JSON.stringify({ worker: { cols: 'wide', rows: 27 }, orchestrator: { cols: 130, rows: 40 } }),
    )
    resetTerminalGeometryCache()
    expect(spawnTerminalSize('worker')).toEqual({ cols: 130, rows: 40 })

    localStorage.setItem(TERMINAL_SIZE_KEY, '{not json')
    resetTerminalGeometryCache()
    expect(spawnTerminalSize('orchestrator')).toEqual(DEFAULT_SPAWN_SIZE)
  })

  it('hands out copies, so callers cannot change what is remembered', () => {
    const size = spawnTerminalSize('worker')
    size.cols = 1
    expect(spawnTerminalSize('worker')).toEqual(DEFAULT_SPAWN_SIZE)
  })

  it('still remembers for this run when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    rememberViewSize('orchestrator', 120, 36)
    expect(spawnTerminalSize('orchestrator')).toEqual({ cols: 120, rows: 36 })
  })
})
