/** localStorage key of the Alerts switch: '0' silences the notices, anything else keeps them. */
export const ALERTS_STORAGE_KEY = 'orchestra.attention.alerts'

/** On by default; storage errors keep the notices on. */
export function readAlertsEnabled(): boolean {
  try {
    return localStorage.getItem(ALERTS_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeAlertsEnabled(on: boolean): void {
  try {
    localStorage.setItem(ALERTS_STORAGE_KEY, on ? '1' : '0')
  } catch {
    // Unavailable storage: the switch still applies until the app restarts.
  }
}

/**
 * How long blocks and silences may last before the user is told anyway (Preferences >
 * Terminal & agents). Minutes; `repeat` 0 means a long block is announced once.
 */
export type EscalationPrefs = {
  /** A blocked agent is announced even with its session on screen after this long. */
  thresholdMin: number
  /** And again every this long while it stays blocked. */
  repeatMin: number
  /** A busy agent with no output and no report for this long shows as "stalled?". */
  stallMin: number
}

export const ESCALATION_STORAGE_KEY = 'orchestra.attention.escalation'
export const ESCALATION_DEFAULTS: EscalationPrefs = {
  thresholdMin: 10,
  repeatMin: 30,
  stallMin: 15,
}
export const ESCALATION_LIMITS = {
  thresholdMin: { min: 1, max: 240 },
  repeatMin: { min: 0, max: 720 },
  stallMin: { min: 2, max: 240 },
} as const

function clamp(value: unknown, key: keyof EscalationPrefs): number {
  const { min, max } = ESCALATION_LIMITS[key]
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN
  return Number.isNaN(n) ? ESCALATION_DEFAULTS[key] : Math.min(max, Math.max(min, n))
}

/** Saved values, each within its limits; defaults for anything missing or broken. */
export function readEscalation(): EscalationPrefs {
  let saved: Partial<EscalationPrefs>
  try {
    saved = JSON.parse(localStorage.getItem(ESCALATION_STORAGE_KEY) ?? '{}') ?? {}
  } catch {
    saved = {}
  }
  return {
    thresholdMin: clamp(saved.thresholdMin, 'thresholdMin'),
    repeatMin: clamp(saved.repeatMin, 'repeatMin'),
    stallMin: clamp(saved.stallMin, 'stallMin'),
  }
}

export function writeEscalation(prefs: EscalationPrefs): EscalationPrefs {
  const clean: EscalationPrefs = {
    thresholdMin: clamp(prefs.thresholdMin, 'thresholdMin'),
    repeatMin: clamp(prefs.repeatMin, 'repeatMin'),
    stallMin: clamp(prefs.stallMin, 'stallMin'),
  }
  try {
    localStorage.setItem(ESCALATION_STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Unavailable storage: the defaults apply after a restart.
  }
  return clean
}
