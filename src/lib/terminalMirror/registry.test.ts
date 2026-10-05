import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  disposeMirror,
  ensureMirror,
  feedMirror,
  getMirror,
  onMirrorRegistry,
  seedMirror,
  serializeMirror,
  whenMirrorReady,
} from './index'

type Kind = 'data' | 'activity' | 'exit'

const pty = vi.hoisted(() => {
  // xterm.js probes a canvas when it loads; jsdom has none and would log "not implemented".
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  const handlers = {
    data: new Map<string, (chunk: string) => void>(),
    activity: new Map<string, (chunk: string) => void>(),
    exit: new Map<string, (payload: { code: number | null; reason: string }) => void>(),
  }
  return {
    handlers,
    unlistened: [] as string[],
    /** When set, listen() resolves only after this promise does. */
    gate: null as Promise<void> | null,
    failActivity: false,
    attach: vi.fn(async (_id: string) => ''),
  }
})

vi.mock('../tauri/pty', () => {
  const listen =
    (kind: Kind) =>
    async (id: string, handler: (payload: never) => void): Promise<() => void> => {
      if (pty.gate) await pty.gate
      if (kind === 'activity' && pty.failActivity) throw new Error('listen failed')
      ;(pty.handlers[kind] as Map<string, unknown>).set(id, handler)
      return () => {
        pty.unlistened.push(`${kind}:${id}`)
        pty.handlers[kind].delete(id)
      }
    }
  return {
    listenPtyData: listen('data'),
    listenPtyActivity: listen('activity'),
    listenPtyExit: listen('exit'),
    attachPty: (id: string) => pty.attach(id),
  }
})

const created = new Set<string>()

function mirrorFor(id: string, cols = 30, rows = 5) {
  created.add(id)
  return ensureMirror(id, { cols, rows })
}

beforeEach(() => {
  pty.gate = null
  pty.failActivity = false
  pty.unlistened.length = 0
  pty.attach.mockReset()
  pty.attach.mockImplementation(async () => '')
})

afterEach(() => {
  for (const id of created) disposeMirror(id)
  created.clear()
})

describe('mirror registry', () => {
  it('creates one mirror per PTY and announces it', () => {
    const seen: string[] = []
    const stop = onMirrorRegistry((id) => seen.push(id))
    const first = mirrorFor('p1', 40, 12)
    const again = mirrorFor('p1', 90, 30)
    expect(again).toBe(first)
    expect(getMirror('p1')).toBe(first)
    expect([first.cols, first.rows]).toEqual([40, 12])
    expect(seen).toEqual(['p1'])
    stop()
    mirrorFor('p2')
    expect(seen).toEqual(['p1'])
  })

  it('is ready once every PTY listener is registered', async () => {
    let release: () => void = () => {}
    pty.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mirrorFor('p1')
    let ready = false
    void whenMirrorReady('p1').then(() => {
      ready = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(ready).toBe(false)
    release()
    await whenMirrorReady('p1')
    expect(ready).toBe(true)
    expect(pty.handlers.data.has('p1')).toBe(true)
    expect(pty.handlers.activity.has('p1')).toBe(true)
    expect(pty.handlers.exit.has('p1')).toBe(true)
    await expect(whenMirrorReady('missing')).resolves.toBeUndefined()
  })

  it('stays usable when a listener fails to register', async () => {
    pty.failActivity = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mirrorFor('p1')
    await expect(whenMirrorReady('p1')).resolves.toBeUndefined()
    pty.handlers.data.get('p1')!('still fed')
    expect(getMirror('p1')!.getText(0, 1)).toBe('still fed')
  })

  it('writes data and activity chunks in stream order and flags the exit', async () => {
    const mirror = mirrorFor('p1')
    await whenMirrorReady('p1')
    pty.handlers.data.get('p1')!('visible ')
    pty.handlers.activity.get('p1')!('hidden ')
    pty.handlers.data.get('p1')!('visible again')
    expect(mirror.getText(0, 1)).toBe('visible hidden visible again')
    pty.handlers.exit.get('p1')!({ code: 0, reason: 'exited' })
    expect(mirror.exited).toBe(true)
  })

  it('disposes everything and keeps nothing', async () => {
    const seen: string[] = []
    const mirror = mirrorFor('p1')
    await whenMirrorReady('p1')
    const dataHandler = pty.handlers.data.get('p1')!
    dataHandler('text')
    const stop = onMirrorRegistry((id) => seen.push(id))
    disposeMirror('p1')
    stop()
    expect(seen).toEqual(['p1'])
    expect(getMirror('p1')).toBeNull()
    expect(serializeMirror('p1')).toBeNull()
    expect(pty.unlistened.sort()).toEqual(['activity:p1', 'data:p1', 'exit:p1'])
    dataHandler('late')
    expect(mirror.length).toBeGreaterThanOrEqual(0)
    disposeMirror('p1')
    // A new mirror for the same id starts empty.
    expect(mirrorFor('p1').getText(0, 1)).toBe('')
  })

  it('releases listeners that register after the mirror was disposed', async () => {
    let release: () => void = () => {}
    pty.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mirrorFor('p1')
    disposeMirror('p1')
    release()
    await whenMirrorReady('p1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pty.unlistened.sort()).toEqual(['activity:p1', 'data:p1', 'exit:p1'])
  })

  it('serializes through the registry and feeds text directly', () => {
    mirrorFor('p1')
    expect(serializeMirror('p1')).toBeNull()
    feedMirror('p1', 'hello')
    expect(serializeMirror('p1')).toContain('hello')
    feedMirror('missing', 'ignored')
    expect(serializeMirror('missing')).toBeNull()
  })

  it('seeds an empty mirror from the recorded output once', async () => {
    pty.attach.mockImplementation(async () => 'old\x1b[2J\x1b[Hrecorded')
    const mirror = mirrorFor('p1')
    await seedMirror('p1')
    await seedMirror('p1')
    expect(pty.attach).toHaveBeenCalledTimes(1)
    expect(mirror.getText(0, 1)).toBe('recorded')
    await seedMirror('missing')
    expect(pty.attach).toHaveBeenCalledTimes(1)
  })
})
