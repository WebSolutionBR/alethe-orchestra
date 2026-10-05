import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ObsidianNote, ObsidianSearchHit, ObsidianSearchResult } from './api'
import {
  buildContextMarkdown,
  CONTEXT_BUDGET_MS,
  CONTEXT_MAX_CHARS,
  type ContextDeps,
  type ContextRequest,
  contextTerms,
  foldText,
  gatherObsidianContext,
  keywords,
  noteSnippets,
  pickNotes,
  rankNotes,
  recency,
  searchQueries,
  sessionNoteDigest,
  settleWithin,
  wikiLink,
} from './context'

const at = new Date(2026, 9, 4, 21, 40).getTime()
const SESSION_NOTE = 'Alethe Orchestra/2026-10-04 Orchestra.md'

function hit(filename: string, matchCount = 1, contexts: string[] = []): ObsidianSearchHit {
  return { filename, score: -matchCount, match_count: matchCount, contexts }
}

function result(hits: ObsidianSearchHit[], total = hits.length): ObsidianSearchResult {
  return { total, hits }
}

function note(path: string, content: string): ObsidianNote {
  return { path, content, size: content.length, truncated: false }
}

describe('context terms', () => {
  it('keeps the words worth searching for', () => {
    expect(keywords('Melhorar o Alethe Oschestra')).toEqual(['alethe', 'oschestra'])
    expect(keywords('Fix the terminal scroll in 2026 v2')).toEqual(['terminal', 'scroll'])
    expect(foldText('Automações SESSÃO')).toBe('automacoes sessao')
  })

  it('takes the project, then the goal, then the folder, without repeats', () => {
    expect(
      contextTerms({
        projectName: 'Sistemas e automações',
        goal: 'Melhorar o Alethe Oschestra',
        cwd: 'C:\\Users\\Profile\\Documents\\Alethe\\Sistemas_e_autromacoes\\',
      }),
    ).toEqual(['sistemas', 'automações', 'alethe', 'oschestra', 'autromacoes'])
    // Accents and case aside, a word is searched once.
    expect(contextTerms({ projectName: 'Automacoes', goal: 'AUTOMAÇÕES do terminal' })).toEqual([
      'automacoes',
      'terminal',
    ])
    expect(
      contextTerms({ goal: 'alpha bravo charlie delta echo foxtrot golf hotel' }),
    ).toHaveLength(6)
    expect(contextTerms({ goal: 'Leia o arquivo C:/Users/Profile/Documents/x.md' })).toEqual([])
  })

  it('also searches the unaccented spelling of accented terms', () => {
    expect(searchQueries(['automações', 'alethe'])).toEqual([
      { term: 'automações', query: 'automações' },
      { term: 'automações', query: 'automacoes' },
      { term: 'alethe', query: 'alethe' },
    ])
    expect(searchQueries(['ação', 'sessão', 'notação', 'versão', 'extra'])).toHaveLength(8)
  })
})

