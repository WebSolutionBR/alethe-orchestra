/** Strings for the Orchestra accounts panel, rail and limit strip; spread into en.ts / pt-BR.ts. */
export const accountsEn = {
  'orchestra.accounts.open': 'Accounts',
  'orchestra.accounts.openTitle': 'Claude accounts: usage and the session account (Alt+A)',
  'orchestra.accounts.openNear': 'Claude accounts: {name} is near its limit (Alt+A)',
  'orchestra.accounts.title': 'Claude accounts',
  'orchestra.accounts.close': 'Close accounts (Esc)',
  'orchestra.accounts.refresh': 'Refresh usage',
  'orchestra.accounts.fetchedAt': 'data from {time}',
  'orchestra.accounts.staleRetry': 'kept from {time} · next read at {retry}',
  'orchestra.accounts.policySingle': 'One account: {name}',
  'orchestra.accounts.policySingleTitle':
    'Every agent of this session runs on {name}; an orch spawn --account is ignored. Alt+A opens the accounts.',
  'orchestra.accounts.policySpread': 'Spread across accounts',
  'orchestra.accounts.policySpreadTitle':
    'The orchestrator may start each worker on another account; unflagged workers use {name}. Alt+A opens the accounts.',
  'orchestra.accounts.sessionAccount': 'session account',
  'orchestra.accounts.useHere': 'Use in this session',
  'orchestra.accounts.useHereTitle':
    'New workers start on {name}; running agents keep their account until you restart them',
  'orchestra.accounts.signIn': 'Sign in',
  'orchestra.accounts.signInTitle': 'Sign in to {name} in its own Chrome profile',
  'orchestra.accounts.noChromeProfile':
    'No Chrome profile set: the default browser opens and may sign in another account',
  'orchestra.accounts.signInFailed': 'Sign-in failed: {message}',
  'orchestra.accounts.signedInAs': 'signed in as {email}',
  'orchestra.accounts.noIdentity': 'no sign-in found in this account folder',
  'orchestra.accounts.organization': 'organization {name}',
  'orchestra.accounts.emailMismatch': 'Signed in as {real}, expected {expected}',
  'orchestra.accounts.duplicate': 'Same Claude account as {names}: they share one quota',
  'orchestra.accounts.duplicateBanner':
    'Two or more accounts are signed in to the same Claude account. Sign in to each one again in its own Chrome profile.',
  'orchestra.accounts.resetIn': '{window} {pct}% · resets in {when}',
  'orchestra.accounts.nearLimit': 'near the 5h limit',
  'orchestra.accounts.agentsNone': 'no agents',
  'orchestra.accounts.agentsOne': '1 agent',
  'orchestra.accounts.agents': '{count} agents',
  'orchestra.accounts.offTitle': 'Still on another account',
  'orchestra.accounts.offHint':
    'These agents started before the switch. Restarting interrupts their work: it is never done for you.',
  'orchestra.accounts.restartOne': 'Restart on {name}',
  'orchestra.accounts.restartAll': 'Restart all on {name}',
  'orchestra.accounts.confirmTitle': 'Restart on {name}?',
  'orchestra.accounts.confirmOk': 'Restart',
  'orchestra.accounts.restartNotice': 'I restarted {id} on the Claude account {name}.',
  'orchestra.accounts.confirmCarry':
    '{agents}: the current work is interrupted; the conversation is copied to {name} and continues there. If the copy finds nothing, the task starts over.',
  'orchestra.accounts.confirmFresh':
    '{agents}: the current work is interrupted and the task starts over on {name} (no conversation to carry).',
  'orchestra.accounts.confirmMixed':
    '{agents}: the current work is interrupted. {carry} continue their conversation, copied to {name}; {fresh} start their task over.',
  'orchestra.accounts.stopped': 'This session was stopped: its account can no longer change.',
  'orchestra.accounts.empty':
    'No linked accounts. Add them in Preferences → Claude accounts to switch between them here.',
  'orchestra.accounts.loginExpired': 'Sign-in expired: sign in again to read this account',
  'orchestra.accounts.rateLimited': 'The API limited the reads; next read at {time}',
  'orchestra.accounts.rateLimitedNoTime': 'The API limited the reads; it is read again later',
  'orchestra.accounts.riskTitle': 'Use {name} in this session?',
  'orchestra.accounts.riskConfirm': 'New workers will start on {name}. {reasons}',
  'orchestra.accounts.risk.error': 'Its usage could not be read (sign-in or API error).',
  'orchestra.accounts.risk.near': 'It is at 90% or more of the 5h or weekly limit.',
  'orchestra.accounts.risk.duplicate':
    'It is signed in to the same Claude account as another one: they share one quota.',
  'orchestra.accounts.switched': 'Session account: {from} → {to}',
  'orchestra.accounts.undo': 'Undo',
  'orchestra.accounts.dismiss': 'Dismiss',
  'orchestra.accounts.autoWait': 'On hitting the limit: wait for the reset and continue',
  'orchestra.accounts.autoWaitTitle':
    'When an agent of the session stops at the usage limit, the agents get "continue" once it resets',
  'orchestra.accounts.signInMismatch':
    'The sign-in ended up on {email}, not this account. Use its own Chrome profile and try again.',
  'orchestra.accounts.signInBusy':
    'Another sign-in or token renewal is using this account; try again in a moment',
  'orchestra.accounts.signInTimeout': 'The sign-in was not authorized within 10 minutes',
  'orchestra.accounts.signInIncomplete': 'The sign-in did not finish: no account was saved',
  'orchestra.accounts.signInNoClaude': 'Claude Code was not found on this computer',
  'orchestra.limit.strip': '{name} is at its usage limit until {time}',
  'orchestra.limit.switch': 'Switch session account',
  'orchestra.limit.wait': 'Wait',
  'orchestra.limit.waitTitle': 'Send "continue" to the agents blocked by the limit when it resets',
  'orchestra.limit.waiting': 'Waiting for {time}',
  'orchestra.limit.waitingAuto': 'Waiting for {time} (automatic)',
  'orchestra.limit.rearmed': 'The limit came back: next try at {time} ({count} of {max})',
  'orchestra.limit.waitingAutoTitle':
    'Turn it off in Accounts > On hitting the limit: wait for the reset and continue',
  'orchestra.limit.cancelWait': 'Stop waiting',
}

