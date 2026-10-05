import { describe, expect, it, vi } from 'vitest'

import type {
  ScribeAuthorOutcome,
  ScribeAuthorRequest,
  ScribeSourcesRequest,
} from '../../../lib/tauri/obsidian'
import { ABSENT, buildVaultIndex, contentHash, type WriteOp } from './author'
import type { SessionRecord, SessionSnapshot } from './authorStatus'
import { DEFAULT_SCRIBE_CONFIG, type ScribeConfig } from './config'
import {
  authorLaunch,
  freeDiaryPath,
  mentionedFiles,
  runSynthesis,
  type SynthesisDeps,
} from './synthesis'

const started = new Date(2026, 9, 4, 20, 0).getTime()
const now = new Date(2026, 9, 4, 23, 0).getTime()

const snapshot: SessionSnapshot = {
  id: 'oabc1234',
  projectName: 'Sistemas e automações',
  cwd: 'C:/Users/Profile/Documents/Alethe/Sistemas_e_autromacoes',
  goal: 'Melhorar o Alethe Orchestra',
  startedAt: started,
  endedAt: null,
  agents: [
    {
      id: 'orchestrator',
      area: 'orchestrator',
      state: 'thinking',
      progress: 0,
      task: 'Melhorar o Alethe Orchestra',
      note: '',
      transcriptPath: 'C:/acc/projects/p1/orch.jsonl',
      history: [],
    },
    {
      id: 'claude-7',
      area: 'escriba-v2',
      state: 'done',
      progress: 100,
      task: 'Leia sua tarefa em C:/Users/Profile/tarefas/claude-7-escriba-v2.md e execute.',
      note: 'pronto',
      transcriptPath: 'C:/acc/projects/p1/w7.jsonl',
      history: [],
    },
  ],
  account: 'acc1',
  model: 'opus',
  effort: 'high',
}

const PLAN = `=== TITLE ===
Escriba v2
=== END ===
=== SUMMARY ===
Caso do escriba registrado
=== END ===
=== NOTE path="@diary" mode="full" ===
# Sessão 2026-10-04 — Escriba v2
Ver [[Alethe]].

---

# Notas relacionadas
- [[Alethe]] — hub
=== END ===
=== HUB path="Ferramentas/Alethe.md" heading="Relacionados" ===
- [[@diary]] — diário da sessão
=== END ===`

function deps(patch: Partial<SynthesisDeps> = {}, config: Partial<ScribeConfig> = {}) {
  const runs: ScribeAuthorRequest[] = []
  const sourceRequests: ScribeSourcesRequest[] = []
  const batches: { session: string; label: string; ops: WriteOp[] }[] = []
  const notes: Record<string, string> = {
    'Diário/_Template - Sessão diária.md': '## Resumo do dia\n## Casos / atividades',
  }
  const base: SynthesisDeps = {
    config: () => ({ ...DEFAULT_SCRIBE_CONFIG, vaultPath: 'G:/Vault', ...config }),
    now: () => now,
    record: () => null,
    snapshot: () => snapshot,
    material: async () => [{ at: started, kind: 'start', text: 'Sessão iniciada' }],
    contextNotes: () => ['Ferramentas/Alethe.md'],
    read: async (path) => (path in notes ? { content: notes[path], truncated: false } : null),
    list: async () => ['Sessão 2026-10-04 — Opala.md', 'Outra nota.md'],
    index: async () =>
      buildVaultIndex(['Ferramentas/Alethe.md', 'Diário/_Template - Sessão diária.md']),
    sources: async (request) => {
      sourceRequests.push(request)
      return request.paths.map((path) => ({
        path,
        content: '# Tarefa do claude-7',
        truncated: false,
      }))
    },
    accountDir: (id) => `C:/data/claude-accounts/${id}`,
    launchDefaults: () => ({ account: null, model: null, effort: null }),
    run: async (request) => {
      runs.push(request)
      return outcome(PLAN)
    },
    enqueue: (batch) => {
      batches.push(batch)
      return batches.length
    },
    runId: () => 'oabc1234-run1',
    ...patch,
  }
  return { deps: base, runs, batches, notes, sourceRequests }
}

