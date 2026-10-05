/** Strings of the built-in creative agent; spread into en.ts / pt-BR.ts. */
export const creativeEn = {
  'orchestra.creative.name': 'Creative agent',
  'orchestra.creative.hint':
    'An extra worker proposes useful features, clean design and the fundamentals that slip by; it builds only what the orchestrator approves.',
  'orchestra.creative.offHint': 'Off: the orchestrator works with the task workers only.',
  'orchestra.creative.badge': 'creative',
  'orchestra.creative.badgeTitle':
    'Creative agent: proposes ideas to the orchestrator and builds only what it approves',
}

export const creativePtBR: Record<keyof typeof creativeEn, string> = {
  'orchestra.creative.name': 'Agente criativo',
  'orchestra.creative.hint':
    'Um worker extra propõe features úteis, design limpo e os fundamentos que passam despercebidos; só implementa o que o orquestrador aprovar.',
  'orchestra.creative.offHint': 'Desligado: o orquestrador trabalha só com os workers das tarefas.',
  'orchestra.creative.badge': 'criativo',
  'orchestra.creative.badgeTitle':
    'Agente criativo: propõe ideias ao orquestrador e só implementa o que ele aprovar',
}
