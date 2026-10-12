/** Strings of the interrupted-orchestration strip and its record; spread into en.ts / pt-BR.ts. */
export const resumeEn = {
  'orchestra.resume.region': 'Interrupted orchestrations',
  'orchestra.resume.title': 'Interrupted orchestration',
  'orchestra.resume.why': 'Alethe was closed while it was running.',
  'orchestra.resume.saved': 'saved {when}',
  'orchestra.resume.workersOne': '1 worker',
  'orchestra.resume.workersMany': '{count} workers',
  'orchestra.resume.doneCountOne': '1 done',
  'orchestra.resume.doneCount': '{count} done',
  'orchestra.resume.folder': 'Folder: {cwd}',
  'orchestra.resume.modeAutonomous': 'autonomous',
  'orchestra.resume.modeSupervised': 'asks before acting',
  'orchestra.resume.folderMissing':
    'Its folder no longer exists: {cwd}. Choose where it is now, or discard it; it never resumes anywhere else on its own.',
  'orchestra.resume.chooseFolder': 'Choose folder',
  'orchestra.resume.chooseFolderTitle':
    'Pick where its folder is now. The agents start their tasks over there; their earlier conversations stay with the old folder.',
  'orchestra.resume.resumeMissingTitle': 'Its folder is missing: choose where it is now',
  'orchestra.resume.confirmTitle': 'Resume this orchestration?',
  'orchestra.resume.confirmAutonomousTitle': 'Resume in autonomous mode?',
  'orchestra.resume.confirmAutonomous':
    'The agents of "{name}" will run in {cwd} without asking before acting (permission prompts are skipped).',
  'orchestra.resume.confirmMoved':
    'Resume "{name}" in {cwd}? Its agents start their tasks over there; their earlier conversations stay with the old folder.',
  'orchestra.resume.damagedTitle': 'Unreadable orchestration record',
  'orchestra.resume.damagedWhy':
    'The record {id} is damaged or was saved by a newer version of Alethe, so it cannot be read or resumed.',
  'orchestra.resume.failedCount': '{count} failed',
  'orchestra.resume.goal': '“{goal}”',
  'orchestra.resume.noGoal': 'no goal',
  'orchestra.resume.resume': 'Resume',
  'orchestra.resume.resumeTitle':
    'Relaunch the orchestrator and every unfinished worker in the same folder, account and model, continuing their conversations',
  'orchestra.resume.resuming': 'Resuming…',
  'orchestra.resume.view': 'View record',
  'orchestra.resume.viewTitle':
    'Read what was saved: goal, workers, tasks and the last messages. Nothing runs.',
  'orchestra.resume.discard': 'Discard',
  'orchestra.resume.discardTitle':
    'Delete the saved record; this orchestration can no longer be resumed',
  'orchestra.resume.confirmDiscard':
    'Discard the interrupted orchestration "{name}"? Its saved record and terminal transcripts are deleted and it can no longer be resumed.',
  'orchestra.resume.record.title': 'Record of "{name}"',
  'orchestra.resume.record.readOnly':
    'Read-only: nothing runs until you resume it. Resuming relaunches the unfinished agents in their own conversations.',
  'orchestra.resume.record.goal': 'Goal',
  'orchestra.resume.record.folder': 'Folder',
  'orchestra.resume.record.started': 'Started',
  'orchestra.resume.record.saved': 'Last saved',
  'orchestra.resume.record.permissions': 'Permissions',
  'orchestra.resume.record.autonomous': 'Autonomous (skips permission prompts)',
  'orchestra.resume.record.supervised': 'Asks before acting',
  'orchestra.resume.record.agents': 'Agents',
  'orchestra.resume.record.task': 'Task',
  'orchestra.resume.record.history': 'Earlier tasks ({count})',
  'orchestra.resume.record.activity': 'Recent activity',
  'orchestra.resume.record.files': 'Files edited ({count})',
  'orchestra.resume.record.willResume': 'Resumes its conversation',
  'orchestra.resume.record.willRestart': 'No saved conversation: starts its task again',
  'orchestra.resume.record.willWait': 'Waits for {deps}',
  'orchestra.resume.record.finished': 'Finished',
  'orchestra.resume.record.cancelled': 'Cancelled before it started: not launched',
  'orchestra.resume.record.willFail':
    'Failed before the close: not relaunched (restart it from its panel if still needed)',
  'orchestra.resume.record.transcript': 'Terminal transcript ({cols}×{rows})',
  'orchestra.resume.record.transcriptGuessed':
    'Terminal transcript (size not recorded, shown at {cols}×{rows})',
  'orchestra.resume.record.transcriptLoading': 'Reading the saved terminal…',
  'orchestra.resume.record.transcriptEmpty': 'Nothing was saved from this terminal.',
  'orchestra.resume.record.transcriptFailed': 'Could not read the saved terminal: {message}',
  'orchestra.resume.record.messages': 'Last messages',
  'orchestra.resume.record.noMessages': 'No messages were saved.',
  'orchestra.resume.record.close': 'Close',
} as const

