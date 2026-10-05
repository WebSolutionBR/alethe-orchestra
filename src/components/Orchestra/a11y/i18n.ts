/** Strings of the Orchestra's keyboard and screen reader affordances; spread into en.ts / pt-BR.ts. */
export const a11yEn = {
  'orchestra.a11y.drawerResizeHint':
    'Drag or use the arrow keys (Shift for bigger steps); double-click restores the default width',
  'orchestra.a11y.focusPane': 'Ctrl+Shift+{n} focuses this terminal',
}

export const a11yPtBR: Record<keyof typeof a11yEn, string> = {
  'orchestra.a11y.drawerResizeHint':
    'Arraste ou use as setas (Shift para passos maiores); clique duplo volta à largura padrão',
  'orchestra.a11y.focusPane': 'Ctrl+Shift+{n} foca este terminal',
}
