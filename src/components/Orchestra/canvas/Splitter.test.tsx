import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/i18n', () => ({ useT: () => (key: string) => key }))

import { Splitter } from './Splitter'
import { usePanelSize } from './usePanelSize'

const POINTER_CAPTURE = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture']
const resizeCallbacks: Array<() => void> = []

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** A bottom bus: the handle leads the panel and the canvas sits before it. */
function Bus({ height }: { height: number }) {
  const panel = usePanelSize('test.bus', 200, 80, 520)
  return (
    <div data-h={height}>
      <div />
      <section>
        <Splitter panel={panel} axis="y" />
        <div style={{ height: panel.size }} />
      </section>
    </div>
  )
}

/** Lanes placed right before the handle, as in the Timeline. */
function Lanes() {
  const panel = usePanelSize('test.lanes', 200, 80, 520)
  return (
    <div>
      <section style={{ maxHeight: panel.size }} />
      <Splitter panel={panel} axis="y" />
      <div />
    </div>
  )
}

const pointer = (type: string, clientY: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY })

function dragBy(handle: HTMLElement, from: number, to: number) {
  fireEvent(handle, pointer('pointerdown', from))
  fireEvent(handle, pointer('pointermove', to))
  fireEvent(handle, pointer('pointerup', to))
}

const valueOf = (handle: HTMLElement) => Number(handle.getAttribute('aria-valuenow'))

describe('Splitter', () => {
  beforeEach(() => {
    localStorage.clear()
    resizeCallbacks.length = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    // jsdom has no layout: a container reports the height written in its data-h attribute.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.dataset.h ?? 0)
      },
    })
    for (const key of POINTER_CAPTURE) {
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        value: () => false,
      })
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of ['clientHeight', ...POINTER_CAPTURE]) {
      Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  })

  it('lets a bottom panel take the container minus the canvas minimum', () => {
    render(<Bus height={900} />)
    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-valuemax', '740')

    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(valueOf(handle)).toBe(216)
    fireEvent.keyDown(handle, { key: 'ArrowDown', shiftKey: true })
    expect(valueOf(handle)).toBe(152)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(valueOf(handle)).toBe(740)
    expect(localStorage.getItem('test.bus')).toBe('740')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(valueOf(handle)).toBe(80)
  })

  it('grows a bottom panel when the handle is dragged up', () => {
    render(<Bus height={900} />)
    const handle = screen.getByRole('separator')
    dragBy(handle, 500, 450)
    expect(valueOf(handle)).toBe(250)
    expect(localStorage.getItem('test.bus')).toBe('250')
  })

  it('re-clamps when the container shrinks and grows back with it', () => {
    const { rerender } = render(<Bus height={900} />)
    const handle = screen.getByRole('separator')
    fireEvent.keyDown(handle, { key: 'End' })

    rerender(<Bus height={500} />)
    act(() => resizeCallbacks.forEach((callback) => callback()))
    expect(handle).toHaveAttribute('aria-valuemax', '340')
    expect(valueOf(handle)).toBe(340)

    rerender(<Bus height={900} />)
    act(() => resizeCallbacks.forEach((callback) => callback()))
    expect(valueOf(handle)).toBe(740)
  })

  it('keeps the remembered size on a click without movement', () => {
    localStorage.setItem('test.bus', '700')
    render(<Bus height={600} />)
    const handle = screen.getByRole('separator')
    expect(valueOf(handle)).toBe(440)

    dragBy(handle, 300, 300)
    expect(localStorage.getItem('test.bus')).toBe('700')

    fireEvent.doubleClick(handle)
    expect(valueOf(handle)).toBe(200)
    expect(localStorage.getItem('test.bus')).toBe('200')
  })

  it('resizes a panel placed before the handle in the direction the handle moves', () => {
    render(<Lanes />)
    const handle = screen.getByRole('separator')

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(valueOf(handle)).toBe(216)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(valueOf(handle)).toBe(184)

    dragBy(handle, 300, 350)
    expect(valueOf(handle)).toBe(234)
  })
})
