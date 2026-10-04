import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { ClaudeAccountsPanel } from './ClaudeAccountsPanel'
import { Modal } from './Modal'

export function ClaudeAccountsModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'claudeAccounts')
  const closeModal = useUiStore((s) => s.closeModal)

  return (
    <Modal open={open} onClose={closeModal} title={t('claudeAccounts.title')} width={520}>
      <ClaudeAccountsPanel />
    </Modal>
  )
}
