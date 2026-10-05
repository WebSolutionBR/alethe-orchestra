import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }))

vi.mock('../../../lib/tauri', () => ({
  spawnPty: vi.fn(() => Promise.resolve({ id: '' })),
  killPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  listenPtyExit: vi.fn(() => Promise.resolve(() => {})),
  openInBrowser: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../lib/tauri/orchestra', () => ({
  orchestraReset: vi.fn(() => Promise.resolve()),
  orchestraEnd: vi.fn(() => Promise.resolve()),
  orchestraPrepare: vi.fn(() => Promise.reject(new Error('not in tests'))),
  listenOrchestra: vi.fn(() => Promise.resolve(() => {})),
}))

// The store installs the scribe on load; it must never reach a real vault.
vi.mock('../scribe/api', () => ({
  obsidianAppend: vi.fn(() => Promise.resolve()),
  obsidianDetectVaults: vi.fn(() => Promise.resolve([])),
  obsidianStatus: vi.fn(() => Promise.reject(new Error('not in tests'))),
}))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { useProjectsStore } from '../../../stores/projectsStore'
import { SCRIBE_ID } from '../scribe/identity'
import { agentColor, areaOf } from '../shared'
import { CreativeMark } from './CreativeMark'
import { CreativeToggle } from './CreativeToggle'
import { CREATIVE_AREA, CREATIVE_STORAGE_KEY } from './role'

beforeEach(() => {
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'en' } }))
})

afterEach(() => {
  localStorage.clear()
})

describe('agentColor with the creative area', () => {
  it('paints a creative worker with the creative token', () => {
    expect(agentColor('claude-3', CREATIVE_AREA)).toBe('var(--agent-creative)')
    expect(agentColor('claude-3', 'Criativo')).toBe('var(--agent-creative)')
  })

  it('keeps every other color as it was', () => {
    expect(agentColor('claude-3')).toBe('var(--agent-claude)')
    expect(agentColor('claude-3', 'ui')).toBe('var(--agent-claude)')
    expect(agentColor('orchestrator', CREATIVE_AREA)).toBe('var(--agent-codex)')
    expect(agentColor('you')).toBe('var(--fg)')
    expect(agentColor(SCRIBE_ID)).toBe('var(--agent-obsidian)')
  })

  it('finds the area of a bus party by id', () => {
    const agents = [
      { id: 'orchestrator', area: 'orchestrator' },
      { id: 'claude-1', area: 'ui' },
      { id: 'claude-2', area: CREATIVE_AREA },
    ]
    expect(areaOf(agents, 'claude-2')).toBe(CREATIVE_AREA)
    expect(agentColor('claude-2', areaOf(agents, 'claude-2'))).toBe('var(--agent-creative)')
    expect(agentColor('claude-1', areaOf(agents, 'claude-1'))).toBe('var(--agent-claude)')
    expect(areaOf(agents, 'all')).toBeUndefined()
  })
})

describe('creative color tokens', () => {
  // Read from disk (vitest runs from the repo root): it stubs CSS imports, `?raw` included.
  const themeCss = readFileSync(resolve(process.cwd(), 'src/styles/theme.css'), 'utf8')
  const blocks = [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }))

  it('exist in every theme block that defines agent colors, and in light', () => {
    const themed = blocks.filter(
      (b) => /--agent-claude\s*:/.test(b.body) || /\[data-theme='light'\]/.test(b.selector),
    )
    expect(themed.length).toBeGreaterThanOrEqual(13)
    for (const block of themed) {
      expect(block.body, block.selector).toMatch(/--agent-creative\s*:\s*#[0-9a-f]{6}\s*;/i)
      expect(block.body, block.selector).toMatch(/--agent-creative-soft\s*:\s*rgba\(/)
    }
  })
})

describe('CreativeToggle', () => {
  it('starts on, with an accessible name and description', () => {
    render(<CreativeToggle />)
    const toggle = screen.getByRole('switch', { name: 'Creative agent' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAccessibleDescription(/builds only what the orchestrator approves/)
  })

  it('remembers the choice for the next orchestrator', () => {
    render(<CreativeToggle />)
    const toggle = screen.getByRole('switch', { name: 'Creative agent' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(localStorage.getItem(CREATIVE_STORAGE_KEY)).toBe('0')
    expect(toggle).toHaveAccessibleDescription(/task workers only/)
    fireEvent.click(toggle)
    expect(localStorage.getItem(CREATIVE_STORAGE_KEY)).toBe('1')
  })

  it('reads a stored off', () => {
    localStorage.setItem(CREATIVE_STORAGE_KEY, '0')
    render(<CreativeToggle />)
    expect(screen.getByRole('switch', { name: 'Creative agent' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('speaks Portuguese too', () => {
    useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, language: 'pt-BR' } }))
    render(<CreativeToggle />)
    expect(screen.getByRole('switch', { name: 'Agente criativo' })).toBeInTheDocument()
  })
})

describe('CreativeMark', () => {
  it('marks only the creative area', () => {
    const { container, rerender } = render(<CreativeMark area="ui" />)
    expect(container).toBeEmptyDOMElement()
    rerender(<CreativeMark area={CREATIVE_AREA} />)
    expect(screen.getByRole('img', { name: 'Creative agent' })).toBeInTheDocument()
    rerender(<CreativeMark area={CREATIVE_AREA} withLabel />)
    expect(screen.getByText('creative')).toBeInTheDocument()
  })
})
