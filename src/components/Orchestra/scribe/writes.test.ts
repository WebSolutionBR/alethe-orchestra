import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ABSENT, contentHash, withScribeMarker, type WriteOp } from './author'
import { CONFLICT_ISSUE, PermanentWriteError, WriteQueue } from './queue'
import { applyWriteOp, type WriterDeps } from './writer'

/** An in-memory vault with the Local REST API semantics the writer relies on. */
function memoryVault(initial: Record<string, string> = {}) {
  const notes = new Map(Object.entries(initial))
  const calls: string[] = []
  const deps: WriterDeps = {
    read: vi.fn(async (path: string) => {
      const content = notes.get(path)
      return content === undefined ? null : { content, truncated: false }
    }),
    put: vi.fn(async (path: string, content: string) => {
      calls.push(`put ${path}`)
      notes.set(path, content)
    }),
    patch: vi.fn(async (path: string, heading: string[], content: string) => {
      calls.push(`patch ${path} ${heading.join('::')}`)
      const current = notes.get(path) ?? ''
      // The plugin refuses text that is already in the section.
      if (current.includes(content.trim())) return { applied: false, preexisting: true }
      notes.set(path, `${current}${content}`)
      return { applied: true, preexisting: false }
    }),
    append: vi.fn(async (path: string, content: string) => {
      calls.push(`append ${path}`)
      notes.set(path, `${notes.get(path) ?? ''}${content}`)
    }),
  }
  return { notes, calls, deps }
}

const DIARY = 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — X.md'
const own = (body: string) => withScribeMarker(`# Sessão\n${body}\n`)

describe('applyWriteOp', () => {
  it('creates a new note and writes the scribe own note again when nobody changed it', async () => {
    const { deps, notes } = memoryVault()
    const first: WriteOp = {
      kind: 'put',
      notePath: DIARY,
      content: own('v1'),
      expect: ABSENT,
      diary: true,
    }
    expect(await applyWriteOp(first, [], deps)).toEqual({ status: 'written' })
    // A retry of the same write finds the same text: nothing to do.
    expect(await applyWriteOp(first, [], deps)).toEqual({ status: 'unchanged' })
    const second: WriteOp = {
      kind: 'put',
      notePath: DIARY,
      content: own('v2'),
      expect: contentHash(notes.get(DIARY)!),
      diary: true,
    }
    expect(await applyWriteOp(second, [], deps)).toEqual({ status: 'written' })
    expect(notes.get(DIARY)).toContain('v2')
  })

  it('never overwrites a note the scribe did not create, or one changed meanwhile', async () => {
    const { deps } = memoryVault({ 'Mine.md': '# Minha nota\n', [DIARY]: own('editada pelo dono') })
    await expect(
      applyWriteOp(
        { kind: 'put', notePath: 'Mine.md', content: own('x'), expect: ABSENT, diary: false },
        [],
        deps,
      ),
    ).rejects.toBeInstanceOf(PermanentWriteError)
    await expect(
      applyWriteOp(
        { kind: 'put', notePath: DIARY, content: own('nova'), expect: 'deadbeef', diary: true },
        [],
        deps,
      ),
    ).rejects.toThrow(/mudou depois que o autor a leu/)
    // A subject note the scribe created in another session only gets sections now.
    const { deps: other } = memoryVault({ 'Assunto.md': own('de outra sessão') })
    await expect(
      applyWriteOp(
        {
          kind: 'put',
          notePath: 'Assunto.md',
          content: own('reescrita'),
          expect: ABSENT,
          diary: false,
        },
        [],
        other,
      ),
    ).rejects.toThrow(/acrescentar uma seção/)
    expect(deps.put).not.toHaveBeenCalled()
    expect(other.put).not.toHaveBeenCalled()
  })

  it('appends a section under the full heading path, once', async () => {
    const note =
      '# Sessão 2026-10-04 — Opala\n## Casos / atividades\n### Caso 1\n\n---\n\n# Notas relacionadas\n- [[A]] — a\n'
    const { deps, calls } = memoryVault({ 'Opala.md': note })
    const op: WriteOp = {
      kind: 'section',
      notePath: 'Opala.md',
      heading: 'Casos / atividades',
      content: '### Escriba\n- ok',
      diary: false,
    }
    expect(await applyWriteOp(op, [], deps)).toEqual({ status: 'written' })
    expect(calls).toEqual(['patch Opala.md Sessão 2026-10-04 — Opala::Casos / atividades'])
    expect(await applyWriteOp(op, [], deps)).toEqual({ status: 'unchanged' })
    await expect(applyWriteOp({ ...op, notePath: 'Sumida.md' }, [], deps)).rejects.toBeInstanceOf(
      PermanentWriteError,
    )
  })

  it('creates the agents note when asked and adds a missing heading under the top one', async () => {
    const { deps, notes, calls } = memoryVault({ 'Hub.md': '# Hub\ntexto' })
    await applyWriteOp(
      {
        kind: 'section',
        notePath: 'Nova.md',
        heading: 'claude-7 · escriba',
        content: 'decisão',
        diary: false,
        createIfMissing: true,
      },
      [],
      deps,
    )
    expect(notes.get('Nova.md')).toBe('# Nova\n\n## claude-7 · escriba\ndecisão\n')
    await applyWriteOp(
      {
        kind: 'section',
        notePath: 'Hub.md',
        heading: 'Histórico',
        content: '- linha',
        diary: false,
      },
      [],
      deps,
    )
    expect(calls).toContain('patch Hub.md Hub::Histórico')
  })

  it('adds hub links once, under the related-notes heading, after their notes exist', async () => {
    const hub = '# Alethe\n## Relacionados\n- [[Alethe - build próprio]] — build\n'
    const { deps, notes, calls } = memoryVault({ 'Alethe.md': hub, 'Sem.md': '# Sem\nnada' })
    const op: WriteOp = {
      kind: 'hub',
      notePath: 'Alethe.md',
      heading: 'Notas relacionadas',
      lines: ['- [[Alethe - build próprio]] — repetido', '- [[Sessão X]] — nova'],
      requires: [DIARY],
    }
    await expect(applyWriteOp(op, [], deps)).rejects.toThrow(/não foi gravada/)
    expect(await applyWriteOp(op, [DIARY], deps)).toEqual({ status: 'written' })
    expect(calls).toEqual(['patch Alethe.md Alethe::Relacionados'])
    expect(notes.get('Alethe.md')).toContain('- [[Sessão X]] — nova')
    expect(notes.get('Alethe.md')).not.toContain('repetido')
    expect(await applyWriteOp(op, [DIARY], deps)).toEqual({ status: 'unchanged' })
    // A hub without a related-notes section gets the owner closing at the end.
    await applyWriteOp({ ...op, notePath: 'Sem.md', requires: [] }, [], deps)
    expect(notes.get('Sem.md')).toContain(
      '\n---\n\n# Notas relacionadas\n- [[Alethe - build próprio]] — repetido\n- [[Sessão X]] — nova\n',
    )
  })
})

