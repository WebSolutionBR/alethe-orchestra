import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Project, Terminal } from '../../../lib/types'
import {
  clearChosenFolder,
  projectCwdKey,
  readChosenFolder,
  resolveStartFolder,
  startBlocker,
  writeChosenFolder,
} from './folder'

function terminal(cwd: string, lastUsedAt: number): Terminal {
  return {
    id: `t-${cwd}`,
    name: 't',
    cwd,
    tabs: [],
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt,
  } as unknown as Terminal
}

function project(
  id: string,
  extra: Partial<Pick<Project, 'defaultCwd' | 'groupId' | 'terminals'>> = {},
): Project {
  return {
    id,
    name: id.toUpperCase(),
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 0,
    ...extra,
  } as Project
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('resolveStartFolder', () => {
  it('uses the project folder when nothing was picked', () => {
    const p = project('a', { defaultCwd: ' C:/repo/a ' })
    expect(resolveStartFolder(p, [p])).toEqual({
      path: 'C:/repo/a',
      source: 'project',
      inheritedFrom: null,
      projectPath: 'C:/repo/a',
    })
  })

  it('lets a picked folder win over the project folder', () => {
    const p = project('a', { defaultCwd: 'C:/repo/a' })
    writeChosenFolder('a', 'D:/elsewhere')
    expect(resolveStartFolder(p, [p])).toEqual({
      path: 'D:/elsewhere',
      source: 'chosen',
      inheritedFrom: null,
      projectPath: 'C:/repo/a',
    })
  })

  it('falls back to the project’s own last terminal folder', () => {
    const p = project('a', { terminals: [terminal('C:/old', 1), terminal('C:/recent', 5)] })
    expect(resolveStartFolder(p, [p])?.path).toBe('C:/recent')
    expect(resolveStartFolder(p, [p])?.source).toBe('project')
  })

  it('names the group sibling a folderless project borrows from', () => {
    const lender = project('lender', { groupId: 'g', terminals: [terminal('C:/lender', 3)] })
    const p = project('a', { groupId: 'g' })
    const other = project('other', { groupId: 'x', terminals: [terminal('C:/other', 9)] })
    expect(resolveStartFolder(p, [p, other, lender])).toEqual({
      path: 'C:/lender',
      source: 'inherited',
      inheritedFrom: 'LENDER',
      projectPath: null,
    })
  })

  it('returns null without any folder', () => {
    const p = project('a')
    expect(resolveStartFolder(p, [p, project('b')])).toBeNull()
  })

  it('forgets a picked folder', () => {
    const p = project('a', { defaultCwd: 'C:/repo/a' })
    writeChosenFolder('a', 'D:/elsewhere')
    clearChosenFolder('a')
    expect(localStorage.getItem(projectCwdKey('a'))).toBeNull()
    expect(resolveStartFolder(p, [p])?.source).toBe('project')
  })

  it('reads nothing from storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readChosenFolder('a')).toBeNull()
  })
})

describe('startBlocker', () => {
  it('explains why the orchestration cannot start yet', () => {
    expect(startBlocker({ projectCount: 0, hasProject: false, hasFolder: false })).toBe(
      'noProjects',
    )
    expect(startBlocker({ projectCount: 2, hasProject: false, hasFolder: false })).toBe('noProject')
    expect(startBlocker({ projectCount: 2, hasProject: true, hasFolder: false })).toBe('noFolder')
    expect(startBlocker({ projectCount: 2, hasProject: true, hasFolder: true })).toBeNull()
  })
})
