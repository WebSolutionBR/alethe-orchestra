import { Maximize2 } from 'lucide-react'
import {
  type ClipboardEvent,
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import {
  type ActivityLine,
  type BusMessage,
  type OrchestraAgent,
  ORCHESTRATOR_ID,
  useOrchestraStore,
} from '../../../stores/orchestraStore'
import { AgentAlert } from '../AgentAlert'
import { Composer, type ComposerTarget } from '../Composer'
import { CreativeMark } from '../creative/CreativeMark'
import { isCreativeArea } from '../creative/role'
import { DeliveryMark } from '../DeliveryMark'
import { draftKey, useComposerDraft, useDraftText } from '../drafts'
import { isScribeParty, SCRIBE_ID } from '../scribe/identity'
import { ScribeCard } from '../scribe/ScribeMarks'
import { useScribeLines } from '../scribe/useScribe'
import {
  useSession,
  useSessionActions,
  useSessionFocusGetter,
  useSessionId,
} from '../sessionContext'
import {
  areaOf,
  busClock,
  elapsed,
  isBusy,
  isOrchestrator,
  messagesFor,
  overallProgress,
  processEnded,
  workersOf,
} from '../shared'
import styles from './MissionControlView.module.css'

const RING_R = 40
const RING_C = 2 * Math.PI * RING_R
const VISIBLE_LINES = 6

const lastText = (lines: ActivityLine[]) => (lines.length ? lines[lines.length - 1].text : '')

/** Re-renders only itself once per second, so the clock does not churn the whole view. */
function Clock({ from, to }: { from: number; to: number | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (to !== null || !from) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [from, to])
  return <>{from ? elapsed(from, to ?? Date.now()) : '0:00'}</>
}

function StatePill({ state, id }: { state: OrchestraAgent['state']; id?: string }) {
  const t = useT()
  return (
    <span id={id} className={styles.pill} data-state={state}>
      <span className={styles.glyph} data-busy={isBusy(state) || undefined} aria-hidden="true" />
      {t(`orchestra.mission.state.${state}`)}
    </span>
  )
}

function Lines({ lines, live }: { lines: ActivityLine[]; live: boolean }) {
  const t = useT()
  const visible = lines.slice(-VISIBLE_LINES)
  return (
    <div className={styles.term} data-live={live || undefined}>
      {visible.length === 0 ? (
        <div className={styles.lineEmpty}>{t('orchestra.mission.noActivity')}</div>
      ) : (
        visible.map((line, i) => (
          <div
            key={`${line.at}-${lines.length - visible.length + i}`}
            className={styles.line}
            data-tone={line.tone}
          >
            {line.text}
          </div>
        ))
      )}
    </div>
  )
}

function WorkerCard({
  agent,
  selected,
  onSelect,
  onReply,
}: {
  agent: OrchestraAgent
  selected: boolean
  onSelect: (id: string) => void
  /** Opens the composer aimed at this agent. */
  onReply: (id: string) => void
}) {
  const t = useT()
  const open = () => onSelect(agent.id)
  const stateId = useId()
  const progressId = useId()
  return (
    // A click anywhere opens the terminal; for the keyboard the name is the button, so the
    // alert's own buttons never sit inside another control.
    <article
      className={styles.card}
      data-state={agent.state}
      data-selected={selected || undefined}
      onClick={open}
    >
      <header className={styles.cardHead}>
        <span className={styles.cardMark} aria-hidden="true">
          ✻
        </span>
        <button
          type="button"
          className={`${styles.cardId} ${styles.cardOpen}`}
          aria-label={t('orchestra.mission.openTerminal', { id: agent.id })}
          aria-describedby={`${stateId} ${progressId}`}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation()
            open()
          }}
        >
          {agent.id}
        </button>
        <CreativeMark area={agent.area} />
        <span className={styles.cardArea}>{agent.area}</span>
        <span className={styles.spacer} />
        <StatePill state={agent.state} id={stateId} />
      </header>
      <div className={styles.cardTask} title={agent.task}>
        {agent.task}
      </div>
      <div className={styles.prog}>
        <div className={styles.pbar}>
          <i style={{ width: `${agent.progress}%` }} />
        </div>
        <b id={progressId}>{agent.progress}%</b>
      </div>
      {/* The real question, permission or failure, not the last progress note. */}
      {agent.state === 'blocked' && !agent.blocked ? (
        <div className={styles.blocked} role="status">
          <span className={styles.blockedTag}>! {t('orchestra.mission.blockedNote')}</span>
          <span className={styles.blockedNote}>{agent.note || lastText(agent.lines) || ''}</span>
        </div>
      ) : (
        <AgentAlert
          agent={agent}
          compact
          onReply={() => onReply(agent.id)}
          onOpenTerminal={() => onSelect(agent.id)}
        />
      )}
      {agent.state === 'waiting' && agent.after.length > 0 && (
        <div className={styles.waits}>
          {t('orchestra.mission.waitsFor', { deps: agent.after.join(', ') })}
        </div>
      )}
      <Lines lines={agent.lines} live={isBusy(agent.state)} />
      <footer className={styles.cardFoot}>
        <span>{t('orchestra.mission.filesCount', { count: agent.files.length })}</span>
        <span>{t('orchestra.mission.toolsCount', { count: agent.toolCalls })}</span>
        <span className={styles.spacer} />
        <span>
          <Clock from={agent.startedAt} to={agent.finishedAt} />
        </span>
      </footer>
    </article>
  )
}

