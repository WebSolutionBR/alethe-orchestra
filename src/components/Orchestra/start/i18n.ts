/** Strings of the Orchestra start screen (folder origin, mode, start readiness); spread into en.ts / pt-BR.ts. */
export const startEn = {
  'orchestra.start.mode': 'Mode',
  'orchestra.start.folderNow': 'The agents will work in',
  'orchestra.start.originProject': 'project folder',
  'orchestra.start.originChosen': 'picked here',
  'orchestra.start.originInherited': 'borrowed from {name}',
  'orchestra.start.originInheritedAny': 'borrowed from the group',
  'orchestra.start.inheritedHint':
    'This project has no folder of its own, so it borrows one from another project of its group. Pick this project’s folder before starting.',
  'orchestra.start.chosenHint': 'Remembered for this project; the project folder is unchanged.',
  'orchestra.start.useProjectFolder': 'Back to the project folder',
  'orchestra.start.forgetFolder': 'Forget the picked folder',
  'orchestra.start.noFolderShort': 'no folder yet',
  'orchestra.start.newProject': 'New project',
  'orchestra.start.blockNoProjects':
    'Create a project first: it gives the agents a folder to work in.',
  'orchestra.start.blockNoProject': 'Pick a project above.',
  'orchestra.start.blockNoFolder': 'Choose the folder the agents will work in.',
  'orchestra.start.emptyGoalHint':
    'No goal: the orchestrator terminal opens so you can type it there.',
}

export const startPtBR: Record<keyof typeof startEn, string> = {
  'orchestra.start.mode': 'Modo',
  'orchestra.start.folderNow': 'Os agentes vão trabalhar em',
  'orchestra.start.originProject': 'pasta do projeto',
  'orchestra.start.originChosen': 'escolhida aqui',
  'orchestra.start.originInherited': 'emprestada de {name}',
  'orchestra.start.originInheritedAny': 'emprestada do grupo',
  'orchestra.start.inheritedHint':
    'Este projeto não tem pasta própria e por isso empresta a de outro projeto do grupo. Escolha a pasta deste projeto antes de iniciar.',
  'orchestra.start.chosenHint': 'Lembrada para este projeto; a pasta do projeto não muda.',
  'orchestra.start.useProjectFolder': 'Voltar para a pasta do projeto',
  'orchestra.start.forgetFolder': 'Esquecer a pasta escolhida',
  'orchestra.start.noFolderShort': 'sem pasta',
  'orchestra.start.newProject': 'Novo projeto',
  'orchestra.start.blockNoProjects':
    'Crie um projeto antes: ele dá aos agentes uma pasta de trabalho.',
  'orchestra.start.blockNoProject': 'Escolha um projeto acima.',
  'orchestra.start.blockNoFolder': 'Escolha a pasta em que os agentes vão trabalhar.',
  'orchestra.start.emptyGoalHint':
    'Sem objetivo: o terminal do orquestrador abre para você digitar lá.',
}
