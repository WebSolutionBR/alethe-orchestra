import { afterEach, describe, expect, it, vi } from 'vitest'

import { tabbables, trapTab } from './focusTrap'

function dialog(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <button id="close">x</button>
    <button id="radio-off" tabindex="-1">off</button>
    <button id="disabled" disabled>no</button>
    <div hidden><button id="hidden">hidden</button></div>
    <textarea id="text"></textarea>
    <button id="send">send</button>`
  document.body.append(root)
  return root
}

const tab = (shiftKey = false) => ({ key: 'Tab', shiftKey, preventDefault: vi.fn() })

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focus trap', () => {
  it('lists only what Tab can reach', () => {
    expect(tabbables(dialog()).map((el) => el.id)).toEqual(['close', 'text', 'send'])
  })

  it('wraps Tab from the last control to the first', () => {
    const root = dialog()
    root.querySelector<HTMLElement>('#send')!.focus()
    const event = tab()
    trapTab(root, event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('close')
  })

  it('wraps Shift+Tab from the first control to the last', () => {
    const root = dialog()
    root.querySelector<HTMLElement>('#close')!.focus()
    const event = tab(true)
    trapTab(root, event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('send')
  })

  it('lets Tab move normally between the controls in the middle', () => {
    const root = dialog()
    root.querySelector<HTMLElement>('#text')!.focus()
    const event = tab()
    trapTab(root, event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('text')
  })

  it('pulls a focus that escaped back inside', () => {
    const root = dialog()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    trapTab(root, tab())
    expect(document.activeElement?.id).toBe('close')
  })

  it('ignores every other key', () => {
    const root = dialog()
    const event = { key: 'Enter', shiftKey: false, preventDefault: vi.fn() }
    trapTab(root, event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