function OrchestratorCard({
  orchestrator,
  workers,
  agents,
  goal,
  startedAt,
  selected,
  onSelect,
  onReply,
}: {
  orchestrator: OrchestraAgent | undefined
  workers: OrchestraAgent[]
  agents: OrchestraAgent[]
  goal: string
  startedAt: number
  selected: boolean
  onSelect: (id: string) => void
  onReply: (id: string) => void
}) {
  const t = useT()
  const overall = overallProgress(agents)
  const toolCalls = agents.reduce((sum, a) => sum + a.toolCalls, 0)
  const files = useMemo(() => new Set(agents.flatMap((a) => a.files)).size, [agents])
  const active = workers.filter((w) => isBusy(w.state)).length
  const blocked = workers.filter((w) => w.state === 'blocked').length
  const lastLine = orchestrator?.note || (orchestrator ? lastText(orchestrator.lines) : '') || ''
  const open = () => onSelect(ORCHESTRATOR_ID)
  const stateId = useId()
  const progressId = useId()

  return (
    // As on the worker cards: the whole card takes clicks, the name is the keyboard's button.
    <section className={styles.orch} data-selected={selected || undefined} onClick={open}>
      <div className={styles.ring}>
        <svg viewBox="0 0 92 92" aria-hidden="true">
          <circle className={styles.ringTrack} cx="46" cy="46" r={RING_R} />
          <circle
            className={styles.ringVal}
            cx="46"
            cy="46"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - overall / 100)}
          />
        </svg>
        <div className={styles.ringLabel} id={progressId}>
          <b>{overall}%</b>
          <span>{t('orchestra.mission.overall')}</span>
        </div>
      </div>

      <div className={styles.orchInfo}>
        <div className={styles.orchTop}>
          <span className={styles.orchMark} aria-hidden="true">
            ✻
          </span>
          <button
            type="button"
            className={styles.cardOpen}
            aria-label={t('orchestra.mission.openTerminal', { id: ORCHESTRATOR_ID })}
            aria-describedby={orchestrator ? `${stateId} ${progressId}` : progressId}
            aria-pressed={selected}
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
          >
            {ORCHESTRATOR_ID}
          </button>
          <span className={styles.orchWho}>· {t('orchestra.mission.you')}</span>
          {orchestrator && <StatePill state={orchestrator.state} id={stateId} />}
          {blocked > 0 && (
            <span className={styles.pending}>
              ! {t('orchestra.mission.blockedCount', { count: blocked })}
            </span>
          )}
        </div>
        <div className={styles.goal} title={goal}>
          {goal || t('orchestra.mission.noGoal')}
        </div>
        {lastLine && (
          <div className={styles.orchLine} title={lastLine}>
            <i aria-hidden="true">›</i> {lastLine}
          </div>
        )}
        {orchestrator ? (
          <AgentAlert
            agent={orchestrator}
            compact
            onReply={() => onReply(ORCHESTRATOR_ID)}
            onOpenTerminal={open}
          />
        ) : null}
        {workers.length > 0 && (
          <div
            className={styles.strip}
            style={{ gridTemplateColumns: `repeat(${workers.length}, minmax(0, 1fr))` }}
          >
            {workers.map((w) => (
              <div key={w.id} title={`${w.id} · ${w.progress}%`}>
                <i data-state={w.state} style={{ width: `${w.progress}%` }} />
              </div>
            ))}
          </div>
        )}
      </div>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>{t('orchestra.mission.elapsed')}</dt>
          <dd>
            <Clock from={startedAt} to={null} />
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>{t('orchestra.mission.workers')}</dt>
          <dd>
            {active}/{workers.length}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>{t('orchestra.mission.toolCalls')}</dt>
          <dd>{toolCalls}</dd>
        </div>
        <div className={styles.stat}>
          <dt>{t('orchestra.mission.files')}</dt>
          <dd>{files}</dd>
        </div>
      </dl>
    </section>
  )
}

