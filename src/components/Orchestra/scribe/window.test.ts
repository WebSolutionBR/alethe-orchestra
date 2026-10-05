import { afterEach, describe, expect, it, vi } from 'vitest'

// Never talks to a real vault.
vi.mock('./api', () => ({
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
  scribeMaterialAppend: vi.fn(() => Promise.resolve()),
  scribeMaterialRead: vi.fn(() => Promise.resolve('')),
  scribeMaterialRemove: vi.fn(() => Promise.resolve()),
}))

type Internals = { __TAURI_INTERNALS__?: { metadata: { currentWindow: { label: string } } } }

function storeSpy() {
  return {
    getState: () => ({ sessions: {} }),
    subscribe: vi.fn(() => () => {}),
    listen: vi.fn(() => () => {}),
  }
}

describe('the scribe lives in the main window only', () => {
  afterEach(() => {
    delete (window as Internals).__TAURI_INTERNALS__
    vi.resetModules()
  })

  it('does not install a second scribe in the monitor window', async () => {
    ;(window as Internals).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'dashboard' } },
    }
    const { installScribe } = await import('./service')
    const store = storeSpy()
    installScribe(store)
    expect(store.subscribe).not.toHaveBeenCalled()
    expect(store.listen).not.toHaveBeenCalled()
  })

  it('installs once in the main window', async () => {
    ;(window as Internals).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } } }
    const { installScribe } = await import('./service')
    const first = storeSpy()
    const uninstall = installScribe(first)
    expect(first.subscribe).toHaveBeenCalledTimes(1)
    const second = storeSpy()
    installScribe(second)
    expect(second.subscribe).not.toHaveBeenCalled()
    uninstall()
  })
})
