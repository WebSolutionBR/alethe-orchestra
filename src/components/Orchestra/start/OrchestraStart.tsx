import { ArrowLeft, FolderOpen, FolderPlus, Play, TriangleAlert } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react'

import { pickDirectory } from '../../../lib/dialog'
import { type MessageKey, useT } from '../../../lib/i18n'
import { formatShortcut } from '../../../lib/platform'
import { ORCHESTRATOR_ID, useOrchestraStore } from '../../../stores/orchestraStore'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { AttentionToggle } from '../attention/AttentionToggle'
import { CreativeToggle } from '../creative/CreativeToggle'
import { showSession, syncSidebarProject } from '../navigation'
import styles from '../Orchestra.module.css'
import { LaunchOptionsPicker } from '../usage/LaunchOptions'
import {
  clearChosenFolder,
  resolveStartFolder,
  type StartBlocker,
  startBlocker,
  type StartFolder,
  writeChosenFolder,
} from './folder'
import { ModeSwitch } from './ModeSwitch'
import { AUTONOMOUS_ON_START, clearGoalDraft, readGoalDraft, writeGoalDraft } from './prefs'
import start from './Start.module.css'

const BLOCKER_KEY: Record<StartBlocker, MessageKey> = {
  noProjects: 'orchestra.start.blockNoProjects',
  noProject: 'orchestra.start.blockNoProject',
  noFolder: 'orchestra.start.blockNoFolder',
}

