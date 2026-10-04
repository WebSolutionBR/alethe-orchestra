import { getLocale, translate } from './i18n'

/**
 * Formats how long is left before a usage window resets.
 *
 * Five-hour windows fit in hours and minutes, but the weekly ones
 * (`seven_day`, `seven_day_opus`) run past 24h and would otherwise read as
 * "163h 12m". The day step applies to any window, so the same formatter serves
 * the topbar, the Home widget and the usage modal.
 */
export function formatResetDiff(diffMs: number): string {
  if (!Number.isFinite(diffMs)) return '—'
  if (diffMs <= 0) return translate(getLocale(), 'widget.resetting')
  const h = Math.floor(diffMs / 3_600_000)
  const m = Math.floor((diffMs % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Takes the `resets_at` ISO string the usage API returns. */
export function formatResetTime(resetsAt: string): string {
  if (!resetsAt) return '—'
  return formatResetDiff(new Date(resetsAt).getTime() - Date.now())
}

/** Takes an epoch in milliseconds, for the sources that already parsed the date. */
export function formatResetMs(resetsAtMs: number): string {
  if (!resetsAtMs) return '—'
  return formatResetDiff(resetsAtMs - Date.now())
}
