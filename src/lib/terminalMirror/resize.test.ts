import { afterEach, describe, expect, it, vi } from 'vitest'

import { resizePty } from '../tauri/pty'
import { disposeMirror, ensureMirror } from './index'

const backend = vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  return {
    pending: [] as Array<{ args: unknown; resolve: () => void; reject: (error: Error) => void }>,
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => {
    if (command !== 'resize_pty') return Promise.resolve(undefined)
    return new Promise<void>((resolve, reject) => backend.pending.push({ args, resolve, reject }))
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}))

afterEach(() => {
  backend.pending.length = 0
  disposeMirror('r1')
})

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('resizePty keeps the mirror at the PTY size', () => {
  it('resizes the mirror once the backend applied the size', async () => {
    const mirror = ensureMirror('r1', { cols: 80, rows: 24 })
    const resizing = resizePty('r1', 100, 30)
    expect([mirror.cols, mirror.rows]).toEqual([80, 24])
    backend.pending[0].resolve()
    await resizing
    expect([mirror.cols, mirror.rows]).toEqual([100, 30])
  })

  it('ends at the latest requested size when calls settle out of order', async () => {
    const mirror = ensureMirror('r1', { cols: 80, rows: 24 })
    const first = resizePty('r1', 90, 20)
    const second = resizePty('r1', 120, 40)
    backend.pending[1].resolve()
    await second
    backend.pending[0].resolve()
    await first
    await settle()
    expect([mirror.cols, mirror.rows]).toEqual([120, 40])
  })

  it('never lets a late answer pass for a request made after another one settled', async () => {
    const mirror = ensureMirror('r1', { cols: 80, rows: 24 })
    const first = resizePty('r1', 90, 20)
    const second = resizePty('r1', 100, 30)
    backend.pending[1].resolve()
    await second
    // Asked after the second settled, while the first is still in flight.
    const third = resizePty('r1', 120, 40)
    backend.pending[0].resolve()
    await first
    backend.pending[2].resolve()
    await third
    await settle()
    expect([mirror.cols, mirror.rows]).toEqual([120, 40])
  })

  it('leaves the mirror alone when the backend refuses the size', async () => {
    const mirror = ensureMirror('r1', { cols: 80, rows: 24 })
    const resizing = resizePty('r1', 100, 30)
    backend.pending[0].reject(new Error('PTY not found'))
    await expect(resizing).rejects.toThrow('PTY not found')
    expect([mirror.cols, mirror.rows]).toEqual([80, 24])
  })

  it('still resizes PTYs that have no mirror', async () => {
    const resizing = resizePty('no-mirror', 100, 30)
    expect(backend.pending[0].args).toEqual({ id: 'no-mirror', cols: 100, rows: 30 })
    backend.pending[0].resolve()
    await expect(resizing).resolves.toBeUndefined()
  })
})
