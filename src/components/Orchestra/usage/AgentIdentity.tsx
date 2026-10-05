import { useT } from '../../../lib/i18n'
import { shortModel } from './launch'
import styles from './Usage.module.css'
import { useClaudeAccounts } from './UsageBar'

type Props = {
  account?: string | null
  model?: string | null
  effort?: string | null
  className?: string
}

/** Chip "account · model · effort" for an Orchestra agent; unset parts read "default". */
export function AgentIdentity({ account, model, effort, className }: Props) {
  const t = useT()
  const accounts = useClaudeAccounts()
  const fallback = t('orchestra.launch.inherit')
  const accountName = account
    ? (accounts.find((a) => a.id === account)?.name ?? account)
    : t('orchestra.usage.defaultAccount')
  const modelName = model ? shortModel(model) : fallback
  const effortName = effort || fallback
  return (
    <span
      className={className ? `${styles.identity} ${className}` : styles.identity}
      title={t('orchestra.agent.identity', {
        account: accountName,
        model: modelName,
        effort: effortName,
      })}
    >
      {accountName}
      <span className={styles.sep}>·</span>
      {modelName}
      <span className={styles.sep}>·</span>
      {effortName}
    </span>
  )
}
