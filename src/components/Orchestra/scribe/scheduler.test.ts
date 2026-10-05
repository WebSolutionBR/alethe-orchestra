import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AuthorRequest, AuthorScheduler } from './scheduler'

type Deferred = { request: AuthorRequest; resolve: (ok: boolean) => void }

function setup(debounceMs = 60_000, maxWaitMs = 300_000) {
  const runs: Deferred[] = []
  const states: string[] = []
  const scheduler = new AuthorScheduler({
    run: (request) => new Promise<boolean>((resolve) => runs.push({ request, resolve })),
    debounceMs: () => debounceMs,
    maxWaitMs,
    onChange: (id, state) => states.push(`${id}:${state.phase}`),
  })
  return { scheduler, runs, states }
}

describe('AuthorScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for a quiet period and merges a burst of completions into one run', async () => {
    const { scheduler, runs } = setup()
    scheduler.request('s1', 'worker-done', { finished: ['claude-1'] })
    await vi.advanceTimersByTimeAsync(30_000)
    scheduler.request('s1', 'worker-done', { finished: ['claude-2'] })
    expect(scheduler.state('s1').phase).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toHaveLength(1)
    expect(runs[0].request).toEqual({
      sessionId: 's1',
      triggers: ['worker-done'],
      finished: ['claude-1', 'claude-2'],
      final: false,
    })
    expect(scheduler.state('s1').phase).toBe('running')
    runs[0].resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.state('s1').phase).toBe('idle')
  })

  it('never waits longer than the max while requests keep coming', async () => {
    const { scheduler, runs } = setup(60_000, 100_000)
    scheduler.request('s1', 'worker-done')
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(40_000)
      scheduler.request('s1', 'worker-done')
    }
    // 120 s of requests, but the first one was 100 s ago at most.
    expect(runs).toHaveLength(1)
  })

  it('runs the final pass and manual requests right away', async () => {
    const { scheduler, runs } = setup()
    scheduler.request('s1', 'worker-done')
    scheduler.request('s1', 'session-end', { final: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toHaveLength(1)
    expect(runs[0].request).toMatchObject({ final: true, triggers: ['worker-done', 'session-end'] })
  })

  it('runs one author at a time across sessions, in order', async () => {
    const { scheduler, runs } = setup()
    scheduler.request('s1', 'manual')
    scheduler.request('s2', 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((r) => r.request.sessionId)).toEqual(['s1'])
    expect(scheduler.state('s2').phase).toBe('queued')
    expect(scheduler.running()).toBe('s1')
    runs[0].resolve(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((r) => r.request.sessionId)).toEqual(['s1', 's2'])
  })

  it('makes one more run for what arrived during a run, never two at once', async () => {
    const { scheduler, runs } = setup(10_000)
    scheduler.request('s1', 'manual')
    await vi.advanceTimersByTimeAsync(0)
    scheduler.request('s1', 'worker-done', { finished: ['claude-3'] })
    scheduler.request('s1', 'worker-done', { finished: ['claude-4'] })
    expect(runs).toHaveLength(1)
    runs[0].resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.state('s1').phase).toBe('scheduled')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runs).toHaveLength(2)
    expect(runs[1].request.finished).toEqual(['claude-3', 'claude-4'])
  })

  it('survives a run that throws, cancels and lists what is outstanding', async () => {
    const scheduler = new AuthorScheduler({
      run: () => {
        throw new Error('boom')
      },
      debounceMs: () => 1_000,
    })
    scheduler.request('s1', 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.state('s1').phase).toBe('idle')
    scheduler.request('s2', 'worker-done', { finished: ['claude-1'] })
    expect(scheduler.outstanding()).toEqual([
      { sessionId: 's2', triggers: ['worker-done'], finished: ['claude-1'], final: false },
    ])
    scheduler.cancel('s2')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scheduler.state('s2').phase).toBe('idle')
    scheduler.dispose()
    scheduler.request('s3', 'manual')
    expect(scheduler.state('s3').phase).toBe('idle')
  })
})
