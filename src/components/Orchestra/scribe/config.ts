import { create } from 'zustand'

import { DEFAULT_DIARY_PATTERN } from './notePath'

export type ScribeConfig = {
  enabled: boolean
  /** Absolute path of the Obsidian vault. */
  vaultPath: string
  /** Vault-relative folder of the agents' session note (where each agent records its part). */
  folder: string
  /** That note's name without `.md`; `{date}` becomes the local YYYY-MM-DD. */
  noteName: string
  /** Appends the "consult and record in Obsidian" rule to every orchestrator/worker prompt. */
  injectRule: boolean
  /**
   * Consults the vault before a session's orchestrator starts (session note, Orchestra folder,
   * related notes) and tells every agent to read that context first.
   */
  consultContext: boolean
  /** Related notes the consultation keeps, besides the session note. */
  contextNotes: number
  /**
   * The author turns the session's material into notes in the owner's pattern. Off until the
   * owner turns it on: every pass runs Claude Code on an account and spends its usage.
   */
  authorEnabled: boolean
  /** Account the author runs on: '' = the session's, 'default' = Claude's own, else an id. */
  authorAccount: string
  /** Model of the author: '' = the session's. */
  authorModel: string
  /** Effort of the author: '' = the session's. */
  authorEffort: string
  /** Also write when a worker finishes (after the quiet period below); off by default. */
  authorOnWorkerDone: boolean
  /** Final pass when the session ends (or the app closes with it running). */
  authorOnSessionEnd: boolean
  /** Quiet period after a worker finishes, so a burst of completions makes one run. */
  authorDelaySec: number
  /** An author run is stopped after this long. */
  authorTimeoutMin: number
  /** Turns (tool calls and answers) one run may take. */
  authorMaxTurns: number
  /** Spending ceiling of one run, in US dollars as the CLI estimates it; 0 = none. */
  authorMaxBudgetUsd: number
  /** Path pattern of the session's diary note (see `notePath.ts` for the tokens). */
  diaryPattern: string
  /** Folder for a subject note when no related note suggests one ('' = the author decides). */
  topicFolder: string
  /** The owner's note template, read live on every run. */
  templatePath: string
  /** The owner's rules for writing notes, read live on every run ('' = none). */
  rulesNotePath: string
  /** A good note shown to the author as an example ('' = none). */
  examplePath: string
}

export const DEFAULT_SCRIBE_CONFIG: ScribeConfig = {
  enabled: true,
  vaultPath: '',
  folder: 'Alethe Orchestra',
  noteName: '{date} Orchestra',
  injectRule: true,
  consultContext: true,
  contextNotes: 6,
  authorEnabled: false,
  authorAccount: '',
  authorModel: '',
  authorEffort: '',
  authorOnWorkerDone: false,
  authorOnSessionEnd: true,
  authorDelaySec: 120,
  authorTimeoutMin: 12,
  authorMaxTurns: 40,
  authorMaxBudgetUsd: 5,
  diaryPattern: DEFAULT_DIARY_PATTERN,
  topicFolder: '',
  templatePath: 'Diário/_Template - Sessão diária.md',
  rulesNotePath:
    'Ferramentas/Inteligência Artificial/IA de texto/Claude/Claude + Obsidian - Preferências e regras de uso.md',
  examplePath: 'Diário/2026/10 - Outubro/Sessão 2026-10-03 — Alethe travando em sessão RDP.md',
}

export const MIN_CONTEXT_NOTES = 1
export const MAX_CONTEXT_NOTES = 12
export const MIN_AUTHOR_DELAY_SEC = 30
export const MAX_AUTHOR_DELAY_SEC = 1_800
export const MIN_AUTHOR_TIMEOUT_MIN = 2
export const MAX_AUTHOR_TIMEOUT_MIN = 45
export const MIN_AUTHOR_TURNS = 5
export const MAX_AUTHOR_TURNS = 200
export const MAX_AUTHOR_BUDGET_USD = 50