describe('rankNotes', () => {
  it('weighs rare terms and path matches above common words, and leaves the session note out', () => {
    const ranked = rankNotes({
      terms: ['alethe', 'melhorar'],
      runs: [
        {
          term: 'alethe',
          result: result(
            [
              hit(SESSION_NOTE, 90),
              hit('Diário/Sessão 2026-09-01.md', 3),
              hit('Ferramentas/Alethe - build próprio.md', 12, ['o build do Alethe']),
            ],
            8,
          ),
        },
        {
          term: 'melhorar',
          result: result(
            [hit('Estudos/Hábitos.md', 40), hit('Diário/Sessão 2026-09-01.md', 1)],
            300,
          ),
        },
      ],
      folderNotes: ['Alethe Orchestra/2026-10-04 Frota v2.md', SESSION_NOTE],
      exclude: [SESSION_NOTE],
      today: '2026-10-04',
    })
    expect(ranked.map((n) => n.path)).toEqual([
      'Alethe Orchestra/2026-10-04 Frota v2.md',
      'Ferramentas/Alethe - build próprio.md',
      'Diário/Sessão 2026-09-01.md',
      'Estudos/Hábitos.md',
    ])
    expect(ranked[0]).toMatchObject({ inFolder: true, terms: ['alethe'] })
    expect(ranked[1]).toMatchObject({ terms: ['alethe'], contexts: ['o build do Alethe'] })
    expect(ranked[2].terms).toEqual(['alethe', 'melhorar'])
  })

  it('keeps the plugin order on ties', () => {
    const ranked = rankNotes({
      terms: ['zeta'],
      runs: [{ term: 'zeta', result: result([hit('b.md'), hit('a.md')]) }],
      folderNotes: [],
      exclude: [],
      today: '2026-10-04',
    })
    expect(ranked.map((n) => n.path)).toEqual(['b.md', 'a.md'])
  })

  it('keeps a busy folder from crowding out the subject notes', () => {
    const ranked = [
      'Diário/a.md',
      'Diário/b.md',
      'Diário/c.md',
      'Alethe Orchestra/x.md',
      'Alethe Orchestra/y.md',
      'Alethe Orchestra/z.md',
      'Ferramentas/build.md',
      'Raiz.md',
    ].map((path, i) => ({ path, score: 10 - i, terms: [], contexts: [], inFolder: false }))
    const paths = (max: number) =>
      pickNotes(ranked, max, 'Alethe Orchestra').map((note) => note.path)
    expect(paths(6)).toEqual([
      'Diário/a.md',
      'Diário/b.md',
      'Alethe Orchestra/x.md',
      'Alethe Orchestra/y.md',
      'Alethe Orchestra/z.md',
      'Ferramentas/build.md',
    ])
    // Variety ran out: the best of the rest fill the places, in rank order.
    expect(paths(8)).toEqual(ranked.map((note) => note.path))
    expect(paths(0)).toEqual([])
  })

  it('lifts recently dated notes', () => {
    expect(recency('Diário/Sessão 2026-10-04.md', '2026-10-04')).toBe(1)
    expect(recency('Diário/Sessão 2026-09-19.md', '2026-10-04')).toBeCloseTo(0.5)
    expect(recency('Diário/Sessão 2025-01-01.md', '2026-10-04')).toBe(0)
    expect(recency('Sem data.md', '2026-10-04')).toBe(0)
  })
})

describe('noteSnippets', () => {
  const markdown = [
    '---',
    'tags: [alethe, terminal]',
    '---',
    '# Interface embaralhando',
    'Resumo geral sem termos.',
    '## Causa 1',
    '- O xterm do **terminal** desenha noutra largura que o ConPTY.',
    '## Causa 2',
    'Nada aqui.',
    '```',
    '# not a heading: terminal resize inside code',
    '```',
    '## Decisão',
    '> [!important] Terminal e Alethe: nunca usar tui fullscreen.',
  ].join('\n')

  it('quotes the lines that mention the terms under their headings, in reading order', () => {
    expect(noteSnippets(markdown, ['terminal', 'alethe'], 1_000)).toEqual([
      'Causa 1 › O xterm do **terminal** desenha noutra largura que o ConPTY.',
      'Causa 2 › # not a heading: terminal resize inside code',
      'Decisão › Terminal e Alethe: nunca usar tui fullscreen.',
    ])
  })

  it('keeps the lines with more terms first when space is short', () => {
    expect(noteSnippets(markdown, ['terminal', 'alethe'], 60)).toEqual([
      'Decisão › Terminal e Alethe: nunca usar tui fullscreen.',
    ])
  })

  it('falls back to the opening lines', () => {
    expect(noteSnippets(markdown, ['inexistente'], 1_000)).toEqual([
      'Resumo geral sem termos.',
      'O xterm do **terminal** desenha noutra largura que o ConPTY.',
      'Nada aqui.',
    ])
  })
})

