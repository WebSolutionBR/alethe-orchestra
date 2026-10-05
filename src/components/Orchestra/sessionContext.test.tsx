import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../lib/tauri', () => ({
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() =>
    Promise.resolve({
      endpoint: 'http://127.0.0.1:1',
      token: 't',
      settings_path: 's.json',
      cli_path: 'orch.cmd',
      path_env: '',
    }),
  ),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

import { useOrchestraStore } from '../../stores/orchestraStore'
import {
  OrchestraSessionProvider,
  useSession,
  useSessionActions,
  useSessionId,
} from './sessionContext'

const inSession =
  (sessionId: string) =>
  ({ children }: { children: ReactNode }) => (
    <OrchestraSessionProvider sessionId={sessionId}>{children}</OrchestraSessionProvider>
  )

describe('orchestra session context', () => {
  afterEach(async () => {
    await useOrchestraStore.getState().stopAll()
  })

  it('reads its own session and falls back to an empty one when it stops', async () => {
    const id = (await useOrchestraStore.getState().start('C:/repo', 'ship it', true))!
    const { result } = renderHook(
      () => ({
        id: useSessionId(),
        goal: useSession((s) => s.goal),
        agents: useSession((s) => s.agents),
      }),
      { wrapper: inSession(id) },
    )
    expect(result.current.goal).toBe('ship it')
    expect(result.current.agents.map((a) => a.id)).toEqual(['orchestrator'])

    await act(() => useOrchestraStore.getState().stop(id))
    expect(result.current).toMatchObject({ id, goal: '', agents: [] })
  })

  it('binds stable actions to its session only', async () => {
    const a = (await useOrchestraStore.getState().start('C:/a', '', true))!
    const b = (await useOrchestraStore.getState().start('C:/b', '', true))!
    const { result, rerender } = renderHook(() => useSessionActions(), { wrapper: inSession(a) })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    act(() => result.current.select('orchestrator'))
    const { sessions } = useOrchestraStore.getState()
    expect(sessions[a].selectedId).toBe('orchestrator')
    expect(sessions[b].selectedId).toBeNull()
  })
})
