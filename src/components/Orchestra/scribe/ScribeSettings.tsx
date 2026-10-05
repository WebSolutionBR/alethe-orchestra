import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../../modals/controls.module.css'
import { SettingsSection } from '../../modals/preferences/primitives'
import styles from '../../modals/PreferencesModal.module.css'
import { EFFORT_CHOICES, MODEL_CHOICES } from '../usage/launch'
import {
  obsidianDetectVaults,
  type ObsidianStatus,
  obsidianStatus,
  type ObsidianVault,
} from './api'
import {
  contextNoteLimit,
  MAX_AUTHOR_BUDGET_USD,
  MAX_AUTHOR_DELAY_SEC,
  MAX_AUTHOR_TIMEOUT_MIN,
  MAX_AUTHOR_TURNS,
  MAX_CONTEXT_NOTES,
  MIN_AUTHOR_DELAY_SEC,
  MIN_AUTHOR_TIMEOUT_MIN,
  MIN_AUTHOR_TURNS,
  MIN_CONTEXT_NOTES,
  notePathFor,
  type ScribeConfig,
  useScribeConfig,
} from './config'
import { CONTEXT_BUDGET_MS } from './context'
import { pickVault } from './health'
import { diaryNotePath } from './notePath'
import { scribeRetryNow, useScribeStatus } from './service'
import { SCRIBE_SETTINGS_ID } from './ui'

const NOTE_LIMITS = Array.from(
  { length: MAX_CONTEXT_NOTES - MIN_CONTEXT_NOTES + 1 },
  (_, i) => MIN_CONTEXT_NOTES + i,
)
const NO_ACCOUNTS: never[] = []

