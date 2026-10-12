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
  'orchestra.attention.screenTitle': '{agent} is blocked: {reason}',
  'orchestra.attention.longBlockTitle': '{agent} has been blocked for {minutes} min',
  'orchestra.attention.prefs.title': 'Blocked and stalled agents',
  'orchestra.attention.prefs.desc':
    'When a blocked Orchestra agent is announced again even with its session on screen, how often the reminder repeats, and when a silent busy agent shows as "stalled?".',
  'orchestra.attention.prefs.threshold': 'Remind after (min)',
  'orchestra.attention.prefs.repeat': 'Repeat every (min, 0 = once)',
  'orchestra.attention.prefs.stall': 'Stalled after (min)',
  'orchestra.attention.prefs.reset': 'Restore defaults',

  'orchestra.agents.blocked.dependencyShort': 'Waits for a failed dependency',
  'orchestra.agents.blocked.trust': 'Folder trust dialog',
  'orchestra.agents.blocked.login': 'Login expired',
  'orchestra.agents.blocked.account': 'Account changed',
  'orchestra.agents.blocked.onboarding': 'First-run onboarding',
  'orchestra.agents.blocked.mcp': 'MCP server approval',
  'orchestra.agents.blocked.pressEnter': 'Waits for Enter',
  'orchestra.agents.blocked.proceed': 'Asks "Do you want to proceed?"',
  'orchestra.agents.blocked.usageLimit': 'Usage limit',
  'orchestra.agents.blocked.usageLimitUntil': 'Usage limit until {time}',
  'orchestra.agents.blocked.unknownScreen': 'Unknown screen',
  'orchestra.agents.blocked.accountDetail': 'Signed in as {got}, expected {expected}.',
  'orchestra.agents.blocked.noLoginDetail':
    'This account is not signed in here. Its terminal was not opened.',
  'orchestra.agents.blocked.loginExpiredDetail':
    'The sign-in of this account expired and could not be renewed. Its terminal was not opened.',
  'orchestra.agents.blocked.forMinutes': 'blocked for {minutes} min',
  'orchestra.agents.blocked.noChromeProfile':
    'No Chrome profile set for this account: the login opens the default browser, which may be signed in to another account.',
  'orchestra.agents.blocked.actionFailed': 'Did not work: {error}',
  'orchestra.agents.blocked.trustAction': 'Trust and continue',
  'orchestra.agents.blocked.trustTitle': 'Trust {folder} in this account and start the agent again',
  'orchestra.agents.blocked.trustNotice':
    'I trusted the session folder for {id} and started it again: it was stuck on the trust dialog.',
  'orchestra.agents.blocked.signIn': 'Sign in',
  'orchestra.agents.blocked.signingIn': 'Waiting for the browser…',
  'orchestra.agents.blocked.signInTitle':
    'Sign {account} in again in Chrome profile {profile}, then start the agent again',
  'orchestra.agents.blocked.defaultBrowser': 'the default browser',
  'orchestra.agents.blocked.signedInNotice':
    'I signed the account of {id} in again and started it again: its login had expired or changed.',
  'orchestra.agents.blocked.mute': 'Silence',
  'orchestra.agents.blocked.unmute': 'Silenced',
  'orchestra.agents.blocked.muteTitle': 'No more reminders about this block',
  'orchestra.agents.stalled': 'stalled?',
  'orchestra.agents.stalledFor': 'No output and no report for {minutes} min',

  'orchestra.report.blockedTime': 'Time blocked',
  'orchestra.report.accounts': 'Accounts',
  'orchestra.report.defaultAccount': 'default account',
  'orchestra.report.accountSwitch': 'session account switched from {from} to {to}',
  'orchestra.attention.signIn.mismatch':
    'The sign-in ended up on {email}, not this account. Use its own Chrome profile and try again.',
  'orchestra.attention.signIn.busy':
    'Another sign-in or token renewal is using this account; try again in a moment.',
  'orchestra.attention.signIn.timeout': 'The sign-in was not authorized within 10 minutes.',
  'orchestra.attention.signIn.incomplete': 'The sign-in did not finish: no account was saved.',
  'orchestra.attention.signIn.noClaude': 'Claude Code was not found on this computer.',
  'orchestra.attention.signIn.failed': 'Sign-in failed: {message}',
  'orchestra.attention.signIn.noChrome':
    "Google Chrome was not found, so the sign-in page cannot open in the account's profile.",
  'orchestra.attention.signIn.badProfile':
    "This Chrome profile does not exist. Check the account's profile in Preferences > Claude accounts.",
  'orchestra.attention.signIn.other': 'Signing in ({id})…',
  'orchestra.attention.signIn.otherTitle':
    '{id} is signing this account in; this agent restarts with it once it is done.',
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
  'orchestra.attention.screenTitle': '{agent} está bloqueado: {reason}',
  'orchestra.attention.longBlockTitle': '{agent} está bloqueado há {minutes} min',
  'orchestra.attention.prefs.title': 'Agentes bloqueados e parados',
  'orchestra.attention.prefs.desc':
    'Quando um agente bloqueado da Orquestra é avisado de novo mesmo com a sessão na tela, de quanto em quanto tempo o aviso se repete e quando um agente ocupado e calado aparece como "parado?".',
  'orchestra.attention.prefs.threshold': 'Avisar depois de (min)',
  'orchestra.attention.prefs.repeat': 'Repetir a cada (min, 0 = uma vez)',
  'orchestra.attention.prefs.stall': 'Parado depois de (min)',
  'orchestra.attention.prefs.reset': 'Restaurar padrões',

  'orchestra.agents.blocked.dependencyShort': 'Aguarda uma dependência que falhou',
  'orchestra.agents.blocked.trust': 'Diálogo de confiança da pasta',
  'orchestra.agents.blocked.login': 'Login expirado',
  'orchestra.agents.blocked.account': 'Conta trocada',
  'orchestra.agents.blocked.onboarding': 'Configuração inicial',
  'orchestra.agents.blocked.mcp': 'Aprovação de servidor MCP',
  'orchestra.agents.blocked.pressEnter': 'Espera um Enter',
  'orchestra.agents.blocked.proceed': 'Pergunta "Do you want to proceed?"',
  'orchestra.agents.blocked.usageLimit': 'Limite de uso',
  'orchestra.agents.blocked.usageLimitUntil': 'Limite de uso até {time}',
  'orchestra.agents.blocked.unknownScreen': 'Tela desconhecida',
  'orchestra.agents.blocked.accountDetail': 'Logado como {got}, esperado {expected}.',
  'orchestra.agents.blocked.noLoginDetail':
    'Esta conta não está logada aqui. O terminal dele não foi aberto.',
  'orchestra.agents.blocked.loginExpiredDetail':
    'O login desta conta venceu e não deu para renovar. O terminal dele não foi aberto.',
  'orchestra.agents.blocked.forMinutes': 'bloqueado há {minutes} min',
  'orchestra.agents.blocked.noChromeProfile':
    'Esta conta não tem perfil do Chrome: o login abre o navegador padrão, que pode estar logado em outra conta.',
  'orchestra.agents.blocked.actionFailed': 'Não funcionou: {error}',
  'orchestra.agents.blocked.trustAction': 'Confiar e continuar',
  'orchestra.agents.blocked.trustTitle':
    'Confiar em {folder} nesta conta e iniciar o agente de novo',
  'orchestra.agents.blocked.trustNotice':
    'Confiei na pasta da sessão para {id} e iniciei de novo: ele estava parado no diálogo de confiança.',
  'orchestra.agents.blocked.signIn': 'Entrar',
  'orchestra.agents.blocked.signingIn': 'Aguardando o navegador…',
  'orchestra.agents.blocked.signInTitle':
    'Entrar de novo em {account} no perfil {profile} do Chrome e iniciar o agente de novo',
  'orchestra.agents.blocked.defaultBrowser': 'o navegador padrão',
  'orchestra.agents.blocked.signedInNotice':
    'Loguei de novo a conta de {id} e iniciei de novo: o login dele tinha vencido ou trocado.',
  'orchestra.agents.blocked.mute': 'Silenciar',
  'orchestra.agents.blocked.unmute': 'Silenciado',
  'orchestra.agents.blocked.muteTitle': 'Sem mais lembretes deste bloqueio',
  'orchestra.agents.stalled': 'parado?',
  'orchestra.agents.stalledFor': 'Sem saída e sem relatório há {minutes} min',

  'orchestra.report.blockedTime': 'Tempo bloqueado',
  'orchestra.report.accounts': 'Contas',
  'orchestra.report.defaultAccount': 'conta padrão',
  'orchestra.report.accountSwitch': 'conta da sessão trocada de {from} para {to}',
  'orchestra.attention.signIn.mismatch':
    'O login caiu em {email}, não nesta conta. Use o perfil do Chrome dela e tente de novo.',
  'orchestra.attention.signIn.busy':
    'Outro login ou renovação de token está usando esta conta; tente de novo daqui a pouco.',
  'orchestra.attention.signIn.timeout': 'O login não foi autorizado em 10 minutos.',
  'orchestra.attention.signIn.incomplete': 'O login não terminou: nenhuma conta foi gravada.',
  'orchestra.attention.signIn.noClaude': 'O Claude Code não foi encontrado neste computador.',
  'orchestra.attention.signIn.failed': 'Falha no login: {message}',
  'orchestra.attention.signIn.noChrome':
    'O Google Chrome não foi encontrado, então a página de login não abre no perfil da conta.',
  'orchestra.attention.signIn.badProfile':
    'Este perfil do Chrome não existe. Confira o perfil da conta em Preferências > Contas Claude.',
  'orchestra.attention.signIn.other': 'Entrando ({id})…',
  'orchestra.attention.signIn.otherTitle':
    '{id} está fazendo o login desta conta; este agente reinicia junto quando terminar.',
}