describe('sessionNoteDigest', () => {
  const day = [
    '# 2026-10-04 · Alethe Orchestra',
    '',
    '## Orquestrador — sessão A',
    'Decidimos X.',
    '### 20:36 · Sessao Orchestra iniciada',
    '- Projeto: `C:/x`',
    '## claude-7 · escriba ✅',
    'Escriba grava de fato.',
    '#### 20:49 · Escriba Orchestra · Opala',
    '- **orchestrator** editou `a.md`',
    '## Orquestrador — fechamento',
    'Tudo pronto.',
  ].join('\n')

  it('outlines the day and keeps what the agents wrote, without the scribe logs', () => {
    const digest = sessionNoteDigest(day, 2_000)
    expect(digest).toContain(
      'Seções do dia: Orquestrador — sessão A · claude-7 · escriba ✅ · Orquestrador — fechamento',
    )
    expect(digest).toContain('## claude-7 · escriba ✅\nEscriba grava de fato.')
    expect(digest).toContain('## Orquestrador — fechamento\nTudo pronto.')
    expect(digest).not.toContain('Sessao Orchestra iniciada')
    expect(digest).not.toContain('editou')
    expect(digest).not.toContain('# 2026-10-04 · Alethe Orchestra')
  })

  it('keeps the end of the note within the limit', () => {
    const long = `${day}\n## Final\n${'linha longa da seção final\n'.repeat(400)}`
    const digest = sessionNoteDigest(long, 2_600)
    expect(digest.length).toBeLessThanOrEqual(2_600)
    expect(digest).toMatch(/linha longa da seção final$/)
  })
})

