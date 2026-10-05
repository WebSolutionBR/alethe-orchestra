import { describe, expect, it } from 'vitest'

import {
  brDate,
  DEFAULT_DIARY_PATTERN,
  diaryFolder,
  diaryNamePrefix,
  diaryNotePath,
  explorerPath,
  MONTHS_PT,
  noteName,
  noteTitle,
  titleFromGoal,
} from './notePath'

const at = new Date(2026, 9, 4, 22, 30).getTime()

describe('diary note paths', () => {
  it('follows the owner pattern with Portuguese month names', () => {
    expect(diaryNotePath(DEFAULT_DIARY_PATTERN, at, 'Escriba v2 do Alethe Orchestra')).toBe(
      'Diário/2026/10 - Outubro/Sessão 2026-10-04 — Escriba v2 do Alethe Orchestra.md',
    )
    expect(MONTHS_PT).toHaveLength(12)
    const months = MONTHS_PT.map((_, m) =>
      diaryFolder(DEFAULT_DIARY_PATTERN, new Date(2026, m, 15).getTime()),
    )
    expect(months[0]).toBe('Diário/2026/01 - Janeiro')
    expect(months[2]).toBe('Diário/2026/03 - Março')
    expect(months[11]).toBe('Diário/2026/12 - Dezembro')
  })

  it('accepts other patterns and keeps the path inside the vault', () => {
    expect(diaryNotePath('Notas/{date} {title}', at, 'X')).toBe('Notas/2026-10-04 X.md')
    expect(diaryNotePath('{yyyy}/{mes}/{dd} {title}.md', at, 'X')).toBe('2026/outubro/04 X.md')
    expect(diaryNotePath('../../etc/{title}', at, 'X')).toBe('etc/X.md')
    expect(diaryNotePath('C:/abs/{title}', at, 'X')).toBe('C-/abs/X.md')
    expect(diaryNotePath('.obsidian/{title}', at, 'X')).toBe('X.md')
    expect(diaryNotePath('', at, 'X')).toBe('Diário/2026/10 - Outubro/Sessão 2026-10-04 — X.md')
  })

  it('makes titles safe for file names and wikilinks', () => {
    expect(noteTitle('Corrigir: terminal/xterm [rolagem] #bug?')).toBe(
      'Corrigir terminal xterm rolagem bug',
    )
    expect(noteTitle('a'.repeat(200)).length).toBeLessThanOrEqual(80)
    expect(noteTitle('fim com ponto.')).toBe('fim com ponto')
    expect(diaryNotePath(DEFAULT_DIARY_PATTERN, at, '')).toMatch(/— Sessão\.md$/)
  })

  it('takes a first title from the goal', () => {
    expect(titleFromGoal('Melhorar o Alethe Orchestra. Depois, rolagem e escriba.')).toBe(
      'Melhorar o Alethe Orchestra',
    )
    expect(titleFromGoal('', 'Sistemas e automações')).toBe('Sistemas e automações')
    expect(titleFromGoal('   ')).toBe('Orquestração')
  })

  it('knows where the day notes are and how their names start', () => {
    expect(diaryFolder(DEFAULT_DIARY_PATTERN, at)).toBe('Diário/2026/10 - Outubro')
    expect(diaryNamePrefix(DEFAULT_DIARY_PATTERN, at)).toBe('Sessão 2026-10-04 — ')
    expect(noteName('Diário/2026/10 - Outubro/Sessão 2026-10-04 — X.md')).toBe(
      'Sessão 2026-10-04 — X',
    )
  })

  it('writes dates and paths the way the owner reads them', () => {
    expect(brDate(at)).toBe('04/10/2026')
    expect(explorerPath('C:/Users/Profile/Documents')).toBe('C:\\Users\\Profile\\Documents')
    expect(explorerPath('relative/path')).toBe('relative/path')
  })
})
