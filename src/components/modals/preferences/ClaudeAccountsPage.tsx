import { useT } from '../../../lib/i18n'
import { ClaudeAccountsPanel } from '../ClaudeAccountsPanel'
import { SettingsSection } from './primitives'

export function ClaudeAccountsPage() {
  const t = useT()
  return (
    <SettingsSection
      id="claude-accounts"
      title={t('claudeAccounts.title')}
      description={t('claudeAccounts.intro')}
    >
      <ClaudeAccountsPanel hideIntro />
    </SettingsSection>
  )
}