const CONFIG_KEY = 'orchestra.scribe.config'
const KEYS = Object.keys(DEFAULT_SCRIBE_CONFIG) as (keyof ScribeConfig)[]

function load(): ScribeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ScribeConfig>
      const merged = { ...DEFAULT_SCRIBE_CONFIG }
      for (const key of KEYS) {
        // A stored value of another type (an older build, a hand edit) keeps the default.
        if (saved[key] !== undefined && typeof saved[key] === typeof DEFAULT_SCRIBE_CONFIG[key])
          (merged as Record<string, unknown>)[key] = saved[key]
      }
      return merged
    }
  } catch {
    // Unreadable storage falls back to the defaults.
  }
  return DEFAULT_SCRIBE_CONFIG
}

type ScribeConfigState = ScribeConfig & { update: (patch: Partial<ScribeConfig>) => void }

export const useScribeConfig = create<ScribeConfigState>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch)
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(getScribeConfig(get())))
    } catch {
      // The setting still applies for this run.
    }
  },
}))

export function getScribeConfig(
  state: ScribeConfigState = useScribeConfig.getState(),
): ScribeConfig {
  const config = {} as Record<string, unknown>
  for (const key of KEYS) config[key] = state[key]
  return config as ScribeConfig
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** The related-note limit as a whole number in range, whatever was stored. */
export function contextNoteLimit(config: Pick<ScribeConfig, 'contextNotes'>): number {
  return clampInt(
    config.contextNotes,
    MIN_CONTEXT_NOTES,
    MAX_CONTEXT_NOTES,
    DEFAULT_SCRIBE_CONFIG.contextNotes,
  )
}

/** The author's quiet period in milliseconds, in range. */
export function authorDelayMs(config: Pick<ScribeConfig, 'authorDelaySec'>): number {
  return (
    clampInt(
      config.authorDelaySec,
      MIN_AUTHOR_DELAY_SEC,
      MAX_AUTHOR_DELAY_SEC,
      DEFAULT_SCRIBE_CONFIG.authorDelaySec,
    ) * 1000
  )
}

/** The author's turn ceiling, in range. */
export function authorMaxTurns(config: Pick<ScribeConfig, 'authorMaxTurns'>): number {
  return clampInt(
    config.authorMaxTurns,
    MIN_AUTHOR_TURNS,
    MAX_AUTHOR_TURNS,
    DEFAULT_SCRIBE_CONFIG.authorMaxTurns,
  )
}

/** The author's spending ceiling in US dollars (0 = none), in range. */
export function authorMaxBudget(config: Pick<ScribeConfig, 'authorMaxBudgetUsd'>): number {
  const value = Number(config.authorMaxBudgetUsd)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_AUTHOR_BUDGET_USD, Math.round(value * 100) / 100)
}

/** The author's time limit in seconds, in range. */
export function authorTimeoutSecs(config: Pick<ScribeConfig, 'authorTimeoutMin'>): number {
  return (
    clampInt(
      config.authorTimeoutMin,
      MIN_AUTHOR_TIMEOUT_MIN,
      MAX_AUTHOR_TIMEOUT_MIN,
      DEFAULT_SCRIBE_CONFIG.authorTimeoutMin,
    ) * 60
  )
}

export function localDate(at: number = Date.now()): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Vault-relative path of the day's agents' session note. */
export function notePathFor(config: ScribeConfig, at: number = Date.now()): string {
  const name = (config.noteName.trim() || DEFAULT_SCRIBE_CONFIG.noteName)
    .replace(/\{date\}/g, localDate(at))
    .replace(/[\\/:*?"<>|]/g, '-')
  const folder = config.folder
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
  return `${folder ? `${folder}/` : ''}${name}.md`
}

export function scribeReady(config: ScribeConfig): boolean {
  return config.enabled && config.vaultPath.trim().length > 0
}