export function ScribeSettings() {
  const t = useT()
  const config = useScribeConfig()
  const status = useScribeStatus()
  const accounts = useProjectsStore((s) => s.preferences.claudeAccounts ?? NO_ACCOUNTS)
  const [vaults, setVaults] = useState<ObsidianVault[]>([])
  const [check, setCheck] = useState<ObsidianStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    void obsidianDetectVaults()
      .then((found) => {
        if (disposed) return
        setVaults(found)
        const current = useScribeConfig.getState()
        const picked = pickVault(found)
        if (!current.vaultPath && picked) current.update({ vaultPath: picked })
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])

  // Opened from the scribe chip: bring this section into view.
  useEffect(() => {
    if (useUiStore.getState().modalContext?.focus !== SCRIBE_SETTINGS_ID) return
    const frame = window.requestAnimationFrame(() => {
      const section = document.querySelector<HTMLElement>(
        `[data-setting-id="${SCRIBE_SETTINGS_ID}"]`,
      )
      section?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      section?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const test = async () => {
    setBusy(true)
    try {
      setCheck(await obsidianStatus({ vaultPath: config.vaultPath }))
    } catch (error) {
      setCheck({
        vault_exists: false,
        plugin_found: false,
        has_key: false,
        port: 27124,
        authenticated: false,
        error: String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const segmented = (value: boolean, on: string, off: string, apply: (v: boolean) => void) => (
    <div className={styles.segmented}>
      <button
        type="button"
        className={value ? styles.segmentActive : undefined}
        onClick={() => apply(true)}
      >
        {on}
      </button>
      <button
        type="button"
        className={!value ? styles.segmentActive : undefined}
        onClick={() => apply(false)}
      >
        {off}
      </button>
    </div>
  )

  const text = (label: string, key: keyof ScribeConfig, disabled = false) => (
    <label>
      <span>{label}</span>
      <input
        className={controls.input}
        value={String(config[key])}
        disabled={disabled}
        onChange={(event) => config.update({ [key]: event.target.value } as Partial<ScribeConfig>)}
        spellCheck={false}
      />
    </label>
  )

  const number = (
    label: string,
    key: 'authorDelaySec' | 'authorTimeoutMin' | 'authorMaxTurns' | 'authorMaxBudgetUsd',
    min: number,
    max: number,
    step = 1,
  ) => (
    <label>
      <span>{label}</span>
      <input
        className={controls.input}
        type="number"
        min={min}
        max={max}
        step={step}
        value={config[key]}
        disabled={!config.authorEnabled}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) config.update({ [key]: value } as Partial<ScribeConfig>)
        }}
      />
    </label>
  )

  const authorOff = !config.authorEnabled
  const example = diaryNotePath(
    config.diaryPattern,
    Date.now(),
    t('orchestra.scribe.settings.exampleTitle'),
  )
  // A model set elsewhere (an older choice, a full model id) stays selectable.
  const models: string[] = [...MODEL_CHOICES]
  if (config.authorModel && !models.includes(config.authorModel)) models.push(config.authorModel)

  return (
    <SettingsSection
      id={SCRIBE_SETTINGS_ID}
      title={t('orchestra.scribe.name')}
      description={t('orchestra.scribe.settings.desc')}
    >
      {segmented(
        config.enabled,
        t('orchestra.scribe.settings.on'),
        t('orchestra.scribe.settings.off'),
        (enabled) => config.update({ enabled }),
      )}
      <div className={styles.integrationFields}>
        {vaults.length > 1 ? (
          <label>
            <span>{t('orchestra.scribe.settings.vaultPick')}</span>
            <select
              className={controls.input}
              value={vaults.some((v) => v.path === config.vaultPath) ? config.vaultPath : ''}
              onChange={(event) => config.update({ vaultPath: event.target.value })}
            >
              <option value="" disabled>
                —
              </option>
              {vaults.map((vault) => (
                <option key={vault.path} value={vault.path}>
                  {vault.path}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {text(t('orchestra.scribe.settings.vault'), 'vaultPath')}
        <div className={styles.cliActions}>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={busy || !config.vaultPath.trim()}
            onClick={() => void test()}
          >
            {t('orchestra.scribe.settings.test')}
          </button>
          {status.pending > 0 ? (
            <button type="button" className={controls.btn} onClick={scribeRetryNow}>
              {t('orchestra.scribe.settings.retry')}
            </button>
          ) : null}
        </div>
        {check?.authenticated ? (
          <p>{t('orchestra.scribe.settings.ok', { port: check.port })}</p>
        ) : null}
        {check && !check.authenticated && check.error ? (
          <p className={styles.cliWarning}>{check.error}</p>
        ) : null}
        {status.pending > 0 ? (
          <p>{t('orchestra.scribe.settings.pending', { n: status.pending })}</p>
        ) : null}
        {status.lastError ? (
          <p className={styles.cliWarning}>
            {t('orchestra.scribe.settings.lastError', { error: status.lastError })}
          </p>
        ) : null}
      </div>

      <p>{t('orchestra.scribe.settings.author')}</p>
      <p className={styles.cliPath}>{t('orchestra.scribe.settings.authorDesc')}</p>
      {segmented(
        config.authorEnabled,
        t('orchestra.scribe.settings.authorOn'),
        t('orchestra.scribe.settings.authorOff'),
        (authorEnabled) => config.update({ authorEnabled }),
      )}
      <div className={styles.integrationFields}>
        <label>
          <span>{t('orchestra.scribe.settings.account')}</span>
          <select
            className={controls.input}
            value={config.authorAccount}
            disabled={authorOff}
            onChange={(event) => config.update({ authorAccount: event.target.value })}
          >
            <option value="">{t('orchestra.scribe.settings.accountSession')}</option>
            <option value="default">{t('orchestra.scribe.settings.accountDefault')}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('orchestra.scribe.settings.model')}</span>
          <select
            className={controls.input}
            value={config.authorModel}
            disabled={authorOff}
            onChange={(event) => config.update({ authorModel: event.target.value })}
          >
            <option value="">{t('orchestra.scribe.settings.modelSession')}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('orchestra.scribe.settings.effort')}</span>
          <select
            className={controls.input}
            value={config.authorEffort}
            disabled={authorOff}
            onChange={(event) => config.update({ authorEffort: event.target.value })}
          >
            <option value="">{t('orchestra.scribe.settings.effortSession')}</option>
            {EFFORT_CHOICES.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p>{t('orchestra.scribe.settings.triggers')}</p>
      <p className={styles.cliPath}>{t('orchestra.scribe.settings.onWorkerDone')}</p>
      {segmented(
        config.authorOnWorkerDone,
        t('orchestra.scribe.settings.on'),
        t('orchestra.scribe.settings.off'),
        (authorOnWorkerDone) => config.update({ authorOnWorkerDone }),
      )}
      <p className={styles.cliPath}>{t('orchestra.scribe.settings.onSessionEnd')}</p>
      {segmented(
        config.authorOnSessionEnd,
        t('orchestra.scribe.settings.on'),
        t('orchestra.scribe.settings.off'),
        (authorOnSessionEnd) => config.update({ authorOnSessionEnd }),
      )}
      <div className={styles.integrationFields}>
        <p className={styles.cliPath}>{t('orchestra.scribe.settings.manualHint')}</p>
        {number(
          t('orchestra.scribe.settings.delay'),
          'authorDelaySec',
          MIN_AUTHOR_DELAY_SEC,
          MAX_AUTHOR_DELAY_SEC,
        )}
        {number(
          t('orchestra.scribe.settings.timeout'),
          'authorTimeoutMin',
          MIN_AUTHOR_TIMEOUT_MIN,
          MAX_AUTHOR_TIMEOUT_MIN,
        )}
        {number(
          t('orchestra.scribe.settings.maxTurns'),
          'authorMaxTurns',
          MIN_AUTHOR_TURNS,
          MAX_AUTHOR_TURNS,
        )}
        {number(
          t('orchestra.scribe.settings.maxBudget'),
          'authorMaxBudgetUsd',
          0,
          MAX_AUTHOR_BUDGET_USD,
          0.5,
        )}
        {text(t('orchestra.scribe.settings.diaryPattern'), 'diaryPattern', authorOff)}
        <p className={styles.cliPath}>
          {t('orchestra.scribe.settings.diaryPatternHint', { example })}
        </p>
        {text(t('orchestra.scribe.settings.topicFolder'), 'topicFolder', authorOff)}
        {text(t('orchestra.scribe.settings.template'), 'templatePath', authorOff)}
        {text(t('orchestra.scribe.settings.rules'), 'rulesNotePath', authorOff)}
        {text(t('orchestra.scribe.settings.example'), 'examplePath', authorOff)}
        <p className={styles.cliPath}>{t('orchestra.scribe.settings.liveHint')}</p>
      </div>

      <div className={styles.integrationFields}>
        {text(t('orchestra.scribe.settings.folder'), 'folder')}
        {text(t('orchestra.scribe.settings.note'), 'noteName')}
        <p className={styles.cliPath}>
          {t('orchestra.scribe.settings.target', { path: notePathFor(config) })}
        </p>
      </div>
      <p>{t('orchestra.scribe.settings.rule')}</p>
      {segmented(
        config.injectRule,
        t('orchestra.scribe.settings.ruleOn'),
        t('orchestra.scribe.settings.ruleOff'),
        (injectRule) => config.update({ injectRule }),
      )}
      <p>{t('orchestra.scribe.settings.consult')}</p>
      {segmented(
        config.consultContext,
        t('orchestra.scribe.settings.consultOn'),
        t('orchestra.scribe.settings.consultOff'),
        (consultContext) => config.update({ consultContext }),
      )}
      <div className={styles.integrationFields}>
        <label>
          <span>{t('orchestra.scribe.settings.contextNotes')}</span>
          <select
            className={controls.input}
            value={contextNoteLimit(config)}
            disabled={!config.consultContext}
            onChange={(event) => config.update({ contextNotes: Number(event.target.value) })}
          >
            {NOTE_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.cliPath}>
          {t('orchestra.scribe.settings.consultDesc', {
            seconds: Math.round(CONTEXT_BUDGET_MS / 1000),
          })}
        </p>
      </div>
    </SettingsSection>
  )
}
