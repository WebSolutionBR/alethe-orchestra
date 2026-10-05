import { describe, expect, it } from 'vitest'

import {
  ABSENT,
  type AuthorInput,
  buildAuthorPrompt,
  buildVaultIndex,
  contentHash,
  hasScribeMarker,
  headingPath,
  parseAuthorPlan,
  type PrepareContext,
  preparePlan,
  pruneLinks,
  safeNotePath,
  sectionIsLast,
  topHeading,
  withRelatedClosing,
  withScribeMarker,
} from './author'
import { REDACTED } from './redact'

const now = new Date(2026, 9, 4, 23, 10).getTime()
const DIARY = 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Escriba v2.md'

function input(patch: Partial<AuthorInput> = {}): AuthorInput {
  return {
    now,
    trigger: 'worker-done',
    finished: ['claude-7'],
    final: false,
    session: {
      id: 'oabc1234',
      goal: 'Melhorar o Alethe Orchestra',
      cwd: 'C:/Users/Profile/Documents/Alethe/Sistemas_e_autromacoes',
      projectName: 'Sistemas e automações',
      startedAt: new Date(2026, 9, 4, 20, 0).getTime(),
      endedAt: null,
    },
    agents: [
      {
        id: 'claude-7',
        area: 'escriba-v2',
        state: 'done',
        progress: 100,
        task: 'Leia a tarefa em C:/tarefas/claude-7-escriba-v2.md',
        note: 'escriba refeito',
        transcriptPath: 'C:/Users/Profile/.claude/projects/x/abc.jsonl',
        history: [],
      },
    ],
    vaultPath: 'G:/Meu Drive/Anotações/TODO',
    workNote: 'Alethe Orchestra/2026-10-04 Orchestra.md',
    diary: { path: DIARY, current: null, folder: 'Diário/2026/10 - Outubro', todayNotes: [] },
    template: {
      path: 'Diário/_Template - Sessão diária.md',
      content: '## Resumo do dia\n## Casos / atividades',
      live: true,
    },
    rules: { path: 'Regras.md', content: '# Regras\nDatas DD/MM/AAAA' },
    example: { path: 'Exemplo.md', content: '# Sessão exemplo\n## Pontos-chave / decisões' },
    contextNotes: ['Ferramentas/Inteligência Artificial/Alethe.md'],
    sources: [
      {
        path: 'C:/tarefas/claude-7-escriba-v2.md',
        content: '# Tarefa\nAPI_KEY=abc12345 fazer o escriba',
        truncated: false,
      },
    ],
    material: '20:05 · done · claude-7 · escriba refeito',
    topicFolder: '',
    mcp: true,
    ...patch,
  }
}

