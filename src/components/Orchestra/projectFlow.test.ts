import { describe, expect, it } from 'vitest'

import type { OrchestraSession } from '../../stores/orchestraStore'
import { latestSessionOf, sessionForProject } from './projectFlow'

/** Only the fields the decision reads. */
function stateWith(projects: Record<string, string | null>, recent: string[]) {
  const sessions: Record<string, OrchestraSession> = {}
  for (const [id, projectId] of Object.entries(projects)) {
    sessions[id] = { id, projectId } as OrchestraSession
  }
  return { sessions, recent }
}

describe('sessionForProject', () => {
  // IA runs two orchestrations, Opala none, Shop one; ia-old was focused before ia-new.
  const state = stateWith({ 'ia-old': 'ia', 'ia-new': 'ia', shop: 'shop' }, [
    'shop',
    'ia-old',
    'ia-new',
  ])

  it("shows the project's most recently focused orchestration", () => {
    expect(sessionForProject(state, 'ia')).toBe('ia-old')
    expect(sessionForProject(state, 'shop')).toBe('shop')
  })

  it('shows the start screen for a project without one, never another project', () => {
    expect(sessionForProject(state, 'opala')).toBeNull()
  })

  it('keeps the view as it is without a project in the sidebar', () => {
    expect(sessionForProject(state, null)).toBeUndefined()
  })

  it('skips sessions that already stopped', () => {
    const stale = stateWith({ 'ia-new': 'ia' }, ['ia-old', 'ia-new'])
    expect(sessionForProject(stale, 'ia')).toBe('ia-new')
  })
})

describe('latestSessionOf', () => {
  it('matches sessions without a project among themselves', () => {
    const state = stateWith({ a: null, b: 'p1', c: null }, ['b', 'c', 'a'])
    expect(latestSessionOf(state, null)).toBe('c')
    expect(latestSessionOf(state, 'p2')).toBeNull()
  })
})