describe('buildContextMarkdown', () => {
  it('heads the block with the time and links every note', () => {
    const markdown = buildContextMarkdown({
      at,
      vaultPath: 'G:\\Meu Drive\\Anotações\\TODO',
      terms: ['alethe'],
      sessionNote: SESSION_NOTE,
      sessionDigest: 'Seções do dia: A',
      notes: [{ path: 'Raiz.md', terms: ['alethe'], snippets: ['uma linha'] }],
    })
    expect(markdown).toMatch(/^# Contexto do Obsidian \(consultado em 2026-10-04 21:40\)\n/)
    expect(markdown).toContain('`G:/Meu Drive/Anotações/TODO`')
    expect(markdown).toContain(
      '## Nota da sessão: [[Alethe Orchestra/2026-10-04 Orchestra|2026-10-04 Orchestra]] (parte final)',
    )
    expect(markdown).toContain('### [[Raiz]]\ntermos: alethe\n- uma linha')
    expect(wikiLink('A/B/Nota.md')).toBe('[[A/B/Nota|Nota]]')
  })

  it('drops the lines of the lowest-ranked notes first and never the links', () => {
    const notes = Array.from({ length: 8 }, (_, i) => ({
      path: `Pasta/Nota ${i}.md`,
      terms: ['x'],
      snippets: Array.from({ length: 10 }, (_, j) => `trecho ${i}.${j} ${'x'.repeat(150)}`),
    }))
    const markdown = buildContextMarkdown({
      at,
      vaultPath: 'G:/V',
      terms: ['x'],
      sessionNote: SESSION_NOTE,
      sessionDigest: null,
      notes,
    })
    expect(markdown.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS)
    for (let i = 0; i < 8; i++) expect(markdown).toContain(`[[Pasta/Nota ${i}|Nota ${i}]]`)
    expect(markdown).toContain('trecho 0.0')
    expect(markdown).not.toContain('trecho 7.0')
    expect(markdown).toContain('Ainda não existe')
  })
})

describe('settleWithin', () => {
  afterEach(() => vi.useRealTimers())

  it('settles with the value, the error or a timeout, and never rejects', async () => {
    await expect(settleWithin(() => Promise.resolve(1), 100)).resolves.toEqual({
      ok: true,
      value: 1,
    })
    await expect(settleWithin(() => Promise.reject('nope'), 100)).resolves.toEqual({
      ok: false,
      error: 'nope',
      timeout: false,
    })
    const run = vi.fn(() => Promise.resolve(1))
    await expect(settleWithin(run, 0)).resolves.toMatchObject({ ok: false, timeout: true })
    expect(run).not.toHaveBeenCalled()
    vi.useFakeTimers()
    const pending = settleWithin(() => new Promise<number>(() => {}), 500)
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toMatchObject({ ok: false, timeout: true })
  })
})

describe('gatherObsidianContext', () => {
  afterEach(() => vi.useRealTimers())

  const request: ContextRequest = {
    at,
    subject: { projectName: 'Alethe', goal: 'Corrigir o terminal', cwd: 'C:/repo/alethe' },
    vaultPath: 'G:\\Vault',
    sessionNote: SESSION_NOTE,
    maxNotes: 3,
  }

  const DAY_NOTE = '# Dia\n## claude-1 · terminal\nDecidimos manter o ConPTY.\n'
  const NOTES: Record<string, string> = {
    'Ferramentas/Interface embaralhando no Alethe.md':
      '## Causas\n- O terminal desenha numa largura e o xterm exibe noutra.',
    // "terminais" does not contain "terminal": the plural would not match.
    'Alethe Orchestra/2026-10-04 Frota v2.md': '## Feedback\n- O terminal tem muitos bugs.',
  }

  /** A vault that answers everything, with call logs. */
  function vault(overrides: Partial<ContextDeps> = {}) {
    const deps = {
      search: vi.fn(async (query: string) =>
        query === 'terminal'
          ? result([
              hit(SESSION_NOTE, 40),
              hit('Ferramentas/Interface embaralhando no Alethe.md', 9),
            ])
          : query === 'alethe'
            ? result([hit('Ferramentas/Interface embaralhando no Alethe.md', 2)], 30)
            : result([]),
      ),
      read: vi.fn(async (path: string, tail: boolean) => {
        if (path === SESSION_NOTE) {
          expect(tail).toBe(true)
          return note(path, DAY_NOTE)
        }
        if (NOTES[path]) return note(path, NOTES[path])
        throw 'note not found: ' + path
      }),
      list: vi.fn(async () => ['2026-10-04 Frota v2.md', '2026-10-04 Orchestra.md', 'Sub/']),
      write: vi.fn(async (_markdown: string) => 'C:\\Temp\\alethe-orchestra\\context-oabc1234.md'),
      ...overrides,
    }
    return deps
  }

  it('reads the session note, ranks the related notes and writes the block', async () => {
    const deps = vault()
    const context = await gatherObsidianContext(request, deps)

    expect(deps.search.mock.calls.map((call) => call[0])).toEqual(['alethe', 'terminal'])
    expect(deps.list).toHaveBeenCalledWith('Alethe Orchestra')
    expect(context).toMatchObject({
      status: 'ready',
      file: 'C:\\Temp\\alethe-orchestra\\context-oabc1234.md',
      terms: ['alethe', 'terminal'],
      failure: null,
    })
    expect(context.notes.map((n) => [n.kind, n.title])).toEqual([
      ['session', '2026-10-04 Orchestra'],
      ['search', 'Interface embaralhando no Alethe'],
      ['folder', '2026-10-04 Frota v2'],
    ])
    const markdown = deps.write.mock.calls[0][0]
    expect(markdown).toMatch(/^# Contexto do Obsidian \(consultado em 2026-10-04 21:40\)/)
    expect(markdown).toContain('Decidimos manter o ConPTY.')
    expect(markdown).toContain(
      '### [[Ferramentas/Interface embaralhando no Alethe|Interface embaralhando no Alethe]]',
    )
    expect(markdown).toContain('- Causas › O terminal desenha numa largura e o xterm exibe noutra.')
    expect(markdown).toContain('- Feedback › O terminal tem muitos bugs.')
    expect(context.chars).toBe(markdown.length)
    expect(markdown.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS)
  })

  it('fails fast with the reason when Obsidian is closed, and writes nothing', async () => {
    const down = () => Promise.reject('Obsidian is not reachable (is the app open?)')
    const deps = vault({ search: vi.fn(down), read: vi.fn(down), list: vi.fn(down) })
    const context = await gatherObsidianContext(request, deps)
    expect(context).toMatchObject({
      status: 'failed',
      failure: 'unreachable',
      detail: 'Obsidian is not reachable (is the app open?)',
      file: null,
    })
    expect(deps.write).not.toHaveBeenCalled()
  })

  it('uses what answered within the budget and starts nothing after it', async () => {
    vi.useFakeTimers()
    const deps = vault({ search: vi.fn(() => new Promise<ObsidianSearchResult>(() => {})) })
    const pending = gatherObsidianContext(request, deps)
    await vi.advanceTimersByTimeAsync(CONTEXT_BUDGET_MS)
    const context = await pending

    expect(context.status).toBe('ready')
    expect(context.elapsedMs).toBeLessThanOrEqual(CONTEXT_BUDGET_MS)
    // The searches never answered: the session note and the folder note are what arrived.
    expect(context.notes.map((n) => n.kind)).toEqual(['session', 'folder'])
    // No time was left to read the folder note: nothing starts after the deadline.
    expect(deps.read.mock.calls.map((call) => call[0])).toEqual([SESSION_NOTE])
    expect(deps.write).toHaveBeenCalledTimes(1)
  })

  it('times out when nothing answers', async () => {
    vi.useFakeTimers()
    const never = () => new Promise<never>(() => {})
    const deps = vault({ search: vi.fn(never), read: vi.fn(never), list: vi.fn(never) })
    const pending = gatherObsidianContext(request, deps)
    await vi.advanceTimersByTimeAsync(CONTEXT_BUDGET_MS)
    await expect(pending).resolves.toMatchObject({ status: 'failed', failure: 'timeout' })
    expect(deps.write).not.toHaveBeenCalled()
  })

  it('still writes a block on the first session of the day, with no notes found', async () => {
    const deps = vault({
      search: vi.fn(async () => result([])),
      list: vi.fn(async () => []),
    })
    const context = await gatherObsidianContext(
      { ...request, sessionNote: 'Alethe Orchestra/2026-10-05 Orchestra.md' },
      deps,
    )
    expect(context).toMatchObject({ status: 'ready', notes: [] })
    expect(deps.write.mock.calls[0][0]).toContain('Ainda não existe (primeira sessão do dia)')
    expect(deps.write.mock.calls[0][0]).toContain('Nenhuma nota encontrada para estes termos.')
  })

  it('reports a failed write with the notes it had read', async () => {
    const deps = vault({ write: vi.fn(() => Promise.reject('disk full')) })
    const context = await gatherObsidianContext(request, deps)
    expect(context).toMatchObject({ status: 'failed', failure: 'write', detail: 'disk full' })
    expect(context.notes).toHaveLength(3)
  })

  it('keeps the block within the size limit however long the notes are', async () => {
    const huge = Array.from({ length: 600 }, (_, i) => `- terminal alethe linha ${i}`).join('\n')
    const deps = vault({
      search: vi.fn(async (query: string) =>
        result(Array.from({ length: 12 }, (_, i) => hit(`N/${query} ${i}.md`, 5))),
      ),
      read: vi.fn(async (path: string) => note(path, `${'## Seção\n'}${huge}`)),
    })
    await gatherObsidianContext({ ...request, maxNotes: 12 }, deps)
    expect(deps.write.mock.calls[0][0].length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS)
  })
})