describe('buildAuthorPrompt', () => {
  it('carries the template, the rules, the example, the material and the session', () => {
    const prompt = buildAuthorPrompt(input())
    expect(prompt).toContain('read live from "Diário/_Template - Sessão diária.md"')
    expect(prompt).toContain('## Casos / atividades')
    expect(prompt).toContain('Datas DD/MM/AAAA')
    expect(prompt).toContain('# Sessão exemplo')
    expect(prompt).toContain('20:05 · done · claude-7 · escriba refeito')
    expect(prompt).toContain('- Objetivo: Melhorar o Alethe Orchestra')
    expect(prompt).toContain(
      '- Pasta: C:\\Users\\Profile\\Documents\\Alethe\\Sistemas_e_autromacoes',
    )
    expect(prompt).toContain('- Início: 04/10/2026 20:00')
    expect(prompt).toContain('[[Alethe]]')
    // Transcripts are named by their copy in the author's folder, never by their real path.
    expect(prompt).toContain('| transcripts/claude-7.jsonl |')
    expect(prompt).not.toContain('.claude')
    expect(prompt).toContain('Nothing else on this computer is readable.')
    expect(prompt).toContain('Worker(s) claude-7 just finished')
  })

  it('states the rules on language, links, secrets, closing section and no deletion', () => {
    const prompt = buildAuthorPrompt(input())
    expect(prompt).toContain('Write in Brazilian Portuguese. Dates in the text as DD/MM/AAAA')
    expect(prompt).toContain('only for notes that exist in the vault')
    expect(prompt).toContain('Never invent a note name')
    expect(prompt).toContain('# Notas relacionadas` (H1, exactly this text)')
    expect(prompt).toContain('Never write secrets')
    expect(prompt).toContain('cannot delete anything')
    expect(prompt).toContain('Knowledge, never a log')
    expect(prompt).toContain('=== NOTE path="@diary" mode="full" ===')
  })

  it('masks secrets in the task files it quotes', () => {
    const prompt = buildAuthorPrompt(input())
    expect(prompt).toContain(`API_KEY=${REDACTED} fazer o escriba`)
    expect(prompt).not.toContain('abc12345')
  })

  it('asks for a final pass and shows the existing diary note', () => {
    const final = buildAuthorPrompt(
      input({
        trigger: 'session-end',
        final: true,
        diary: {
          path: DIARY,
          current: { content: '# Sessão\n## Resumo do dia\nok', truncated: false },
          folder: 'Diário/2026/10 - Outubro',
          todayNotes: [],
        },
      }),
    )
    expect(final).toContain('This is the final pass')
    expect(final).toContain('It already exists. Rewrite it whole')
    expect(final).toContain('# Sessão\n## Resumo do dia\nok')
  })

  it('points to same-day notes so it adds to them instead of duplicating', () => {
    const prompt = buildAuthorPrompt(
      input({
        diary: {
          path: 'Diário/2026/10 - Outubro/Sessão 2026-10-04 — {title}.md',
          current: null,
          folder: 'Diário/2026/10 - Outubro',
          todayNotes: ['Diário/2026/10 - Outubro/Sessão 2026-10-04 — Opala.md'],
        },
      }),
    )
    expect(prompt).toContain('[[Sessão 2026-10-04 — Opala]]')
    expect(prompt).toContain('do not create a duplicate')
    expect(prompt).toContain('The app names it from your TITLE')
  })

  it('falls back to the built-in template and says so', () => {
    const prompt = buildAuthorPrompt(
      input({
        template: { path: 'T.md', content: '# T', live: false },
        rules: null,
        example: null,
      }),
    )
    expect(prompt).toContain('built-in copy; the vault template could not be read')
    expect(prompt).not.toContain("The owner's rules for notes")
  })
})

const ANSWER = `Vou escrever.
=== TITLE ===
Escriba v2 do Alethe Orchestra
=== END ===
=== SUMMARY ===
Caso do escriba v2 registrado
=== END ===
=== NOTE path="@diary" mode="full" ===
---
tags: [diario, sessao, claude]
data: 2026-10-04
---

# Sessão 2026-10-04 — Escriba v2

## Resumo do dia
O escriba deixou de gravar log. Ver [[Alethe]] e [[Nota que não existe]].

---

# Notas relacionadas
- [[Alethe]] — hub
=== END ===
=== NOTE path="Ferramentas/Inteligência Artificial/Alethe Orchestra - escriba.md" mode="full" ===
# Alethe Orchestra - escriba
Ligado a [[@diary]].
=== END ===
=== NOTE path="Diário/2026/10 - Outubro/Sessão 2026-10-04 — Opala.md" mode="section" heading="Casos / atividades" ===
### Escriba
- **Contexto / pedido:** token=abc12345
=== END ===
=== HUB path="Ferramentas/Inteligência Artificial/Alethe.md" heading="Relacionados" ===
- [[Alethe Orchestra - escriba]] — nota nova
- [[@diary]] — diário
- [[Inexistente]] — some
=== END ===
`

const INDEX = buildVaultIndex([
  'Ferramentas/Inteligência Artificial/Alethe.md',
  'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Opala.md',
  'Imagens/print.png',
])

function context(patch: Partial<PrepareContext> = {}): PrepareContext {
  return {
    diaryPath: DIARY,
    diaryFolder: 'Diário/2026/10 - Outubro',
    diaryExpect: ABSENT,
    diaryAppendOnly: false,
    index: INDEX,
    protectedPaths: ['Diário/_Template - Sessão diária.md'],
    ...patch,
  }
}

