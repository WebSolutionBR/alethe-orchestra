import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores/projectsStore', () => ({
  flushProjectsState: vi.fn(),
  useProjectsStore: { getState: vi.fn(), setState: vi.fn() },
}))
vi.mock('../stores/uiStore', () => ({ useUiStore: { getState: vi.fn() } }))
vi.mock('./i18n', () => ({ getLocale: vi.fn(), translate: vi.fn() }))

import { mergeLegacyProjects } from './legacyImport'
import type { Group, Preferences, Project } from './types'

const project = (id: string, name: string, groupId: string | null = null) =>
  ({ id, name, groupId, terminals: [] }) as unknown as Project
const group = (
  id: string,
  name: string,
  projectIds: string[],
  parentGroupId: string | null = null,
) => ({ id, name, projectIds, parentGroupId, color: '#fff', collapsed: false }) as Group
const prefs = (accounts: { id: string; name: string }[]) =>
  ({ claudeAccounts: accounts }) as unknown as Preferences

describe('mergeLegacyProjects', () => {
  const legacy = {
    projects: [
      project('p1', 'S-FORM'),
      project('p2', 'Mine', 'g1'),
      project('p3', 'IA', 'g1'),
      project('p4', 'Livros'),
    ],
    groups: [group('g1', 'Pessoal', ['p3', 'p2'], 'missing')],
    ungroupedOrder: ['p4', 'p1'],
    preferences: prefs([
      { id: 'a1', name: 'Contabil' },
      { id: 'a2', name: 'Compras' },
    ]),
  }

  it('adds missing projects, groups and accounts without touching existing ones', () => {
    const current = {
      projects: [project('x1', 'ia')],
      groups: [],
      ungroupedOrder: ['x1'],
      preferences: prefs([{ id: 'a2', name: 'Compras renamed' }]),
    }
    const result = mergeLegacyProjects(current, legacy)

    expect(result.projectsAdded).toEqual(['S-FORM', 'Mine', 'Livros'])
    expect(result.skippedProjects).toEqual(['IA'])
    expect(result.patch.projects.map((p) => p.id)).toEqual(['x1', 'p1', 'p2', 'p4'])
    expect(result.patch.ungroupedOrder).toEqual(['x1', 'p4', 'p1'])
    expect(result.patch.groups).toEqual([
      expect.objectContaining({ id: 'g1', projectIds: ['p2'], parentGroupId: null }),
    ])
    expect(result.patch.preferences.claudeAccounts).toEqual([
      { id: 'a2', name: 'Compras renamed' },
      { id: 'a1', name: 'Contabil' },
    ])
  })

  it('is idempotent when re-synced', () => {
    const first = mergeLegacyProjects(
      { projects: [], groups: [], ungroupedOrder: [], preferences: prefs([]) },
      legacy,
    )
    const second = mergeLegacyProjects(first.patch, legacy)
    expect(second.projectsAdded).toEqual([])
    expect(second.groupsAdded).toEqual([])
    expect(second.accountsAdded).toEqual([])
    expect(second.patch.projects).toEqual(first.patch.projects)
    expect(second.patch.groups).toEqual(first.patch.groups)
    expect(second.patch.ungroupedOrder).toEqual(first.patch.ungroupedOrder)
  })

  it('appends to an existing group with the same id', () => {
    const result = mergeLegacyProjects(
      {
        projects: [project('p9', 'Other', 'g1')],
        groups: [group('g1', 'Pessoal', ['p9'])],
        ungroupedOrder: [],
        preferences: prefs([]),
      },
      legacy,
    )
    expect(result.patch.groups[0].projectIds).toEqual(['p9', 'p3', 'p2'])
    expect(result.groupsAdded).toEqual([])
  })
})
