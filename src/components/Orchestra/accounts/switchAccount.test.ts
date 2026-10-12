import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  setSessionAccount: vi.fn(),
  cancelLimitWait: vi.fn(),
  continueAfterLimitReset: vi.fn(),
  wait: null as null | { account: string | null; resetsAt: number; auto?: boolean },
  sessions: {} as Record<string, unknown>,
}))

vi.mock('../../../stores/orchestraStore', () => ({
  confirmStop: mocks.confirm,
  useOrchestraStore: {
    getState: () => ({ sessions: mocks.sessions, setSessionAccount: mocks.setSessionAccount }),
  },
}))
vi.mock('../../../lib/limitResetWatch', () => ({
  cancelLimitWait: mocks.cancelLimitWait,
  continueAfterLimitReset: mocks.continueAfterLimitReset,
  limitWaitOf: () => mocks.wait,
}))
vi.mock('../usage/launchDefaults', () => ({
  sessionLaunchOf: (s: { launch: { account: string | null } }) => s.launch,
}))

import {
  switchSessionAccountGuarded,
  UNDO_SWITCH_MS,
  undoAccountSwitch,
  useAccountSwitchUndo,
} from './switchAccount'

const t = ((key: string) => key) as never

beforeEach(() => {
  mocks.confirm.mockClear()
  mocks.confirm.mockImplementation(() => Promise.resolve(true))
  mocks.setSessionAccount.mockClear()
  mocks.continueAfterLimitReset.mockClear()
  mocks.wait = null
  mocks.sessions = { s1: { launch: { account: 'a' }, stoppedAt: null } }
  useAccountSwitchUndo.setState({ bySession: {} })
})

describe('use in this session', () => {
  it('switches a healthy account without asking and offers undo for 10 s', async () => {
    expect(await switchSessionAccountGuarded('s1', 'b', [], 'B', t, () => 1_000)).toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.setSessionAccount).toHaveBeenCalledWith('s1', 'b')
    expect(useAccountSwitchUndo.getState().bySession.s1).toEqual({
      from: 'a',
      to: 'b',
      until: 1_000 + UNDO_SWITCH_MS,
      wait: null,
    })
  })

  it('asks first when the target has an error, is near the limit or is a duplicate', async () => {
    mocks.confirm.mockImplementation(() => Promise.resolve(false))
    for (const risk of ['error', 'near', 'duplicate'] as const) {
      expect(await switchSessionAccountGuarded('s1', 'b', [risk], 'B', t)).toBe(false)
    }
    expect(mocks.confirm).toHaveBeenCalledTimes(3)
    expect(mocks.setSessionAccount).not.toHaveBeenCalled()
    expect(useAccountSwitchUndo.getState().bySession.s1).toBeUndefined()
  })

  it('undo goes back to the previous account', async () => {
    await switchSessionAccountGuarded('s1', null, ['near'], 'Default', t)
    expect(mocks.setSessionAccount).toHaveBeenLastCalledWith('s1', null)
    undoAccountSwitch('s1')
    expect(mocks.setSessionAccount).toHaveBeenLastCalledWith('s1', 'a')
    expect(useAccountSwitchUndo.getState().bySession.s1).toBeUndefined()
  })

  it('does nothing on a stopped session', async () => {
    mocks.sessions = { s1: { launch: { account: 'a' }, stoppedAt: 5 } }
    expect(await switchSessionAccountGuarded('s1', 'b', [], 'B', t)).toBe(false)
    expect(mocks.setSessionAccount).not.toHaveBeenCalled()
  })

  it('undo arms again the wait the switch cancelled, while its reset is still ahead', async () => {
    mocks.wait = { account: 'a', resetsAt: 50_000, auto: true }
    await switchSessionAccountGuarded('s1', 'b', [], 'B', t, () => 1_000)
    undoAccountSwitch('s1', () => 2_000)
    expect(mocks.continueAfterLimitReset).toHaveBeenCalledWith({
      sessionId: 's1',
      account: 'a',
      resetsAt: 50_000,
      auto: true,
    })
  })

  it('undo leaves a wait whose reset already passed', async () => {
    mocks.wait = { account: 'a', resetsAt: 50_000 }
    await switchSessionAccountGuarded('s1', 'b', [], 'B', t, () => 1_000)
    undoAccountSwitch('s1', () => 60_000)
    expect(mocks.setSessionAccount).toHaveBeenLastCalledWith('s1', 'a')
    expect(mocks.continueAfterLimitReset).not.toHaveBeenCalled()
  })
})

describe('undo toast countdown', () => {
  it('pauses with the time left and resumes from it', async () => {
    await switchSessionAccountGuarded('s1', 'b', [], 'B', t, () => 0)
    const { pause, resume } = useAccountSwitchUndo.getState()
    pause('s1', 4_000)
    expect(useAccountSwitchUndo.getState().bySession.s1.paused).toBe(UNDO_SWITCH_MS - 4_000)
    pause('s1', 9_000)
    expect(useAccountSwitchUndo.getState().bySession.s1.paused).toBe(UNDO_SWITCH_MS - 4_000)
    resume('s1', 100_000)
    const undo = useAccountSwitchUndo.getState().bySession.s1
    expect(undo.paused).toBeNull()
    expect(undo.until).toBe(100_000 + UNDO_SWITCH_MS - 4_000)
  })
})