export const accountsPtBR: Record<keyof typeof accountsEn, string> = {
  'orchestra.accounts.open': 'Contas',
  'orchestra.accounts.openTitle': 'Contas Claude: uso e conta da sessão (Alt+A)',
  'orchestra.accounts.openNear': 'Contas Claude: {name} está perto do limite (Alt+A)',
  'orchestra.accounts.title': 'Contas Claude',
  'orchestra.accounts.close': 'Fechar contas (Esc)',
  'orchestra.accounts.refresh': 'Atualizar uso',
  'orchestra.accounts.fetchedAt': 'dados de {time}',
  'orchestra.accounts.staleRetry': 'mantido de {time} · nova leitura às {retry}',
  'orchestra.accounts.policySingle': 'Uma conta: {name}',
  'orchestra.accounts.policySingleTitle':
    'Todos os agentes desta sessão rodam em {name}; um orch spawn --account é ignorado. Alt+A abre as contas.',
  'orchestra.accounts.policySpread': 'Distribuir entre contas',
  'orchestra.accounts.policySpreadTitle':
    'O orquestrador pode abrir cada worker em outra conta; os workers sem flag usam {name}. Alt+A abre as contas.',
  'orchestra.accounts.sessionAccount': 'conta da sessão',
  'orchestra.accounts.useHere': 'Usar nesta sessão',
  'orchestra.accounts.useHereTitle':
    'Os workers novos nascem em {name}; os agentes que já rodam mantêm a conta até você reiniciá-los',
  'orchestra.accounts.signIn': 'Entrar',
  'orchestra.accounts.signInTitle': 'Entrar em {name} no perfil do Chrome dela',
  'orchestra.accounts.noChromeProfile':
    'Sem perfil do Chrome: abre o navegador padrão, que pode logar outra conta',
  'orchestra.accounts.signInFailed': 'Falha no login: {message}',
  'orchestra.accounts.signedInAs': 'logada como {email}',
  'orchestra.accounts.noIdentity': 'nenhum login encontrado na pasta desta conta',
  'orchestra.accounts.organization': 'organização {name}',
  'orchestra.accounts.emailMismatch': 'Logada como {real}, esperado {expected}',
  'orchestra.accounts.duplicate': 'Mesma conta Claude que {names}: dividem uma cota só',
  'orchestra.accounts.duplicateBanner':
    'Duas ou mais contas estão logadas na mesma conta Claude. Entre de novo em cada uma no perfil do Chrome dela.',
  'orchestra.accounts.resetIn': '{window} {pct}% · renova em {when}',
  'orchestra.accounts.nearLimit': 'perto do limite de 5h',
  'orchestra.accounts.agentsNone': 'nenhum agente',
  'orchestra.accounts.agentsOne': '1 agente',
  'orchestra.accounts.agents': '{count} agentes',
  'orchestra.accounts.offTitle': 'Ainda em outra conta',
  'orchestra.accounts.offHint':
    'Estes agentes começaram antes da troca. Reiniciar interrompe o trabalho deles: nunca é feito sozinho.',
  'orchestra.accounts.restartOne': 'Reiniciar em {name}',
  'orchestra.accounts.restartAll': 'Reiniciar todos em {name}',
  'orchestra.accounts.confirmTitle': 'Reiniciar em {name}?',
  'orchestra.accounts.confirmOk': 'Reiniciar',
  'orchestra.accounts.restartNotice': 'Reiniciei o {id} na conta Claude {name}.',
  'orchestra.accounts.confirmCarry':
    '{agents}: o trabalho atual é interrompido; a conversa é copiada para {name} e continua lá. Se a cópia não encontrar nada, a tarefa recomeça.',
  'orchestra.accounts.confirmFresh':
    '{agents}: o trabalho atual é interrompido e a tarefa recomeça em {name} (não há conversa para levar).',
  'orchestra.accounts.confirmMixed':
    '{agents}: o trabalho atual é interrompido. {carry} continuam a conversa, copiada para {name}; {fresh} recomeçam a tarefa.',
  'orchestra.accounts.stopped': 'Esta sessão foi parada: a conta dela não muda mais.',
  'orchestra.accounts.empty':
    'Nenhuma conta vinculada. Cadastre em Preferências → Contas Claude para alternar entre elas aqui.',
  'orchestra.accounts.loginExpired': 'Login expirado: entre de novo para ler esta conta',
  'orchestra.accounts.rateLimited': 'API limitou as consultas; nova leitura às {time}',
  'orchestra.accounts.rateLimitedNoTime': 'API limitou as consultas; nova leitura mais tarde',
  'orchestra.accounts.riskTitle': 'Usar {name} nesta sessão?',
  'orchestra.accounts.riskConfirm': 'Os workers novos vão nascer em {name}. {reasons}',
  'orchestra.accounts.risk.error': 'O uso dela não pôde ser lido (erro de login ou da API).',
  'orchestra.accounts.risk.near': 'Ela está em 90% ou mais do limite de 5h ou da semana.',
  'orchestra.accounts.risk.duplicate':
    'Ela está logada na mesma conta Claude que outra: as duas dividem uma cota só.',
  'orchestra.accounts.switched': 'Conta da sessão: {from} → {to}',
  'orchestra.accounts.undo': 'Desfazer',
  'orchestra.accounts.dismiss': 'Fechar',
  'orchestra.accounts.autoWait': 'Ao bater o limite: esperar o reset e continuar',
  'orchestra.accounts.autoWaitTitle':
    'Quando um agente da sessão parar no limite de uso, os agentes recebem "continue" quando ele renovar',
  'orchestra.accounts.signInMismatch':
    'O login caiu em {email}, não nesta conta. Use o perfil do Chrome dela e tente de novo.',
  'orchestra.accounts.signInBusy':
    'Outro login ou renovação de token está usando esta conta; tente de novo daqui a pouco',
  'orchestra.accounts.signInTimeout': 'O login não foi autorizado em 10 minutos',
  'orchestra.accounts.signInIncomplete': 'O login não terminou: nenhuma conta foi gravada',
  'orchestra.accounts.signInNoClaude': 'O Claude Code não foi encontrado neste computador',
  'orchestra.limit.strip': '{name} está no limite de uso até {time}',
  'orchestra.limit.switch': 'Trocar conta da sessão',
  'orchestra.limit.wait': 'Esperar',
  'orchestra.limit.waitTitle':
    'Mandar "continue" aos agentes bloqueados pelo limite quando ele renovar',
  'orchestra.limit.waiting': 'Esperando até {time}',
  'orchestra.limit.waitingAuto': 'Esperando até {time} (automático)',
  'orchestra.limit.rearmed': 'O limite voltou: nova tentativa às {time} ({count} de {max})',
  'orchestra.limit.waitingAutoTitle':
    'Desligue em Contas > Ao bater o limite: esperar o reset e continuar',
  'orchestra.limit.cancelWait': 'Parar de esperar',
}
