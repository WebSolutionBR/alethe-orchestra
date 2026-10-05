/** Strings for Orchestra-per-project and the original-Alethe import; spread into en.ts / pt-BR.ts. */
export const projectEn = {
  'orchestra.project.label': 'Project',
  'orchestra.project.none': 'Select a project in the sidebar to start its Orchestra.',
  'orchestra.project.noFolder':
    'This project has no folder yet. Choose one below; the Orchestra remembers it for this project.',
  'orchestra.project.openHere': 'Open Orchestra for this project',
  'orchestra.project.otherFolder': 'Other folder',
  'legacyImport.doneTitle': 'Imported from Alethe',
  'legacyImport.resyncedTitle': 'Re-synced with Alethe',
  'legacyImport.doneBody':
    '{projects} projects, {groups} groups and {accounts} Claude accounts added ({files} account files copied). The original Alethe data was not changed.',
  'legacyImport.skipped': 'Kept your existing project with the same name: {names}.',
  'legacyImport.failedTitle': 'Alethe import failed',
  'legacyImport.nothing': 'Original Alethe data not found on this computer.',
  'legacyImport.resync': 'Re-sync from Alethe',
  'legacyImport.resyncHint':
    'Bring missing projects, groups and Claude accounts from the original Alethe again (read only; nothing there is changed).',
} as const

export const projectPtBR: Record<keyof typeof projectEn, string> = {
  'orchestra.project.label': 'Projeto',
  'orchestra.project.none': 'Selecione um projeto na barra lateral para iniciar a Orquestra dele.',
  'orchestra.project.noFolder':
    'Este projeto ainda não tem pasta. Escolha uma abaixo; a Orquestra lembra dela para este projeto.',
  'orchestra.project.openHere': 'Abrir Orquestra deste projeto',
  'orchestra.project.otherFolder': 'Outra pasta',
  'legacyImport.doneTitle': 'Importado do Alethe',
  'legacyImport.resyncedTitle': 'Re-sincronizado com o Alethe',
  'legacyImport.doneBody':
    '{projects} projetos, {groups} grupos e {accounts} contas Claude adicionados ({files} arquivos de contas copiados). Os dados do Alethe original não foram alterados.',
  'legacyImport.skipped': 'Mantido o projeto que você já tinha com o mesmo nome: {names}.',
  'legacyImport.failedTitle': 'Falha ao importar do Alethe',
  'legacyImport.nothing': 'Dados do Alethe original não encontrados neste computador.',
  'legacyImport.resync': 'Re-sincronizar do Alethe',
  'legacyImport.resyncHint':
    'Traz de novo projetos, grupos e contas Claude que faltam do Alethe original (só leitura; nada lá é alterado).',
}
