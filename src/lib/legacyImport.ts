import { flushProjectsState, useProjectsStore } from '../stores/projectsStore'
import { migrate } from '../stores/projectsStore.migrations'
import { useUiStore } from '../stores/uiStore'
import { getLocale, translate } from './i18n'
import {
  legacyAletheCopyAccounts,
  legacyAletheMark,
  legacyAletheReadProjects,
  legacyAletheStatus,
} from './tauri/legacyImport'
import type { ClaudeAccount, Group, Project, ProjectsFile } from './types'

/**
 * Import from the original Alethe install (`com.kc1t.alethe`).
 *
 * The original data is only read. Projects, groups and Claude accounts that do
 * not exist here yet are added; anything already present here (same id, or a
 * project with the same name) is left as the user has it. Re-sync runs the
 * same merge again and refreshes account files that are newer in the original.
 */

type MergeTarget = Pick<ProjectsFile, 'groups' | 'ungroupedOrder' | 'projects' | 'preferences'>

export type LegacyMergeResult = {
  patch: MergeTarget
  projectsAdded: string[]
  groupsAdded: string[]
  accountsAdded: string[]
  skippedProjects: string[]
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase()

export function mergeLegacyProjects(current: MergeTarget, legacy: MergeTarget): LegacyMergeResult {
  const ids = new Set(current.projects.map((p) => p.id))
  const names = new Set(current.projects.map((p) => nameKey(p.name)))
  const added: Project[] = []
  const skippedProjects: string[] = []
  for (const project of legacy.projects) {
    if (ids.has(project.id)) continue
    if (names.has(nameKey(project.name))) {
      skippedProjects.push(project.name)
      continue
    }
    ids.add(project.id)
    names.add(nameKey(project.name))
    added.push(project)
  }
  const currentGroupIds = new Set(current.groups.map((g) => g.id))
  const newGroups = legacy.groups.filter((g) => !currentGroupIds.has(g.id))
  const groupIds = new Set([...currentGroupIds, ...newGroups.map((g) => g.id)])

  const projects = added.map((p) =>
    p.groupId && !groupIds.has(p.groupId) ? { ...p, groupId: null } : p,
  )
  const memberIds = (groupId: string, legacyOrder: string[]) => {
    const inGroup = projects.filter((p) => p.groupId === groupId).map((p) => p.id)
    return [
      ...legacyOrder.filter((id) => inGroup.includes(id)),
      ...inGroup.filter((id) => !legacyOrder.includes(id)),
    ]
  }
  const legacyOrderOf = (groupId: string) =>
    legacy.groups.find((g) => g.id === groupId)?.projectIds ?? []

  const groups: Group[] = [
    ...current.groups.map((g) => {
      const extra = memberIds(g.id, legacyOrderOf(g.id))
      return extra.length ? { ...g, projectIds: [...g.projectIds, ...extra] } : g
    }),
    ...newGroups.map((g) => ({
      ...g,
      parentGroupId: g.parentGroupId && groupIds.has(g.parentGroupId) ? g.parentGroupId : null,
      projectIds: memberIds(g.id, g.projectIds),
    })),
  ]

  const ungrouped = projects.filter((p) => !p.groupId).map((p) => p.id)
  const ungroupedOrder = [
    ...current.ungroupedOrder,
    ...legacy.ungroupedOrder.filter((id) => ungrouped.includes(id)),
    ...ungrouped.filter((id) => !legacy.ungroupedOrder.includes(id)),
  ]

  const accounts = current.preferences.claudeAccounts ?? []
  const accountIds = new Set(accounts.map((a) => a.id))
  const newAccounts: ClaudeAccount[] = (legacy.preferences.claudeAccounts ?? []).filter(
    (a) => !accountIds.has(a.id),
  )

  return {
    patch: {
      projects: [...current.projects, ...projects],
      groups,
      ungroupedOrder,
      preferences: newAccounts.length
        ? { ...current.preferences, claudeAccounts: [...accounts, ...newAccounts] }
        : current.preferences,
    },
    projectsAdded: projects.map((p) => p.name),
    groupsAdded: newGroups.map((g) => g.name),
    accountsAdded: newAccounts.map((a) => a.name),
    skippedProjects,
  }
}

export type LegacyImportSummary = {
  projectsAdded: string[]
  groupsAdded: string[]
  accountsAdded: string[]
  skippedProjects: string[]
  accountFilesCopied: number
  errors: string[]
}

/** Shows the outcome of an import as an in-app toast. */
export function toastLegacyImport(summary: LegacyImportSummary | null, resync: boolean): void {
  const locale = getLocale()
  const { pushToast } = useUiStore.getState()
  if (!summary) {
    if (resync)
      pushToast({
        title: translate(locale, 'legacyImport.resync'),
        body: translate(locale, 'legacyImport.nothing'),
      })
    return
  }
  const lines = [
    translate(locale, 'legacyImport.doneBody', {
      projects: summary.projectsAdded.length,
      groups: summary.groupsAdded.length,
      accounts: summary.accountsAdded.length,
      files: summary.accountFilesCopied,
    }),
  ]
  if (summary.skippedProjects.length)
    lines.push(
      translate(locale, 'legacyImport.skipped', { names: summary.skippedProjects.join(', ') }),
    )
  if (summary.errors.length) lines.push(summary.errors.join('; '))
  pushToast({
    title: translate(locale, resync ? 'legacyImport.resyncedTitle' : 'legacyImport.doneTitle'),
    body: lines.join(' '),
  })
}

export function toastLegacyImportError(error: unknown): void {
  useUiStore.getState().pushToast({
    title: translate(getLocale(), 'legacyImport.failedTitle'),
    body: String(error),
  })
}

let running: Promise<LegacyImportSummary | null> | null = null

/**
 * Runs the import. Without `resync` it only runs once per install (first run);
 * returns null when there is nothing to do. The projects store must be hydrated.
 */
export function runLegacyImport(options: { resync?: boolean } = {}) {
  running ??= doImport(Boolean(options.resync)).finally(() => {
    running = null
  })
  return running
}

async function doImport(resync: boolean): Promise<LegacyImportSummary | null> {
  const status = await legacyAletheStatus()
  if (!status.available) return null
  if (!resync && status.marker.imported_at) return null
  if (!useProjectsStore.getState().hydrated) return null

  const summary: LegacyImportSummary = {
    projectsAdded: [],
    groupsAdded: [],
    accountsAdded: [],
    skippedProjects: [],
    accountFilesCopied: 0,
    errors: [],
  }

  let accountIds: string[] = []
  const raw = await legacyAletheReadProjects()
  if (raw) {
    const legacy = migrate(JSON.parse(raw))
    accountIds = (legacy.preferences.claudeAccounts ?? []).map((a) => a.id)
    const result = mergeLegacyProjects(useProjectsStore.getState(), legacy)
    summary.projectsAdded = result.projectsAdded
    summary.groupsAdded = result.groupsAdded
    summary.accountsAdded = result.accountsAdded
    summary.skippedProjects = result.skippedProjects
    useProjectsStore.setState(result.patch)
    await flushProjectsState()
  }

  if (accountIds.length) {
    const copies = await legacyAletheCopyAccounts(accountIds, resync)
    for (const copy of copies) {
      summary.accountFilesCopied += copy.files_copied
      if (copy.error) summary.errors.push(`${copy.id}: ${copy.error}`)
    }
  }

  await legacyAletheMark(!resync)
  return summary
}
