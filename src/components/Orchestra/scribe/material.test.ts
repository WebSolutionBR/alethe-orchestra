import { describe, expect, it, vi } from 'vitest'

import type { OrchestraEvent } from '../../../lib/tauri/orchestra'
import {
  type MaterialEntry,
  materialFromEvent,
  MaterialLog,
  parseMaterial,
  renderMaterial,
} from './material'
import { REDACTED } from './redact'

const S = 'oabc1234'
const hook = (agent: string, payload: Record<string, unknown>, at = 10): OrchestraEvent =>
  ({ kind: 'hook', session: S, at, agent_id: agent, hook: payload }) as OrchestraEvent

describe('materialFromEvent', () => {
  it('keeps requests, decisions and outcomes, not routine tool calls', () => {
    const spawn = materialFromEvent({
      kind: 'spawn',
      session: S,
      at: 1,
      id: 'claude-7',
      area: 'escriba-v2',
      task: 'Leia a tarefa em C:/tarefas/claude-7.md',
      after: ['claude-5'],
    })
    expect(spawn).toEqual([
      {
        at: 1,
        kind: 'spawn',
        agent: 'claude-7',
        text: 'criado · área escriba-v2 (depois de claude-5): Leia a tarefa em C:/tarefas/claude-7.md',
      },
    ])
    const report = (status: string | null, progress: number | null, note: string) =>
      materialFromEvent({
        kind: 'report',
        session: S,
        at: 2,
        agent_id: 'claude-7',
        status,
        progress,
        note,
      } as OrchestraEvent)
    expect(report('done', 100, 'pronto')[0]).toMatchObject({ kind: 'done', text: 'pronto' })
    expect(report('blocked', 40, 'sem acesso')[0]).toMatchObject({ kind: 'blocked' })
    expect(report('testing', 70, 'vitest ok')[0]).toMatchObject({
      kind: 'report',
      text: '70% testando: vitest ok',
    })
    expect(report('editing', 30, '')).toEqual([])

    expect(
      hook('claude-7', { hook_event_name: 'PreToolUse', tool_name: 'Read', target: 'C:/a.ts' }),
    ).toBeTruthy()
    expect(
      materialFromEvent(
        hook('claude-7', { hook_event_name: 'PreToolUse', tool_name: 'Read', target: 'C:/a.ts' }),
      ),
    ).toEqual([])
    expect(
      materialFromEvent(
        hook('claude-7', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          target: 'C:/repo/src/a.ts',
        }),
      )[0],
    ).toMatchObject({ kind: 'edit', text: 'C:\\repo\\src\\a.ts' })
    expect(
      materialFromEvent(
        hook('claude-7', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          target: 'npx vitest run src/x',
        }),
      )[0],
    ).toMatchObject({ kind: 'verify' })
    expect(
      materialFromEvent(
        hook('claude-7', { hook_event_name: 'PreToolUse', tool_name: 'Bash', target: 'ls -la' }),
      ),
    ).toEqual([])
    expect(
      materialFromEvent(
        hook('claude-7', {
          hook_event_name: 'PreToolUse',
          tool_name: 'PowerShell',
          target: 'VERCEL_TOKEN=abc123xyz vercel deploy',
        }),
      )[0],
    ).toMatchObject({ kind: 'deploy', text: `VERCEL_TOKEN=${REDACTED} vercel deploy` })
  })

  it('keeps what was typed by hand and the agents own notes, not relayed messages', () => {
    expect(
      materialFromEvent(
        hook('claude-7', {
          hook_event_name: 'UserPromptSubmit',
          prompt: '[orchestra · from claude-8] oi',
        }),
      ),
    ).toEqual([])
    expect(
      materialFromEvent(
        hook('claude-7', { hook_event_name: 'UserPromptSubmit', prompt: 'faça X' }),
      )[0],
    ).toMatchObject({ kind: 'prompt', text: 'faça X' })
    const note = materialFromEvent({
      kind: 'note',
      session: S,
      at: 5,
      agent_id: 'claude-7',
      text: 'Decisão: a fila fica no app porque a chave não sai do backend.',
    } as OrchestraEvent)
    expect(note[0]).toMatchObject({ kind: 'note', agent: 'claude-7' })
    expect(
      materialFromEvent({
        kind: 'message',
        session: S,
        at: 6,
        from: 'claude-8',
        to: 'claude-7',
        text: 'aplicado',
      })[0],
    ).toMatchObject({ kind: 'message', text: 'claude-8 → claude-7: aplicado' })
  })
})

describe('MaterialLog', () => {
  it('drops duplicates, saves in batches and reads back after a restart', async () => {
    vi.useFakeTimers()
    try {
      const saved: string[] = []
      const storage = {
        append: vi.fn(async (_id: string, lines: string[]) => {
          saved.push(...lines)
        }),
        read: vi.fn(async () => saved.join('\n')),
        remove: vi.fn(async () => {}),
      }
      const log = new MaterialLog(storage)
      const edit: MaterialEntry = { at: 1, kind: 'edit', agent: 'claude-7', text: 'C:\\a.ts' }
      expect(log.record(S, [edit, { ...edit, at: 2 }])).toHaveLength(1)
      log.record(S, [{ at: 3, kind: 'done', agent: 'claude-7', text: 'ok' }])
      expect(storage.append).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_600)
      expect(storage.append).toHaveBeenCalledTimes(1)
      expect(saved).toHaveLength(2)

      const restarted = new MaterialLog(storage)
      const entries = await restarted.load(S)
      expect(entries.map((e) => e.kind)).toEqual(['edit', 'done'])
      restarted.forget(S, true)
      expect(storage.remove).toHaveBeenCalledWith(S)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never rejects when the disk fails', async () => {
    const log = new MaterialLog({
      append: () => Promise.reject(new Error('disk')),
      read: () => Promise.reject(new Error('disk')),
      remove: () => Promise.reject(new Error('disk')),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.record(S, [{ at: 1, kind: 'done', text: 'ok' }])
    await expect(log.flush()).resolves.toBeUndefined()
    expect(log.entries(S)).toHaveLength(1)
    expect(await log.load('onone')).toEqual([])
    warn.mockRestore()
  })
})

describe('renderMaterial', () => {
  it('fits the budget keeping decisions before routine entries', () => {
    const entries: MaterialEntry[] = [
      { at: 1, kind: 'start', text: 'Sessão iniciada' },
      ...Array.from({ length: 40 }, (_, i) => ({
        at: 2 + i,
        kind: 'edit' as const,
        agent: 'claude-1',
        text: `C:\\arquivo-${i}.ts`,
      })),
      { at: 100, kind: 'done', agent: 'claude-1', text: 'pronto' },
    ]
    const full = renderMaterial(entries)
    expect(full.split('\n')).toHaveLength(42)
    const cut = renderMaterial(entries, 300)
    expect(cut).toContain('entradas mais antigas ou de rotina omitidas')
    expect(cut).toContain('Sessão iniciada')
    expect(cut).toContain('pronto')
    expect(cut.length).toBeLessThan(420)
    // Kept lines stay in time order.
    const times = cut
      .split('\n')
      .slice(1)
      .map((l) => l.slice(0, 5))
    expect([...times].sort()).toEqual(times)
  })

  it('parses stored lines and skips torn ones', () => {
    const text = `${JSON.stringify({ at: 1, kind: 'done', text: 'ok', agent: 'c' })}\n{"at":2,"kind"`
    expect(parseMaterial(text)).toEqual([{ at: 1, kind: 'done', text: 'ok', agent: 'c' }])
  })
})