function roleOf(id: string, area?: string): 'orch' | 'you' | 'scribe' | 'creative' | 'worker' {
  if (id === ORCHESTRATOR_ID) return 'orch'
  if (id === 'you') return 'you'
  if (isScribeParty(id)) return 'scribe'
  if (isCreativeArea(area)) return 'creative'
  return 'worker'
}

/** Which agent the composer writes to while it is open; set from a card's Reply. */
type ComposerState = { open: boolean; target: string }

function MessageBus({
  messages,
  agents,
  startedAt,
  composer,
  onComposerChange,
}: {
  messages: BusMessage[]
  agents: OrchestraAgent[]
  startedAt: number
  composer: ComposerState
  onComposerChange: (next: ComposerState) => void
}) {
  const t = useT()
  const { sendTo } = useSessionActions()
  const hasFocus = useSessionFocusGetter()
  const sessionId = useSessionId()
  const [filter, setFilter] = useState<string | null>(null)
  // Drafts outlive view and session switches; they are cleared once sent.
  const [draft, setDraft] = useDraftText(draftKey.quick(sessionId))
  // A stopped orchestration is read-only: nothing to send to.
  const stopped = useSession((s) => Boolean(s.stoppedAt))
  const feedRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  const chips = useMemo(() => {
    const ids = [ORCHESTRATOR_ID, ...workersOf(agents).map((a) => a.id)]
    if (messages.some((m) => m.from === 'you')) ids.push('you')
    if (messages.some((m) => m.from === SCRIBE_ID)) ids.push(SCRIBE_ID)
    return ids.map((id) => ({ id, count: messagesFor(messages, id).length }))
  }, [agents, messages])

  const visible = useMemo(() => messagesFor(messages, filter), [messages, filter])

  // Stay glued to the newest message unless the user scrolled up to read history.
  useEffect(() => {
    const el = feedRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [visible])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void sendTo(ORCHESTRATOR_ID, text)
  }

  // The modal composer keeps its own draft while closed; the quick input text seeds it.
  const [composerDraft, setComposerDraft] = useComposerDraft(sessionId)
  const [pasteOnOpen, setPasteOnOpen] = useState<{ image?: Blob } | null>(null)
  const draftForComposer = useRef(draft)
  draftForComposer.current = draft
  const composerDraftRef = useRef(composerDraft)
  composerDraftRef.current = composerDraft

  const openComposer = (target?: string) => {
    const seed = draftForComposer.current.trim()
    if (seed) {
      const d = composerDraftRef.current
      setComposerDraft({ ...d, text: d.text ? `${d.text}\n${seed}` : seed })
      setDraft('')
    }
    onComposerChange({ open: true, target: target ?? composer.target })
  }

  /** Sends from the composer; a message that could not be delivered keeps the draft. */
  const sendFromComposer = async (to: string, text: string) => {
    const sent = await useOrchestraStore.getState().send(sessionId, to, text)
    if (sent.delivery === 'failed') {
      const failure = useOrchestraStore
        .getState()
        .sessions[sessionId]?.messages.find((m) => m.id === sent.id)?.failure
      throw new Error(
        t('orchestra.delivery.sendFailed', {
          reason: t(`orchestra.delivery.failed.${failure ?? 'write'}` as MessageKey),
        }),
      )
    }
  }
  const openComposerRef = useRef(openComposer)
  const stoppedRef = useRef(stopped)
  stoppedRef.current = stopped
  openComposerRef.current = openComposer

  // Ctrl+Shift+M opens the composer from anywhere in the view, a focused terminal included.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!hasFocus() || stoppedRef.current) return
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== 'KeyM') return
      e.preventDefault()
      e.stopPropagation()
      openComposerRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hasFocus])

  const targets = useMemo<ComposerTarget[]>(
    () =>
      [...agents.filter(isOrchestrator), ...workersOf(agents)].map((a) => ({
        id: a.id,
        hint: isOrchestrator(a) ? undefined : a.area,
        // A worker that has not started takes messages too: they wait in its queue. One whose
        // process ended (failed, or gone after reporting done) takes none.
        live: !processEnded(a),
      })),
    [agents],
  )

  // Files or an image pasted into the quick input move the message into the composer.
  const onQuickPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    setPasteOnOpen({ image: files.find((f) => f.type.startsWith('image/')) })
    openComposer()
  }

  const label = (id: string) => (id === 'you' ? t('orchestra.mission.you') : id)

  return (
    <aside className={styles.bus} aria-label={t('orchestra.mission.bus')}>
      <div className={styles.busHead}>
        <span>{t('orchestra.mission.bus')}</span>
        <span className={styles.spacer} />
        <span className={styles.faint}>
          {t('orchestra.mission.busCount', { count: messages.length })}
        </span>
      </div>
      <div className={styles.chips} role="group" aria-label={t('orchestra.mission.busFilter')}>
        <button
          type="button"
          className={styles.chip}
          aria-pressed={filter === null}
          onClick={() => setFilter(null)}
        >
          <i data-role="all" />
          {t('orchestra.mission.filterAll')}
          <span className={styles.faint}>{messages.length}</span>
        </button>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={styles.chip}
            aria-pressed={filter === chip.id}
            onClick={() => setFilter(filter === chip.id ? null : chip.id)}
          >
            <i data-role={roleOf(chip.id, areaOf(agents, chip.id))} />
            {label(chip.id)}
            <span className={styles.faint}>{chip.count}</span>
          </button>
        ))}
      </div>
      <div
        className={styles.feed}
        ref={feedRef}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {visible.length === 0 ? (
          <div className={styles.feedEmpty}>
            {filter
              ? t('orchestra.mission.busEmptyFiltered', { id: label(filter) })
              : t('orchestra.mission.busEmpty')}
          </div>
        ) : (
          visible.map((m) => (
            <div
              key={m.id}
              className={styles.msg}
              data-from={roleOf(m.from, areaOf(agents, m.from))}
              data-done={m.text.startsWith('done ·') || undefined}
            >
              <div className={styles.msgHead}>
                <span className={styles.faint}>{busClock(m.at, startedAt)}</span>
                <span data-role={roleOf(m.from, areaOf(agents, m.from))}>{label(m.from)}</span>
                <span className={styles.faint}>→</span>
                <span data-role={roleOf(m.to, areaOf(agents, m.to))}>{label(m.to)}</span>
                <DeliveryMark message={m} />
              </div>
              <div className={styles.msgBody}>{m.text}</div>
            </div>
          ))
        )}
      </div>
      <form className={styles.composer} onSubmit={submit} autoComplete="off">
        <span aria-hidden="true">›</span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onQuickPaste}
          disabled={stopped}
          placeholder={t('orchestra.mission.composerPlaceholder')}
          aria-label={t('orchestra.mission.composerLabel')}
        />
        <button
          type="button"
          className={styles.expand}
          onClick={() => openComposer()}
          disabled={stopped}
          aria-label={t('orchestra.composer.open')}
          title={t('orchestra.composer.open')}
          data-pending={composerDraft.text || composerDraft.attachments.length ? true : undefined}
        >
          <Maximize2 size={13} />
        </button>
      </form>
      {composer.open ? (
        <Composer
          targets={targets}
          target={composer.target}
          onTargetChange={(target) => onComposerChange({ open: true, target })}
          draft={composerDraft}
          onDraftChange={setComposerDraft}
          onSend={sendFromComposer}
          onClose={() => {
            onComposerChange({ open: false, target: composer.target })
            setPasteOnOpen(null)
          }}
          pasteOnOpen={pasteOnOpen}
        />
      ) : null}
    </aside>
  )
}