function outcome(result: string, patch: Partial<ScribeAuthorOutcome> = {}): ScribeAuthorOutcome {
  return {
    ok: true,
    result,
    error: null,
    detail: null,
    durationMs: 1,
    costUsd: 0.1,
    turns: 3,
    denials: 0,
    mcp: true,
    ...patch,
  }
}

const request = {
  sessionId: 'oabc1234',
  triggers: ['worker-done' as const],
  finished: ['claude-7'],
  final: false,
}

describe('runSynthesis', () => {
  it('runs the author with the session account, model and read-only folders', async () => {
    const { deps: d, runs, batches, sourceRequests } = deps()
    const result = await runSynthesis(request, d)
    expect(result.ok).toBe(true)
    expect(runs).toHaveLength(1)
    const run = runs[0]
    expect(run).toMatchObject({
      runId: 'oabc1234-run1',
      model: 'opus',
      effort: 'high',
      configDir: 'C:/data/claude-accounts/acc1',
      vaultPath: 'G:/Vault',
      sessionId: 'oabc1234',
      sessionFolder: 'C:/Users/Profile/Documents/Alethe/Sistemas_e_autromacoes',
      // Only the session's transcripts and task files: the author reads its own copies.
      transcripts: [
        { name: 'orchestrator', path: 'C:/acc/projects/p1/orch.jsonl' },
        { name: 'claude-7', path: 'C:/acc/projects/p1/w7.jsonl' },
      ],
      sources: ['C:/Users/Profile/tarefas/claude-7-escriba-v2.md'],
      timeoutSecs: DEFAULT_SCRIBE_CONFIG.authorTimeoutMin * 60,
      maxTurns: 40,
      maxBudgetUsd: 5,
    })
    expect(run).not.toHaveProperty('readDirs')
    expect(sourceRequests[0]).toEqual({
      sessionId: 'oabc1234',
      sessionFolder: 'C:/Users/Profile/Documents/Alethe/Sistemas_e_autromacoes',
      paths: ['C:/Users/Profile/tarefas/claude-7-escriba-v2.md'],
    })
    expect(run.prompt).toContain('| transcripts/claude-7.jsonl |')
    expect(run.prompt).not.toContain('projects')
    // The prompt carries the live template, the task file and the same-day notes only.
    expect(run.prompt).toContain('read live from "Diário/_Template - Sessão diária.md"')
    expect(run.prompt).toContain('# Tarefa do claude-7')
    expect(run.prompt).toContain('[[Sessão 2026-10-04 — Opala]]')
    expect(run.prompt).not.toContain('Outra nota')
    expect(run.prompt).toContain('Sessão iniciada')
    // The diary note is named from the author's title; the hub links it by that name.
    expect(batches).toHaveLength(1)
    const [diary, hub] = batches[0].ops
    expect(diary).toMatchObject({
      kind: 'put',
      notePath: 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Escriba v2.md',
      expect: ABSENT,
    })
    expect(hub).toMatchObject({
      kind: 'hub',
      lines: ['- [[Sessão 2026-10-04 — Escriba v2]] — diário da sessão'],
    })
    if (result.ok) expect(result.title).toBe('Escriba v2')
  })

  it('keeps the diary note of earlier passes and hands the author its current text', async () => {
    const path = 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Primeiro título.md'
    const current = '---\nescriba: alethe-orchestra\n---\n# Sessão\nconteúdo anterior'
    const record: SessionRecord = {
      id: 'oabc1234',
      title: 'Primeiro título',
      diaryPath: path,
      sessionNote: path,
      syntheses: 1,
      lastAt: started,
      lastSummary: null,
      lastNotes: [],
      pendingFinal: false,
      snapshot: null,
      updatedAt: started,
    }
    const { deps: d, runs, batches, notes } = deps({ record: () => record })
    notes[path] = current
    await runSynthesis({ ...request, final: true, triggers: ['session-end'] }, d)
    expect(runs[0].prompt).toContain('conteúdo anterior')
    expect(runs[0].prompt).toContain('This is the final pass')
    expect(batches[0].ops[0]).toMatchObject({ notePath: path, expect: contentHash(current) })
  })

  it('uses the scribe settings over the session for the author launch', () => {
    const config = {
      ...DEFAULT_SCRIBE_CONFIG,
      authorAccount: 'default',
      authorModel: 'sonnet',
      authorEffort: '',
    }
    expect(authorLaunch(config, snapshot, { account: 'x', model: 'haiku', effort: 'low' })).toEqual(
      {
        account: null,
        model: 'sonnet',
        effort: 'high',
      },
    )
    const plain = { ...DEFAULT_SCRIBE_CONFIG }
    const bare = { ...snapshot, account: null, model: null, effort: null }
    expect(authorLaunch(plain, bare, { account: 'x', model: 'haiku', effort: 'low' })).toEqual({
      account: 'x',
      model: 'haiku',
      effort: 'low',
    })
  })

  it('reports why a pass failed, and never throws', async () => {
    const failing = deps({
      run: async () => outcome('', { ok: false, error: 'timeout', detail: '720 s' }),
    })
    expect(await runSynthesis(request, failing.deps)).toMatchObject({
      ok: false,
      failure: 'timeout',
      detail: '720 s',
    })
    expect(failing.batches).toHaveLength(0)

    const noPlan = deps({ run: async () => outcome('Desculpe, não consegui.') })
    expect(await runSynthesis(request, noPlan.deps)).toMatchObject({ ok: false, failure: 'plan' })

    const empty = deps({
      run: async () => outcome('=== NOTE path="../x.md" mode="full" ===\nx\n=== END ==='),
    })
    expect(await runSynthesis(request, empty.deps)).toMatchObject({ ok: false, failure: 'empty' })

    const noVault = deps({}, { vaultPath: '' })
    expect(await runSynthesis(request, noVault.deps)).toMatchObject({
      ok: false,
      failure: 'no-vault',
    })

    const gone = deps({ snapshot: () => null })
    expect(await runSynthesis(request, gone.deps)).toMatchObject({
      ok: false,
      failure: 'no-session',
    })

    const crash = deps({ run: () => Promise.reject(new Error('ipc down')) })
    expect(await runSynthesis(request, crash.deps)).toMatchObject({
      ok: false,
      failure: 'spawn',
      detail: 'ipc down',
    })

    // Obsidian closed: no run is spent writing blind.
    const closed = deps({
      read: () => Promise.reject(new Error('Obsidian is not reachable (is the app open?)')),
    })
    expect(await runSynthesis(request, closed.deps)).toMatchObject({
      ok: false,
      failure: 'unreachable',
    })
    expect(closed.runs).toHaveLength(0)
  })

  it('falls back to the built-in template when the vault one cannot be read', async () => {
    const { deps: d, runs, notes } = deps()
    delete notes['Diário/_Template - Sessão diária.md']
    await runSynthesis(request, d)
    expect(runs[0].prompt).toContain('built-in copy; the vault template could not be read')
    expect(runs[0].prompt).toContain('## Casos / atividades')
  })
})

describe('synthesis helpers', () => {
  it('finds the task files the orchestrator pointed to', () => {
    expect(
      mentionedFiles(
        'Leia C:/tarefas/a.md, depois C:\\x\\b.txt e /home/r/c.md. Não: C:/x/c.json, https://x.com/d.md',
      ),
    ).toEqual(['C:/tarefas/a.md', 'C:\\x\\b.txt', '/home/r/c.md'])
  })

  it('never takes the name of a note the vault already has', () => {
    const index = buildVaultIndex(['Diário/2026/10 - Outubro/Sessão 2026-10-04 — X.md'])
    const pattern = DEFAULT_SCRIBE_CONFIG.diaryPattern
    expect(freeDiaryPath(pattern, started, 'X', index)).toBe(
      'Diário/2026/10 - Outubro/Sessão 2026-10-04 — X (2).md',
    )
    expect(freeDiaryPath(pattern, started, 'Y', index)).toBe(
      'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Y.md',
    )
    expect(freeDiaryPath(pattern, started, 'X', null)).toBe(
      'Diário/2026/10 - Outubro/Sessão 2026-10-04 — X.md',
    )
    vi.restoreAllMocks()
  })
})
