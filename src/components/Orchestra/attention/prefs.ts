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