/** True when the key event comes from a text field or a terminal, which own their keys. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], .xterm'))
  )
}

/** Start screen of a new orchestration: project and folder, goal, launch options and mode. */
export function OrchestraStart() {
  const t = useT()
  const allProjects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const startOrchestra = useOrchestraStore((s) => s.start)
  const storeError = useOrchestraStore((s) => s.error)
  // With orchestrations running, launching another one can be cancelled: back to the last one.
  const returnTo = useOrchestraStore((s) => s.recent[0] ?? null)
  const modeId = useId()
  const blockerId = useId()

  useEffect(() => {
    if (!returnTo) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return
      // Esc elsewhere (a sidebar menu, a popover) belongs to whatever has the focus there.
      const target = e.target instanceof Element ? e.target : null
      if (target && target !== document.body && !target.closest(`.${styles.view}`)) return
      showSession(returnTo)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [returnTo])

  // A project picked here only preselects it, so composing never jumps to that project's running
  // orchestration; the sidebar follows once the new one starts. A sidebar change resets the pick.
  const [pick, setPick] = useState<{ base: string | null; id: string } | null>(null)
  const pickedId = pick && pick.base === activeProjectId ? pick.id : activeProjectId

  const projects = useMemo(() => allProjects.filter((p) => !p.archived), [allProjects])
  const project = projects.find((p) => p.id === pickedId) ?? null

  // Bumped when a folder is picked or forgotten so the stored choice is read again.
  const [folderVersion, setFolderVersion] = useState(0)
  const folder = useMemo(
    () => (project ? resolveStartFolder(project, allProjects) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, allProjects, folderVersion],
  )
  const cwd = folder?.path ?? null

  // The goal draft of each project survives view switches and restarts until it starts.
  const [goal, setGoal] = useState(() => readGoalDraft(pickedId))
  useEffect(() => setGoal(readGoalDraft(project?.id)), [project?.id])
  const changeGoal = (text: string) => {
    setGoal(text)
    writeGoalDraft(project?.id, text)
  }

  // Not remembered on purpose: the owner wants every new orchestration to start autonomous.
  const [autonomous, setAutonomous] = useState(AUTONOMOUS_ON_START)
  const [starting, setStarting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const error = localError ?? storeError
  const blocker = startBlocker({
    projectCount: projects.length,
    hasProject: Boolean(project),
    hasFolder: Boolean(cwd),
  })

  const chooseFolder = async () => {
    if (!project) return
    const picked = await pickDirectory({ defaultPath: cwd ?? undefined }).catch(() => null)
    if (!picked) return
    writeChosenFolder(project.id, picked)
    setFolderVersion((v) => v + 1)
  }

  const forgetFolder = () => {
    if (!project) return
    clearChosenFolder(project.id)
    setFolderVersion((v) => v + 1)
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (starting) return
    if (!project) {
      setLocalError(t('orchestra.project.none'))
      return
    }
    if (!cwd) {
      setLocalError(t('orchestra.start.needFolder'))
      return
    }
    setLocalError(null)
    setStarting(true)
    const text = goal.trim()
    try {
      const id = await startOrchestra(cwd, text, autonomous, project.id)
      if (id) {
        clearGoalDraft(project.id)
        // Without a goal the orchestrator terminal opens, where the goal gets typed.
        if (!text) useOrchestraStore.getState().select(id, ORCHESTRATOR_ID)
        syncSidebarProject()
      }
    } catch (err) {
      setLocalError(String(err))
    } finally {
      setStarting(false)
    }
  }

  // Arrow keys move the pick inside the project list, which is a single tab stop.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (projects.length === 0) return
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const current = projects.findIndex((p) => p.id === project?.id)
    const last = projects.length - 1
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : e.key === 'ArrowDown'
            ? current >= last
              ? 0
              : current + 1
            : current <= 0
              ? last
              : current - 1
    setPick({ base: activeProjectId, id: projects[next].id })
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }

  const focusable = project?.id ?? projects[0]?.id

  return (
    <div className={styles.startRoot}>
      <form className={styles.startPanel} onSubmit={(e) => void submit(e)}>
        <header className={styles.startHead}>
          <span className={styles.mark} aria-hidden="true">
            ✻
          </span>
          <div>
            <h1 className={styles.startTitle}>
              {project
                ? `${t('orchestra.start.title')} · ${project.name}`
                : t('orchestra.start.title')}
            </h1>
            <p className={styles.startSubtitle}>{t('orchestra.start.subtitle')}</p>
          </div>
        </header>

        <section className={styles.field}>
          <div className={styles.fieldHead}>
            <span className={styles.label}>{t('orchestra.project.label')}</span>
            <span className={styles.fieldHint}>
              {project ? t('orchestra.start.folderHint') : t('orchestra.project.none')}
            </span>
          </div>
          {projects.length === 0 ? (
            <div className={start.empty}>
              <span className={styles.muted}>{t('orchestra.start.noProjects')}</span>
              <button
                type="button"
                className={styles.btn}
                onClick={() => useUiStore.getState().openModal_('newProject')}
              >
                <FolderPlus size={13} />
                {t('orchestra.start.newProject')}
              </button>
            </div>
          ) : (
            <div
              className={styles.folderList}
              role="radiogroup"
              aria-label={t('orchestra.project.label')}
              onKeyDown={onListKey}
            >
              {projects.map((p) => {
                const on = p.id === project?.id
                const path = on ? cwd : (resolveStartFolder(p, allProjects)?.path ?? null)
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={p.id === focusable ? 0 : -1}
                    className={`${on ? `${styles.folder} ${styles.folderOn}` : styles.folder} ${start.folderFocus}`}
                    onClick={() => setPick({ base: activeProjectId, id: p.id })}
                  >
                    <span className={styles.folderName}>{p.name}</span>
                    <span className={styles.folderPath} title={path ?? undefined}>
                      {path ?? t('orchestra.start.noFolderShort')}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {project ? (
            <FolderNow
              folder={folder}
              onChoose={() => void chooseFolder()}
              onForget={forgetFolder}
            />
          ) : null}
        </section>

        <section className={styles.field}>
          <div className={styles.fieldHead}>
            <label className={styles.label} htmlFor="orchestra-goal">
              {t('orchestra.start.goal')}
            </label>
            <span className={styles.fieldHint}>{t('orchestra.start.goalOptional')}</span>
          </div>
          <textarea
            id="orchestra-goal"
            className={`${styles.goalInput} ${start.goalFocus}`}
            value={goal}
            rows={4}
            placeholder={t('orchestra.start.goalPlaceholder')}
            onChange={(e) => changeGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </section>

        <section className={styles.field}>
          <div className={styles.fieldHead}>
            <span className={styles.label}>{t('orchestra.launch.title')}</span>
            <span className={styles.fieldHint}>{t('orchestra.launch.hint')}</span>
          </div>
          <LaunchOptionsPicker />
        </section>

        <section className={styles.field}>
          <div className={styles.fieldHead}>
            <span id={modeId} className={styles.label}>
              {t('orchestra.start.mode')}
            </span>
          </div>
          <div className={start.modeGroup} role="group" aria-labelledby={modeId}>
            <ModeSwitch
              on={autonomous}
              onChange={setAutonomous}
              label={t('orchestra.start.autonomous')}
              hint={
                autonomous
                  ? t('orchestra.start.autonomousWarning')
                  : t('orchestra.start.supervisedHint')
              }
              hintTone={autonomous ? 'warn' : 'muted'}
            />
            <CreativeToggle />
            <AttentionToggle />
          </div>
        </section>

        {error ? (
          <p className={styles.error} role="alert">
            {t('common.errorPrefix', { message: error })}
          </p>
        ) : null}

        <footer className={styles.startFoot}>
          {returnTo ? (
            <button
              type="button"
              className={styles.btn}
              title={t('orchestra.sessions.backTitle')}
              onClick={() => showSession(returnTo)}
            >
              <ArrowLeft size={13} />
              {t('orchestra.sessions.back')}
            </button>
          ) : null}
          <span className={styles.spacer} />
          {blocker ? (
            <p id={blockerId} className={start.blocker}>
              {t(BLOCKER_KEY[blocker])}
            </p>
          ) : !goal.trim() ? (
            <p className={start.blocker}>{t('orchestra.start.emptyGoalHint')}</p>
          ) : null}
          <span className={styles.kbd}>{formatShortcut('Ctrl+Enter')}</span>
          <button
            type="submit"
            className={styles.primary}
            disabled={starting || blocker !== null}
            aria-describedby={blocker ? blockerId : undefined}
          >
            <Play size={13} />
            {starting ? t('orchestra.start.starting') : t('orchestra.start.submit')}
          </button>
        </footer>
      </form>
    </div>
  )
}

/** The folder the agents will work in, where it comes from, and how to change it. */
function FolderNow({
  folder,
  onChoose,
  onForget,
}: {
  folder: StartFolder | null
  onChoose: () => void
  onForget: () => void
}) {
  const t = useT()
  const origin = !folder
    ? null
    : folder.source === 'chosen'
      ? t('orchestra.start.originChosen')
      : folder.source === 'project'
        ? t('orchestra.start.originProject')
        : folder.inheritedFrom
          ? t('orchestra.start.originInherited', { name: folder.inheritedFrom })
          : t('orchestra.start.originInheritedAny')
  return (
    <div className={start.folderNow}>
      {folder ? (
        <div className={start.folderLine}>
          <span className={start.folderLead}>{t('orchestra.start.folderNow')}</span>
          <span className={start.folderPath}>{folder.path}</span>
          <span
            className={
              folder.source === 'inherited' ? `${start.origin} ${start.originWarn}` : start.origin
            }
          >
            {origin}
          </span>
        </div>
      ) : (
        <span className={styles.fieldHint}>{t('orchestra.project.noFolder')}</span>
      )}
      {folder?.source === 'inherited' ? (
        <p className={start.inherited}>
          <TriangleAlert size={12} aria-hidden="true" />
          {t('orchestra.start.inheritedHint')}
        </p>
      ) : null}
      {folder?.source === 'chosen' ? (
        <span className={styles.fieldHint}>{t('orchestra.start.chosenHint')}</span>
      ) : null}
      <div className={start.folderActions}>
        <button type="button" className={styles.btn} onClick={onChoose}>
          <FolderOpen size={13} />
          {folder ? t('orchestra.project.otherFolder') : t('orchestra.start.chooseFolder')}
        </button>
        {folder?.source === 'chosen' ? (
          <button
            type="button"
            className={styles.btn}
            title={folder.projectPath ?? undefined}
            onClick={onForget}
          >
            {folder.projectPath
              ? t('orchestra.start.useProjectFolder')
              : t('orchestra.start.forgetFolder')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