export const resumePtBR: Record<keyof typeof resumeEn, string> = {
  'orchestra.resume.region': 'Orquestrações interrompidas',
  'orchestra.resume.title': 'Orquestração interrompida',
  'orchestra.resume.why': 'O Alethe foi fechado com ela em andamento.',
  'orchestra.resume.saved': 'salva {when}',
  'orchestra.resume.workersOne': '1 worker',
  'orchestra.resume.workersMany': '{count} workers',
  'orchestra.resume.doneCountOne': '1 concluído',
  'orchestra.resume.doneCount': '{count} concluídos',
  'orchestra.resume.folder': 'Pasta: {cwd}',
  'orchestra.resume.modeAutonomous': 'autônomo',
  'orchestra.resume.modeSupervised': 'pergunta antes de agir',
  'orchestra.resume.folderMissing':
    'A pasta dela não existe mais: {cwd}. Escolha onde ela está agora ou descarte; ela nunca é retomada em outro lugar por conta própria.',
  'orchestra.resume.chooseFolder': 'Escolher pasta',
  'orchestra.resume.chooseFolderTitle':
    'Escolha onde a pasta está agora. Os agentes recomeçam as tarefas lá; as conversas anteriores ficam com a pasta antiga.',
  'orchestra.resume.resumeMissingTitle': 'A pasta sumiu: escolha onde ela está agora',
  'orchestra.resume.confirmTitle': 'Retomar esta orquestração?',
  'orchestra.resume.confirmAutonomousTitle': 'Retomar em modo autônomo?',
  'orchestra.resume.confirmAutonomous':
    'Os agentes de "{name}" vão rodar em {cwd} sem pedir permissão antes de agir (os pedidos de permissão são pulados).',
  'orchestra.resume.confirmMoved':
    'Retomar "{name}" em {cwd}? Os agentes recomeçam as tarefas lá; as conversas anteriores ficam com a pasta antiga.',
  'orchestra.resume.damagedTitle': 'Registro de orquestração ilegível',
  'orchestra.resume.damagedWhy':
    'O registro {id} está danificado ou foi salvo por uma versão mais nova do Alethe, então não pode ser lido nem retomado.',
  'orchestra.resume.failedCount': '{count} com falha',
  'orchestra.resume.goal': '“{goal}”',
  'orchestra.resume.noGoal': 'sem objetivo',
  'orchestra.resume.resume': 'Retomar',
  'orchestra.resume.resumeTitle':
    'Relança o orquestrador e cada worker não concluído na mesma pasta, conta e modelo, continuando as conversas deles',
  'orchestra.resume.resuming': 'Retomando…',
  'orchestra.resume.view': 'Ver registro',
  'orchestra.resume.viewTitle':
    'Ler o que foi salvo: objetivo, workers, tarefas e as últimas mensagens. Nada é executado.',
  'orchestra.resume.discard': 'Descartar',
  'orchestra.resume.discardTitle':
    'Apaga o registro salvo; esta orquestração não poderá mais ser retomada',
  'orchestra.resume.confirmDiscard':
    'Descartar a orquestração interrompida "{name}"? O registro salvo e as transcrições dos terminais serão apagados e ela não poderá mais ser retomada.',
  'orchestra.resume.record.title': 'Registro de "{name}"',
  'orchestra.resume.record.readOnly':
    'Somente leitura: nada roda até você retomar. Retomar relança os agentes não concluídos nas próprias conversas.',
  'orchestra.resume.record.goal': 'Objetivo',
  'orchestra.resume.record.folder': 'Pasta',
  'orchestra.resume.record.started': 'Início',
  'orchestra.resume.record.saved': 'Salva por último',
  'orchestra.resume.record.permissions': 'Permissões',
  'orchestra.resume.record.autonomous': 'Autônomo (pula os pedidos de permissão)',
  'orchestra.resume.record.supervised': 'Pergunta antes de agir',
  'orchestra.resume.record.agents': 'Agentes',
  'orchestra.resume.record.task': 'Tarefa',
  'orchestra.resume.record.history': 'Tarefas anteriores ({count})',
  'orchestra.resume.record.activity': 'Atividade recente',
  'orchestra.resume.record.files': 'Arquivos editados ({count})',
  'orchestra.resume.record.willResume': 'Retoma a própria conversa',
  'orchestra.resume.record.willRestart': 'Sem conversa salva: recomeça a tarefa',
  'orchestra.resume.record.willWait': 'Espera {deps}',
  'orchestra.resume.record.finished': 'Concluído',
  'orchestra.resume.record.cancelled': 'Cancelado antes de começar: não é lançado',
  'orchestra.resume.record.willFail':
    'Falhou antes do fechamento: não é relançado (reinicie pelo painel dele, se ainda precisar)',
  'orchestra.resume.record.transcript': 'Transcrição do terminal ({cols}×{rows})',
  'orchestra.resume.record.transcriptGuessed':
    'Transcrição do terminal (tamanho não gravado, exibida em {cols}×{rows})',
  'orchestra.resume.record.transcriptLoading': 'Lendo o terminal guardado…',
  'orchestra.resume.record.transcriptEmpty': 'Nada foi guardado deste terminal.',
  'orchestra.resume.record.transcriptFailed': 'Não foi possível ler o terminal guardado: {message}',
  'orchestra.resume.record.messages': 'Últimas mensagens',
  'orchestra.resume.record.noMessages': 'Nenhuma mensagem foi salva.',
  'orchestra.resume.record.close': 'Fechar',
}
