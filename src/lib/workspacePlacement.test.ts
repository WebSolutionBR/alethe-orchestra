import { describe, expect, it } from 'vitest'

import { resolveTerminalPlacement } from './workspacePlacement'

describe('resolveTerminalPlacement', () => {
  it('adds the pane to the container when the project is already in the active tab', () => {
    expect(
      resolveTerminalPlacement({
        projectHasContainer: true,
        hasActiveTab: true,
        workspaceFlat: false,
      }),
    ).toBe('existingContainer')
  })

  it('opens its own tab when the project is not in the active tab', () => {
    // The bug: creating a new project or group pushed its container into the
    // current tab, leaving the old session and the new one side by side.
    expect(
      resolveTerminalPlacement({
        projectHasContainer: false,
        hasActiveTab: true,
        workspaceFlat: false,
      }),
    ).toBe('ownTab')
  })

  it('keeps appending in flat mode, where mixing projects is the point', () => {
    expect(
      resolveTerminalPlacement({
        projectHasContainer: false,
        hasActiveTab: true,
        workspaceFlat: true,
      }),
    ).toBe('appendToActiveTab')
  })

  it('still feeds the existing container in flat mode', () => {
    expect(
      resolveTerminalPlacement({
        projectHasContainer: true,
        hasActiveTab: true,
        workspaceFlat: true,
      }),
    ).toBe('existingContainer')
  })

  it('opens its own tab when there is no active tab, flat mode included', () => {
    expect(
      resolveTerminalPlacement({
        projectHasContainer: false,
        hasActiveTab: false,
        workspaceFlat: false,
      }),
    ).toBe('ownTab')
    expect(
      resolveTerminalPlacement({
        projectHasContainer: false,
        hasActiveTab: false,
        workspaceFlat: true,
      }),
    ).toBe('ownTab')
  })
})