describe('the write plan', () => {
  it('reads every block of the answer', () => {
    const plan = parseAuthorPlan(ANSWER)!
    expect(plan.title).toBe('Escriba v2 do Alethe Orchestra')
    expect(plan.summary).toBe('Caso do escriba v2 registrado')
    expect(plan.notes.map((n) => [n.path, n.mode, n.heading])).toEqual([
      ['@diary', 'full', null],
      ['Ferramentas/Inteligência Artificial/Alethe Orchestra - escriba.md', 'full', null],
      ['Diário/2026/10 - Outubro/Sessão 2026-10-04 — Opala.md', 'section', 'Casos / atividades'],
    ])
    expect(plan.hubs[0].lines).toHaveLength(3)
    expect(parseAuthorPlan('no plan here')).toBeNull()
    // CRLF and a missing final END still parse.
    expect(parseAuthorPlan('=== SUMMARY ===\r\nok')?.summary).toBe('ok')
  })

  it('turns the plan into checked writes', () => {
    const prepared = preparePlan(parseAuthorPlan(ANSWER)!, context())
    const [diary, topic, section, hub] = prepared.ops
    expect(prepared.sessionNote).toBe(DIARY)
    // The diary note: marker added, missing link unlinked, expected absent.
    expect(diary).toMatchObject({ kind: 'put', notePath: DIARY, expect: ABSENT, diary: true })
    if (diary.kind !== 'put') throw new Error('diary')
    expect(hasScribeMarker(diary.content)).toBe(true)
    expect(diary.content).toContain('[[Alethe]]')
    expect(diary.content).not.toContain('[[Nota que não existe]]')
    expect(diary.content).toContain('Nota que não existe')
    // The new subject note links to the diary note by its final name and gets the closing.
    if (topic.kind !== 'put') throw new Error('topic')
    expect(topic.content).toContain('[[Sessão 2026-10-04 — Escriba v2]]')
    expect(topic.content).toContain('# Notas relacionadas')
    expect(topic.expect).toBe(ABSENT)
    // A section of the owner's note: appended, secrets masked.
    expect(section).toMatchObject({ kind: 'section', heading: 'Casos / atividades' })
    if (section.kind !== 'section') throw new Error('section')
    expect(section.content).toContain(`token=${REDACTED}`)
    // The hub keeps only lines whose notes exist or are written now, and waits for them.
    expect(hub).toMatchObject({ kind: 'hub', heading: 'Relacionados' })
    if (hub.kind !== 'hub') throw new Error('hub')
    expect(hub.lines).toEqual([
      '- [[Alethe Orchestra - escriba]] — nota nova',
      '- [[Sessão 2026-10-04 — Escriba v2]] — diário',
    ])
    expect(hub.requires).toEqual([
      'Ferramentas/Inteligência Artificial/Alethe Orchestra - escriba.md',
      DIARY,
    ])
    expect(prepared.issues.join(' ')).toContain('Nota que não existe')
    expect(prepared.issues.join(' ')).toContain('Inexistente')
  })

  it('compares the diary note with what the author saw', () => {
    const plan = parseAuthorPlan(ANSWER)!
    const prepared = preparePlan(plan, context({ diaryExpect: 'abcd1234' }))
    expect(prepared.ops[0]).toMatchObject({ kind: 'put', expect: 'abcd1234' })
    // A note too long to show whole may only get sections.
    const appendOnly = preparePlan(
      plan,
      context({ diaryExpect: 'abcd1234', diaryAppendOnly: true }),
    )
    expect(appendOnly.ops.some((op) => op.notePath === DIARY)).toBe(false)
    expect(appendOnly.issues.join(' ')).toContain('longa demais')
  })

  it('refuses paths outside the vault, hidden folders and protected notes', () => {
    const plan = parseAuthorPlan(
      [
        '=== NOTE path="../fora.md" mode="full" ===\nx\n=== END ===',
        '=== NOTE path=".obsidian/plugins/x.md" mode="full" ===\nx\n=== END ===',
        '=== NOTE path="C:/abs.md" mode="full" ===\nx\n=== END ===',
        '=== NOTE path="Diário/_Template - Sessão diária.md" mode="full" ===\nx\n=== END ===',
        '=== NOTE path="nota.txt" mode="full" ===\nx\n=== END ===',
      ].join('\n'),
    )!
    const prepared = preparePlan(plan, context())
    expect(prepared.ops).toEqual([])
    expect(prepared.issues).toHaveLength(5)
    expect(safeNotePath('A/B.md')).toBe('A/B.md')
    expect(safeNotePath('A\\B.md')).toBe('A/B.md')
    expect(safeNotePath('A/../B.md')).toBeNull()
  })

  it('limits how much one pass touches', () => {
    const notes = Array.from(
      { length: 6 },
      (_, i) => `=== NOTE path="Assuntos/N${i}.md" mode="full" ===\n# N${i}\n=== END ===`,
    ).join('\n')
    const prepared = preparePlan(parseAuthorPlan(notes)!, context())
    expect(prepared.ops).toHaveLength(3)
    expect(prepared.issues.some((i) => i.includes('Limite'))).toBe(true)
  })
})