describe('WriteQueue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  const put = (path: string): WriteOp => ({
    kind: 'put',
    notePath: path,
    content: 'x',
    expect: ABSENT,
    diary: false,
  })

  it('waits while Obsidian is away and resumes at the operation it stopped on', async () => {
    let away = true
    const applied: string[] = []
    const apply = vi.fn(async (op: WriteOp) => {
      if (away && op.notePath === 'B.md')
        throw new Error('Obsidian is not reachable (is the app open?)')
      applied.push(op.notePath)
      return { status: 'written' as const }
    })
    const done = vi.fn()
    const queue = new WriteQueue({
      apply,
      storageKey: 'test.writes',
      onBatchDone: done,
      baseDelayMs: 1_000,
    })
    queue.enqueue({ session: 's1', label: 'síntese', ops: [put('A.md'), put('B.md')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual(['A.md'])
    expect(queue.snapshot()).toMatchObject({ pending: 1, failures: 1 })

    // A restart keeps the batch and where it was.
    const restored = new WriteQueue({ apply, storageKey: 'test.writes', onBatchDone: done })
    expect(restored.snapshot().pending).toBe(1)
    queue.dispose()
    away = false
    restored.retryNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual(['A.md', 'B.md'])
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0].done).toEqual(['A.md', 'B.md'])
    expect(restored.snapshot()).toMatchObject({ pending: 0, failures: 0 })
  })

  it('moves what can never be written aside, with its text, and goes on', async () => {
    const apply = vi.fn(async (op: WriteOp) => {
      if (op.notePath === 'Bad.md') throw new PermanentWriteError('invalid note path')
      if (op.notePath === 'Changed.md') {
        const { ConflictWriteError } = await import('./queue')
        throw new ConflictWriteError('mudou')
      }
      return { status: 'written' as const }
    })
    const done = vi.fn()
    const queue = new WriteQueue({ apply, onBatchDone: done })
    queue.enqueue({ label: 'x', ops: [put('Bad.md'), put('Changed.md'), put('Good.md')] })
    await vi.advanceTimersByTimeAsync(0)
    const snap = queue.snapshot()
    expect(snap.pending).toBe(0)
    expect(snap.failed).toHaveLength(1)
    expect(snap.failed[0]).toMatchObject({
      notePath: 'Bad.md',
      content: 'x',
      reason: 'invalid note path',
    })
    expect(done.mock.calls[0][0].issues).toContain(`${CONFLICT_ISSUE} Changed.md`)
    queue.discard(snap.failed[0].id)
    expect(queue.snapshot().failed).toEqual([])
  })

  it('gives up on an operation that keeps failing for another reason', async () => {
    const apply = vi.fn(async () => {
      throw new Error('Obsidian answered 500 Internal Server Error')
    })
    const queue = new WriteQueue({ apply, baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3 })
    queue.enqueue({ label: 'x', ops: [put('A.md')] })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(apply).toHaveBeenCalledTimes(3)
    expect(queue.snapshot()).toMatchObject({ pending: 0 })
    expect(queue.snapshot().failed).toHaveLength(1)
  })

  it('counts what a full queue drops and settles idle waits', async () => {
    const apply = vi.fn(async () => {
      throw new Error('timeout talking to Obsidian')
    })
    const queue = new WriteQueue({ apply, maxBatches: 2 })
    for (const name of ['A', 'B', 'C']) queue.enqueue({ label: name, ops: [put(`${name}.md`)] })
    expect(queue.snapshot()).toMatchObject({ pending: 2, dropped: 1 })
    const idle = queue.whenIdle(500)
    await vi.advanceTimersByTimeAsync(500)
    await expect(idle).resolves.toBeUndefined()
  })
})
