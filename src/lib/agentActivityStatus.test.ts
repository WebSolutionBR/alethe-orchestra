import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SETTLE_MS, createActivitySettler, MIN_TURN_MS } from './agentActivityStatus'

// The span is measured with Date.now(), so the clock has to move with the timers.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
afterEach(() => vi.useRealTimers())

type Change = { status: 'working' | 'waiting'; workedMs: number }

function record() {
  const changes: Change[] = []
  const settler = createActivitySettler((status, workedMs) => changes.push({ status, workedMs }))
  return { changes, settler }
}

describe('createActivitySettler', () => {
  it('reports working on the first pulse', () => {
    const { changes, settler } = record()
    settler.pulse()
    expect(changes.map((c) => c.status)).toEqual(['working'])
  })

  it('does not repeat working while output keeps coming', () => {
    const { changes, settler } = record()
    settler.pulse()
    vi.advanceTimersByTime(500)
    settler.pulse()
    vi.advanceTimersByTime(500)
    settler.pulse()
    expect(changes.map((c) => c.status)).toEqual(['working'])
  })

  it('settles to waiting after the silence window', () => {
    const { changes, settler } = record()
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS - 1)
    expect(changes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(changes.map((c) => c.status)).toEqual(['working', 'waiting'])
  })

  it('keeps working across pauses shorter than the window', () => {
    const { changes, settler } = record()
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS - 100)
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS - 100)
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS - 100)
    expect(changes.map((c) => c.status)).toEqual(['working'])
  })

  it('goes back to working when output resumes after settling', () => {
    const { changes, settler } = record()
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS)
    settler.pulse()
    expect(changes.map((c) => c.status)).toEqual(['working', 'waiting', 'working'])
  })

  it('measures the output span, not the silence that ended it', () => {
    const { changes, settler } = record()
    // Output has to keep arriving inside the window, or the turn ends early.
    settler.pulse()
    for (let elapsed = 0; elapsed < 5_000; elapsed += 1_000) {
      vi.advanceTimersByTime(1_000)
      settler.pulse()
    }
    vi.advanceTimersByTime(AGENT_SETTLE_MS)
    expect(changes[1]).toEqual({ status: 'waiting', workedMs: 5_000 })
  })

  it('reports a near-zero span for a single burst, which is what booting looks like', () => {
    // Reattaching a pane makes the agent redraw its interface: one burst, then
    // silence. Reporting that as a finished turn badged every agent on startup.
    const { changes, settler } = record()
    settler.pulse()
    vi.advanceTimersByTime(120)
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS)
    expect(changes[1].workedMs).toBe(120)
    expect(changes[1].workedMs).toBeLessThan(MIN_TURN_MS)
  })

  it('restarts the span on each new turn', () => {
    const { changes, settler } = record()
    settler.pulse()
    for (let elapsed = 0; elapsed < 4_000; elapsed += 1_000) {
      vi.advanceTimersByTime(1_000)
      settler.pulse()
    }
    vi.advanceTimersByTime(AGENT_SETTLE_MS)
    expect(changes[1].workedMs).toBe(4_000)

    settler.pulse()
    vi.advanceTimersByTime(300)
    settler.pulse()
    vi.advanceTimersByTime(AGENT_SETTLE_MS)
    expect(changes[3].workedMs).toBe(300)
  })

  it('stops reporting once disposed', () => {
    const { changes, settler } = record()
    settler.pulse()
    settler.dispose()
    vi.advanceTimersByTime(AGENT_SETTLE_MS * 3)
    settler.pulse()
    expect(changes).toHaveLength(1)
  })

  it('keeps the turn threshold above a redraw and below a real answer', () => {
    expect(MIN_TURN_MS).toBeGreaterThan(1_000)
    expect(MIN_TURN_MS).toBeLessThan(10_000)
  })
})
