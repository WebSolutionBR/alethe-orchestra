import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'

import type { OrchestraSession } from '../../../stores/orchestraStore'
import type { OrchestraManifest } from './manifest'
import { closingOrchestrations, flushManifests, installManifests } from './persist'

type State = { sessions: Record<string, OrchestraSession> }

function session(id: string, patch: Partial<OrchestraSession> = {}): OrchestraSession {
  return {
    id,
    projectId: null,
    cwd: 'C:\\repo',
    goal: 'goal',
    autonomous: true,
    startedAt: 1,
    mode: 'constellation',
    agents: [],
    messages: [],
    segments: [],
    selectedId: null,
    error: null,
    ...patch,
  }
}

const DELAY = 1000

describe('session manifests', () => {
  let store: ReturnType<typeof createStore<State>>
  let save: ReturnType<typeof vi.fn<(id: string, manifest: OrchestraManifest) => Promise<void>>>
  let remove: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
  let dispose: () => void

  const put = (s: OrchestraSession) =>
    store.setState((state) => ({ sessions: { ...state.sessions, [s.id]: s } }))
  const drop = (id: string) =>
    store.setState((state) => {
      const sessions = { ...state.sessions }
      delete sessions[id]
      return { sessions }
    })
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(DELAY)
    await flushManifests()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    store = createStore<State>(() => ({ sessions: {} }))
    save = vi.fn(() => Promise.resolve())
    remove = vi.fn(() => Promise.resolve())
    dispose = installManifests({
      getState: store.getState,
      subscribe: store.subscribe,
      save,
      remove,
      delayMs: DELAY,
      now: () => 42,
    })
  })

  afterEach(() => {
    dispose()
    vi.useRealTimers()
  })

  it('writes a changed session once, after a quiet moment', async () => {
    put(session('oaaaaaaa'))
    put(session('oaaaaaaa', { goal: 'second' }))
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(save).toHaveBeenCalledTimes(1)
    const [id, manifest] = save.mock.calls[0]
    expect(id).toBe('oaaaaaaa')
    expect(manifest).toMatchObject({ id: 'oaaaaaaa', goal: 'second', savedAt: 42, version: 1 })
  })

  it('skips sessions whose manifest did not change', async () => {
    put(session('oaaaaaaa'))
    await settle()
    // Same content in a new object: nothing to write.
    put(session('oaaaaaaa'))
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
    put(session('oaaaaaaa', { goal: 'other' }))
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('removes the manifest of a session that stops or leaves', async () => {
    put(session('oaaaaaaa'))
    put(session('obbbbbbb'))
    await settle()
    put(session('oaaaaaaa', { stoppedAt: 99 }))
    drop('obbbbbbb')
    await settle()
    expect(remove.mock.calls.map(([id]) => id).sort()).toEqual(['oaaaaaaa', 'obbbbbbb'])
    // A stopped session is over: it is not written again.
    put(session('oaaaaaaa', { stoppedAt: 99, goal: 'changed' }))
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('never touches manifests it did not write (orchestrations interrupted earlier)', async () => {
    put(session('oaaaaaaa'))
    await settle()
    drop('oaaaaaaa')
    await settle()
    expect(remove.mock.calls).toEqual([['oaaaaaaa']])
  })

  it('flushes at once when the app closes', async () => {
    put(session('oaaaaaaa'))
    await flushManifests()
    expect(save).toHaveBeenCalledTimes(1)
    // Nothing is left to write when the debounce would have fired.
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('tells the close dialog how many run and how many could not be saved', async () => {
    expect(closingOrchestrations()).toEqual({ count: 0, lost: 0 })
    put(session('oaaaaaaa'))
    put(session('obbbbbbb', { stoppedAt: 5 }))
    save.mockImplementation(() => Promise.reject(new Error('disk full')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await settle()
    expect(closingOrchestrations()).toEqual({ count: 1, lost: 1 })
    // A manifest that could not be written is tried again on the next pass.
    save.mockImplementation(() => Promise.resolve())
    await flushManifests()
    expect(closingOrchestrations()).toEqual({ count: 1, lost: 0 })
    warn.mockRestore()
  })

  it('keeps the saved mark per session: one success never hides another’s failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // oaaaaaaa's manifest is too big for the backend; obbbbbbb's is fine.
    save.mockImplementation((id: string) =>
      id === 'oaaaaaaa'
        ? Promise.reject(new Error('manifest is larger than 4096 KB'))
        : Promise.resolve(),
    )
    put(session('oaaaaaaa'))
    put(session('obbbbbbb'))
    await settle()
    expect(closingOrchestrations()).toEqual({ count: 2, lost: 1 })
    // A later success of another session does not make the first one resumable.
    put(session('obbbbbbb', { goal: 'changed' }))
    await settle()
    expect(closingOrchestrations()).toEqual({ count: 2, lost: 1 })
    // The lost one ends: nothing left to lose.
    drop('oaaaaaaa')
    await settle()
    expect(closingOrchestrations()).toEqual({ count: 1, lost: 0 })
    warn.mockRestore()
  })

  it('stops following the store once disposed', async () => {
    dispose()
    put(session('oaaaaaaa'))
    await vi.advanceTimersByTimeAsync(DELAY * 2)
    expect(save).not.toHaveBeenCalled()
    expect(closingOrchestrations()).toEqual({ count: 0, lost: 0 })
  })
})