describe('links, markers and headings', () => {
  it('resolves links the way Obsidian does', () => {
    expect(INDEX.has('Alethe')).toBe(true)
    expect(INDEX.has('alethe.md')).toBe(true)
    expect(INDEX.has('Inteligência Artificial/Alethe')).toBe(true)
    expect(INDEX.has('print.png')).toBe(true)
    expect(INDEX.has('Outra')).toBe(false)
    const { text, dropped } = pruneLinks(
      'Ver [[Alethe|o hub]], [[Outra|apelido]], [[Sumida]], [[Alethe#Relacionados]] e ![[nada.png]].',
      INDEX,
    )
    expect(text).toBe('Ver [[Alethe|o hub]], apelido, Sumida, [[Alethe#Relacionados]] e nada.png.')
    expect(dropped).toEqual(['Outra', 'Sumida', 'nada.png'])
    expect(pruneLinks('[[X]]', null).text).toBe('[[X]]')
  })

  it('marks the notes the scribe creates', () => {
    expect(withScribeMarker('# T')).toBe('---\nescriba: alethe-orchestra\n---\n\n# T')
    const front = withScribeMarker('---\ntags: [a]\n---\n\n# T')
    expect(front).toBe('---\ntags: [a]\nescriba: alethe-orchestra\n---\n\n# T')
    expect(hasScribeMarker(front)).toBe(true)
    expect(withScribeMarker(front)).toBe(front)
    expect(hasScribeMarker('# escriba: alethe-orchestra')).toBe(false)
  })

  it('adds the owner closing when a new note forgot it', () => {
    const closed = withRelatedClosing('# N\nVer [[A]] e [[B]] e [[A]].')
    expect(closed).toBe(
      '# N\nVer [[A]] e [[B]] e [[A]].\n\n---\n\n# Notas relacionadas\n- [[A]] — citada nesta nota\n- [[B]] — citada nesta nota\n',
    )
    expect(withRelatedClosing('# N\n# Notas relacionadas\n- [[A]]')).toBe(
      '# N\n# Notas relacionadas\n- [[A]]',
    )
    expect(withRelatedClosing('# N sem links')).toBe('# N sem links')
  })

  it('finds the heading path the REST API wants', () => {
    const note = [
      '---',
      'tags: [x]',
      '---',
      '# Alethe',
      '## 1. Estado',
      '```md',
      '## Relacionados (dentro de código)',
      '```',
      '## Relacionados',
      '- [[A]]',
    ].join('\n')
    expect(headingPath(note, 'relacionados')).toEqual(['Alethe', 'Relacionados'])
    expect(headingPath(note, 'Nada')).toBeNull()
    expect(topHeading(note)).toBe('Alethe')
    expect(sectionIsLast(note, ['Alethe', 'Relacionados'])).toBe(true)
    expect(sectionIsLast(note, ['Alethe', '1. Estado'])).toBe(false)
    expect(
      headingPath('# Sessão\n## Casos\n### Caso 1\n# Notas relacionadas', 'Notas relacionadas'),
    ).toEqual(['Notas relacionadas'])
  })

  it('hashes notes ignoring line endings and trailing spaces', () => {
    expect(contentHash('a\r\nb  \n')).toBe(contentHash('a\nb'))
    expect(contentHash('a')).not.toBe(contentHash('b'))
  })
})
