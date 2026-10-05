import { useSyncExternalStore } from 'react'

import {
  type OrchestraSession,
  type OrchestraState,
  shownSessionIds,
  useOrchestraStore,
} from '../stores/orchestraStore'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

export type PtyVisibilitySets = {
  visible: Set<string>
  focused: Set<string>
}

   
                                                                    
                                                                            
                                                                    
                                                                                    
  
                                                                         
                                                                           
                                                                          
                             
   
export function computeVisibleFocusedPtyIds(): PtyVisibilitySets {
  const projectsState = useProjectsStore.getState()
  const ui = useUiStore.getState()
  const visible = new Set<string>()
  const focused = new Set<string>()
  const workspaceVisible = ui.activeView === 'workspace'
  const focusedTerminalIds = new Set(
    [ui.focusedTerminalId, ui.activeTerminal?.terminalId].filter(
      (id): id is string => typeof id === 'string',
    ),
  )

                                                                       
                                                                         
                                                                             
                                                                             
                                                                        
                                                                            
  // de verdade.
  const isolatedPaneId = projectsState.preferences.isolatedPaneId

  // Panes of hidden-but-mounted workspace tabs count as visible: they keep streaming so
  // switching back to their tab costs nothing.
  const keptAlivePaneIds = new Set(ui.keptAlivePaneIds)

  for (const project of projectsState.projects) {
    const container = projectsState.workspace.containers.find(
      (entry) => entry.projectId === project.id,
    )
    for (const terminal of project.terminals) {
      const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId)
      const inNormalGrid =
        container &&
        !container.collapsed &&
        container.paneIds.includes(terminal.id)
      const isIsolatedPane = terminal.id === isolatedPaneId
      const isKeptAlive = keptAlivePaneIds.has(terminal.id)
      if (activeTab?.ptyId && workspaceVisible && (inNormalGrid || isIsolatedPane || isKeptAlive)) {
        visible.add(activeTab.ptyId)
      }
      if (activeTab?.ptyId && (focusedTerminalIds.has(terminal.id) || isIsolatedPane)) {
        focused.add(activeTab.ptyId)
      }
    }
  }

  const canvasId = ui.agentCanvasSession?.ptyId
  if (canvasId && ui.activeView === 'agentCanvas') {
    visible.add(canvasId)
    focused.add(canvasId)
  }

  // Orchestra agents are not workspace panes. While the view is open every agent PTY of the
  // sessions on screen counts as visible (the terminals mode and the side drawer mount them);
  // their selected agents are focused.
  if (ui.activeView === 'orchestra') {
    for (const session of shownOrchestraSessions(useOrchestraStore.getState())) {
      for (const agent of session.agents) {
        if (!agent.ptyId) continue
        visible.add(agent.ptyId)
        if (agent.id === session.selectedId) focused.add(agent.ptyId)
      }
    }
  }

  return { visible, focused }
}

/** Orchestra sessions on screen: the active one, and the other one side by side. */
function shownOrchestraSessions(state: OrchestraState): OrchestraSession[] {
  return shownSessionIds(state)
    .map((id) => state.sessions[id])
    .filter((session): session is OrchestraSession => Boolean(session))
}

/** The orchestra fields the visibility sets depend on, as one comparable string. */
function orchestraVisibilityKey(state: OrchestraState): string {
  return shownOrchestraSessions(state)
    .map((s) => [s.id, s.selectedId ?? '', ...s.agents.map((a) => a.ptyId ?? '')].join('|'))
    .join('/')
}

function subscribePtyVisibility(callback: () => void): () => void {
  const unsubProjects = useProjectsStore.subscribe(() => {
    cached = null
    callback()
  })
  const unsubUi = useUiStore.subscribe(() => {
    cached = null
    callback()
  })
  // Only the fields that change the result invalidate the cache; hook events stream fast.
  const unsubOrchestra = useOrchestraStore.subscribe((state, prev) => {
    if (orchestraVisibilityKey(state) === orchestraVisibilityKey(prev)) return
    cached = null
    callback()
  })
  return () => {
    unsubProjects()
    unsubUi()
    unsubOrchestra()
  }
}

                                                                               
                                                                              
                                                                             
                                                                               
                                                 
let cached: PtyVisibilitySets | null = null

function visibilitySets(): PtyVisibilitySets {
  if (!cached) cached = computeVisibleFocusedPtyIds()
  return cached
}

   
                                                                            
                                                                            
                                                                    
                                                                         
                                                                
   
export function usePtyPanelVisible(ptyId: string | undefined): boolean {
  return useSyncExternalStore(subscribePtyVisibility, () => {
    if (!ptyId) return false
    return visibilitySets().visible.has(ptyId)
  })
}
