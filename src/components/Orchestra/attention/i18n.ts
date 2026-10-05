/** Strings of the Orchestra attention notices; spread into en.ts / pt-BR.ts. */
export const attentionEn = {
  'orchestra.attention.blockedTitle': '{agent} needs you',
  'orchestra.attention.failedTitle': '{agent} stopped before finishing',
  'orchestra.attention.allDoneTitle': 'Orchestration finished',
  'orchestra.attention.allDoneBody': 'All {count} workers are done.',
  'orchestra.attention.allDoneBodyOne': 'The worker is done.',
  'orchestra.attention.waitingTitle': 'The orchestrator is waiting for you',
  'orchestra.attention.waitingFallback': 'It finished its turn and waits for your reply.',
  'orchestra.attention.manyTitle': '{count} things need you in the Orchestra',
  'orchestra.attention.badge': '{count} waiting for you',
  'orchestra.attention.toggle': 'Alerts',
  'orchestra.attention.toggleOn':
    'A notice when an agent asks for approval or an answer, stops before finishing, or when all workers are done.',
  'orchestra.attention.toggleOff':
    'Silent: only the counter on the Orchestra button shows what needs you.',
}

export const attentionPtBR: Record<keyof typeof attentionEn, string> = {
  'orchestra.attention.blockedTitle': '{agent} precisa de você',
  'orchestra.attention.failedTitle': '{agent} parou antes de concluir',
  'orchestra.attention.allDoneTitle': 'Orquestração concluída',
  'orchestra.attention.allDoneBody': 'Os {count} workers concluíram.',
  'orchestra.attention.allDoneBodyOne': 'O worker concluiu.',
  'orchestra.attention.waitingTitle': 'O orquestrador está esperando você',
  'orchestra.attention.waitingFallback': 'Terminou a vez dele e espera sua resposta.',
  'orchestra.attention.manyTitle': '{count} pendências na Orquestra',
  'orchestra.attention.badge': '{count} esperando você',
  'orchestra.attention.toggle': 'Avisos',
  'orchestra.attention.toggleOn':
    'Aviso quando um agente pede aprovação ou resposta, para antes de concluir, ou quando todos os workers terminam.',
  'orchestra.attention.toggleOff':
    'Silencioso: só o contador no botão da Orquestra mostra o que precisa de você.',
}
