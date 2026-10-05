import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useEffect } from 'react'

import { closingOrchestrations, flushManifests } from '../components/Orchestra/resume/persist'
import { flushScribe } from '../components/Orchestra/scribe/service'
import { type CloseFailureStage,createCloseCoordinator } from '../lib/closeCoordinator'
import { getLocale, type Locale, translate } from '../lib/i18n'
import { quitApp, recordFrontendError } from '../lib/tauri'
import { flushProjectsState } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

function errorDetails(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null }
  }
  return { message: String(error), stack: null }
}

function reportCloseFailure(stage: CloseFailureStage, error: unknown): void {
  const details = errorDetails(error)
  void recordFrontendError(
    `App close failed during ${stage}: ${details.message}`,
    details.stack,
    'app-close',
  )

  if (stage !== 'quit') return
  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'appClose.failedTitle'),
    body: translate(locale, 'appClose.failedBody'),
  })
}

/**
 * The close warning. Running orchestrations are named too, with the truth about each: a saved
 * manifest lets it be resumed on the next start; one whose manifest could not be saved is
 * simply ended.
 */
export function closeMessage(locale: Locale): string {
  const message = translate(locale, 'appClose.message')
  const { count, lost } = closingOrchestrations()
  const resumable = count - lost
  const lines = [message]
  if (resumable > 0) {
    const key =
      resumable === 1 ? 'appClose.orchestrasResumableOne' : 'appClose.orchestrasResumableMany'
    lines.push(translate(locale, key, { count: resumable }))
  }
  if (lost > 0) {
    const key = lost === 1 ? 'appClose.orchestrasLostOne' : 'appClose.orchestrasLostMany'
    lines.push(translate(locale, key, { count: lost }))
  }
  return lines.join('\n\n')
}

/** What has to reach the disk before the window goes. */
async function beforeAppClose(): Promise<void> {
  // The scribe's flush is bounded and never rejects (material saved, final passes kept owed).
  await Promise.all([flushProjectsState(), flushManifests(), flushScribe()])
}

const appWindow = getCurrentWindow()
const closeCoordinator = createCloseCoordinator({
  confirmNative: () => {
    const locale = getLocale()
    return confirm(closeMessage(locale), {
      title: translate(locale, 'appClose.title'),
      kind: 'warning',
      okLabel: translate(locale, 'appClose.confirm'),
      cancelLabel: translate(locale, 'appClose.cancel'),
    })
  },
  confirmFallback: () => window.confirm(closeMessage(getLocale())),
  beforeClose: beforeAppClose,
  destroyWindow: () => appWindow.destroy(),
  quitApp: () => quitApp(),
  onFailure: reportCloseFailure,
})

export function requestAppClose(): Promise<void> {
  return closeCoordinator.handleCloseRequest({ preventDefault: () => {} })
}

                                                                                    
export function useCloseConfirmation(): void {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void appWindow
      .onCloseRequested((event) => closeCoordinator.handleCloseRequest(event))
      .then((stopListening) => {
        if (cancelled) stopListening()
        else unlisten = stopListening
      })
      .catch((error) => reportCloseFailure('confirm', error))

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
