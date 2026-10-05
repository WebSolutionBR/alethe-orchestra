import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closing: vi.fn(() => ({ count: 0, lost: 0 })),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: vi.fn(() => Promise.resolve()),
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
  }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(false)) }))
vi.mock('../lib/tauri', () => ({
  quitApp: vi.fn(() => Promise.resolve()),
  recordFrontendError: vi.fn(() => Promise.resolve()),
}))
vi.mock('../components/Orchestra/scribe/service', () => ({
  flushScribe: vi.fn(() => Promise.resolve()),
}))
vi.mock('../components/Orchestra/resume/persist', () => ({
  closingOrchestrations: mocks.closing,
  flushManifests: vi.fn(() => Promise.resolve()),
}))

import { translate } from '../lib/i18n'
import { closeMessage } from './useCloseConfirmation'

describe('close dialog', () => {
  it('keeps the usual message when no orchestration runs', () => {
    mocks.closing.mockReturnValue({ count: 0, lost: 0 })
    expect(closeMessage('en')).toBe(translate('en', 'appClose.message'))
  })

  it('says running orchestrations can be resumed when their manifests are saved', () => {
    mocks.closing.mockReturnValue({ count: 1, lost: 0 })
    expect(closeMessage('en')).toBe(
      `${translate('en', 'appClose.message')}\n\nOne running orchestration will be interrupted; you can resume it the next time you open Alethe.`,
    )
    mocks.closing.mockReturnValue({ count: 3, lost: 0 })
    expect(closeMessage('pt-BR')).toContain(
      '3 orquestrações em andamento serão interrompidas; você poderá retomá-las quando abrir o Alethe novamente.',
    )
  })

  it('says they are lost when they cannot be resumed', () => {
    mocks.closing.mockReturnValue({ count: 2, lost: 2 })
    const pt = closeMessage('pt-BR')
    expect(pt).toContain(
      '2 orquestrações em andamento não puderam ser salvas: serão encerradas e não poderão ser retomadas.',
    )
    expect(pt).not.toContain('poderá retomá')
    mocks.closing.mockReturnValue({ count: 1, lost: 1 })
    expect(closeMessage('en')).toContain(
      'One running orchestration could not be saved: it will be ended and cannot be resumed.',
    )
  })

  it('tells each one apart when only some can be resumed', () => {
    mocks.closing.mockReturnValue({ count: 3, lost: 1 })
    const message = closeMessage('pt-BR')
    expect(message).toContain('2 orquestrações em andamento serão interrompidas')
    expect(message).toContain('1 orquestração em andamento não pôde ser salva')
  })
})
