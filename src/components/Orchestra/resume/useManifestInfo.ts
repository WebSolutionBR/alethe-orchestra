import { useMemo } from 'react'

import { intlLocale } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import type { OrchestraManifest } from './manifest'

/** How an interrupted orchestration is named: its project, else its folder, else its id. */
export function manifestName(manifest: OrchestraManifest): string {
  const project = manifest.projectId
    ? useProjectsStore.getState().projects.find((p) => p.id === manifest.projectId)
    : undefined
  if (project?.name) return project.name
  const folder = manifest.cwd?.split(/[\\/]/).filter(Boolean).pop()
  return folder || manifest.id
}

/** Formats a saved time in the user's language (day/month and time, or the time alone). */
export function useDateTime(): (at: number, timeOnly?: boolean) => string {
  const locale = useProjectsStore((s) => s.preferences.language)
  return useMemo(() => {
    const intl = intlLocale(locale)
    const full = new Intl.DateTimeFormat(intl, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    const time = new Intl.DateTimeFormat(intl, { hour: '2-digit', minute: '2-digit' })
    return (at, timeOnly = false) => {
      const date = new Date(at)
      if (!at || Number.isNaN(date.getTime())) return '—'
      return (timeOnly ? time : full).format(date)
    }
  }, [locale])
}