export function MissionControlView() {
  const t = useT()
  const agents = useSession((s) => s.agents)
  const messages = useSession((s) => s.messages)
  const goal = useSession((s) => s.goal)
  const startedAt = useSession((s) => s.startedAt)
  const selectedId = useSession((s) => s.selectedId)
  const { select } = useSessionActions()
  const sessionId = useSessionId()
  const scribeLines = useScribeLines(messages)

  const orchestrator = agents.find(isOrchestrator)
  const workers = useMemo(() => workersOf(agents), [agents])
  const [composer, setComposer] = useState<ComposerState>({ open: false, target: ORCHESTRATOR_ID })
  // Reply on a blocked card: the composer opens aimed at that agent.
  const reply = (id: string) => setComposer({ open: true, target: id })

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <OrchestratorCard
          orchestrator={orchestrator}
          workers={workers}
          agents={agents}
          goal={goal}
          startedAt={startedAt}
          selected={selectedId === ORCHESTRATOR_ID}
          onSelect={select}
          onReply={reply}
        />
        <ScribeCard sessionId={sessionId} lines={scribeLines} />
        {workers.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyMark} aria-hidden="true">
              ✻
            </span>
            <h2>{t('orchestra.mission.emptyTitle')}</h2>
            <p>{t('orchestra.mission.emptyBody')}</p>
            {orchestrator && (
              <button
                type="button"
                className={styles.emptyAction}
                onClick={() => select(ORCHESTRATOR_ID)}
              >
                {t('orchestra.mission.emptyAction')}
              </button>
            )}
          </div>
        ) : (
          <section className={styles.grid} aria-label={t('orchestra.mission.workersLabel')}>
            {workers.map((agent) => (
              <WorkerCard
                key={agent.id}
                agent={agent}
                selected={selectedId === agent.id}
                onSelect={select}
                onReply={reply}
              />
            ))}
          </section>
        )}
      </div>
      <MessageBus
        messages={messages}
        agents={agents}
        startedAt={startedAt}
        composer={composer}
        onComposerChange={setComposer}
      />
    </div>
  )
}
