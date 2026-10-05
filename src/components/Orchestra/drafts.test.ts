import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearSessionDrafts,
  draftKey,
  DRAFTS_KEY,
  useComposerDraft,
  useDrafts,
  useDraftText,
} from './drafts'

describe('Orchestra drafts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.removeItem(DRAFTS_KEY)
    useDrafts.setState({ drafts: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.removeItem(DRAFTS_KEY)
  })

  it('keeps one draft per agent, so a draft never goes to another agent', () => {
    const one = renderHook(() => useDraftText(draftKey.agent('o1', 'claude-1')))
    const two = renderHook(() => useDraftText(draftKey.agent('o1', 'claude-2')))
    act(() => one.result.current[1]('for claude-1 only'))
    expect(one.result.current[0]).toBe('for claude-1 only')
    expect(two.result.current[0]).toBe('')
    // Unmounting the box (switching agent or view) keeps the text.
    one.unmount()
    expect(renderHook(() => useDraftText(draftKey.agent('o1', 'claude-1'))).result.current[0]).toBe(
      'for claude-1 only',
    )
  })

  it('saves after a pause and drops what was sent', () => {
    const quick = renderHook(() => useDraftText(draftKey.quick('o1')))
    act(() => quick.result.current[1]('half typed'))
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toMatchObject({
      'quick:o1': { text: 'half typed' },
    })
    act(() => quick.result.current[1](''))
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toEqual({})
  })

  it('keeps the composer text and attachments, without in-memory previews on disk', () => {
    const composer = renderHook(() => useComposerDraft('o1'))
    act(() =>
      composer.result.current[1]({
        text: 'see the screenshot',
        attachments: [
          {
            id: 'a',
            path: 'C:/tmp/shot.png',
            name: 'shot.png',
            kind: 'image',
            previewUrl: 'blob:x',
          },
        ],
      }),
    )
    expect(composer.result.current[0].attachments).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    const stored = JSON.parse(localStorage.getItem(DRAFTS_KEY)!)
    expect(stored['composer:o1'].attachments[0]).toEqual({
      id: 'a',
      path: 'C:/tmp/shot.png',
      name: 'shot.png',
      kind: 'image',
    })
  })

  it('forgets every draft of a session that ended, and only of that one', () => {
    useDrafts.getState().put(draftKey.agent('o1', 'claude-1'), { text: 'a' })
    useDrafts.getState().put(draftKey.composer('o1'), { text: 'b' })
    useDrafts.getState().put(draftKey.quick('o2'), { text: 'c' })
    clearSessionDrafts('o1')
    expect(Object.keys(useDrafts.getState().drafts)).toEqual(['quick:o2'])
  })
})
