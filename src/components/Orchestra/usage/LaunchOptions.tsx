import { useShallow } from 'zustand/react/shallow'

import { useT } from '../../../lib/i18n'
import { type AccountPolicy, EFFORT_CHOICES, MODEL_CHOICES, shortModel } from './launch'
import { useLaunchDefaults } from './launchDefaults'
import styles from './Usage.module.css'
import { useClaudeAccounts } from './UsageBar'

/** Account / model / effort selects for the session defaults (orchestrator + unflagged workers). */
export function LaunchOptionsPicker() {
  const t = useT()
  const accounts = useClaudeAccounts()
  const { policy, account, model, effort, setDefaults } = useLaunchDefaults(
    useShallow((s) => ({
      policy: s.policy,
      account: s.account,
      model: s.model,
      effort: s.effort,
      setDefaults: s.setDefaults,
    })),
  )
  const inherit = t('orchestra.launch.inherit')
  const accountKnown = !account || accounts.some((a) => a.id === account)
  const modelKnown = !model || (MODEL_CHOICES as readonly string[]).includes(model)

  return (
    <div className={styles.launch}>
      <label className={styles.select} title={t(`orchestra.launch.policy.${policy}Hint`)}>
        {t('orchestra.launch.policy')}
        <select
          value={policy}
          onChange={(e) => setDefaults({ policy: e.target.value as AccountPolicy })}
        >
          <option value="single">{t('orchestra.launch.policy.single')}</option>
          <option value="spread">{t('orchestra.launch.policy.spread')}</option>
        </select>
      </label>
      <label className={styles.select}>
        {t('orchestra.launch.account')}
        <select
          value={account ?? ''}
          onChange={(e) => setDefaults({ account: e.target.value || null })}
        >
          <option value="">{t('orchestra.usage.defaultAccount')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {!accountKnown && account ? <option value={account}>{account}</option> : null}
        </select>
      </label>
      <label className={styles.select}>
        {t('orchestra.launch.model')}
        <select
          value={model ?? ''}
          onChange={(e) => setDefaults({ model: e.target.value || null })}
        >
          <option value="">{inherit}</option>
          {MODEL_CHOICES.map((m) => (
            <option key={m} value={m}>
              {shortModel(m)}
            </option>
          ))}
          {!modelKnown && model ? <option value={model}>{shortModel(model)}</option> : null}
        </select>
      </label>
      <label className={styles.select}>
        {t('orchestra.launch.effort')}
        <select
          value={effort ?? ''}
          onChange={(e) => setDefaults({ effort: e.target.value || null })}
        >
          <option value="">{inherit}</option>
          {EFFORT_CHOICES.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
