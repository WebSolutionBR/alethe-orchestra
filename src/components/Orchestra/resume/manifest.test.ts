import { describe, expect, it } from 'vitest'

import type { BusMessage, OrchestraAgent, OrchestraSession } from '../../../stores/orchestraStore'
import {
  agentFate,
  isConversationId,
  MANIFEST_LINES,
  MANIFEST_MESSAGES,
  manifestOf,
  notResumedPrompt,
  type OrchestraManifest,
  parseManifest,
  resumePlan,
  sameFolder,
  summarizeManifest,
  WORKER_MOVED_PROMPT,
  WORKER_NOT_RESUMED_PROMPT,
  WORKER_RESTARTED_PROMPT,
  WORKER_RESUMED_PROMPT,
} from './manifest'

/** A Claude Code conversation id (a UUID) for each agent. */
const conv = (id: string) =>
  `00000000-0000-4000-8000-${String(id === 'orchestrator' ? 0 : Number(id.split('-')[1])).padStart(12, '0')}`

function agent(id: string, patch: Partial<OrchestraAgent> = {}): OrchestraAgent {
  return {
    id,
    area: id === 'orchestrator' ? 'orchestrator' : 'api',
    task: `task of ${id}`,
    after: [],
    ptyId: `orchestra-oabc1234-${id}-1`,
    state: 'thinking',
    progress: 40,
    note: '',
    lines: [],
    files: [],
    toolCalls: 3,
    startedAt: 1000,
    finishedAt: null,
    history: [],
    account: null,
    model: 'opus',
    effort: null,
    exitCode: null,
    exitReason: null,
    blocked: null,
    claudeSessionId: conv(id),
    transcriptPath: `C:\\Users\\me\\.claude\\projects\\repo\\${conv(id)}.jsonl`,
    launchedWith: { account: null, model: 'opus', effort: null },
    ...patch,
  }
}

function message(id: number, patch: Partial<BusMessage> = {}): BusMessage {
  return { id, at: 2000 + id, from: 'orchestrator', to: 'claude-1', text: `m${id}`, ...patch }
}

function session(patch: Partial<OrchestraSession> = {}): OrchestraSession {
  return {
    id: 'oabc1234',
    projectId: 'p1',
    cwd: 'C:\\repo',
    goal: 'Ler "Markdown" & mais',
    autonomous: true,
    startedAt: 1000,
    mode: 'flow',
    agents: [agent('orchestrator'), agent('claude-1')],
    messages: [message(1)],
    segments: [{ agentId: 'claude-1', kind: 'editing', start: 1, end: null }],
    selectedId: 'claude-1',
    error: null,
    ...patch,
  }
}

function manifest(patch: Partial<OrchestraManifest> = {}): OrchestraManifest {
  return { ...manifestOf(session(), 5000), ...patch }
}

describe('manifestOf', () => {
  it('keeps what a resume needs and leaves view state out', () => {
    const lines = Array.from({ length: MANIFEST_LINES + 5 }, (_, i) => ({
      at: i,
      text: `line ${i}`,
      tone: 'tool' as const,
    }))
    const messages = Array.from({ length: MANIFEST_MESSAGES + 3 }, (_, i) => message(i + 1))
    const saved = manifestOf(
      session({ agents: [agent('orchestrator'), agent('claude-1', { lines })], messages }),
      7000,
    )
    expect(saved).toMatchObject({
      version: 1,
      id: 'oabc1234',
      savedAt: 7000,
      projectId: 'p1',
      cwd: 'C:\\repo',
      goal: 'Ler "Markdown" & mais',
      autonomous: true,
      mode: 'flow',
    })
    expect(saved.agents[1].claudeSessionId).toBe(conv('claude-1'))
    expect(saved.agents[1].launchedWith).toEqual({ account: null, model: 'opus', effort: null })
    expect(saved.agents[1].lines).toHaveLength(MANIFEST_LINES)
    expect(saved.agents[1].lines.at(-1)?.text).toBe(`line ${MANIFEST_LINES + 4}`)
    expect(saved.messages).toHaveLength(MANIFEST_MESSAGES)
    expect(saved.messages[0].id).toBe(4)
    expect(saved).not.toHaveProperty('segments')
    expect(saved).not.toHaveProperty('selectedId')
  })
})

describe('parseManifest', () => {
  it('reads back what manifestOf wrote, through JSON', () => {
    const saved = manifestOf(session(), 5000)
    expect(parseManifest(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  it('refuses what cannot be a manifest', () => {
    for (const raw of [
      null,
      'text',
      [],
      { ...manifest(), version: 2 },
      { ...manifest(), id: '../etc' },
      { ...manifest(), id: 'Bad Id' },
      { id: 'oabc1234', damaged: true },
    ]) {
      expect(parseManifest(raw)).toBeNull()
    }
  })

  it('drops damaged agents and messages and fills safe defaults', () => {
    const parsed = parseManifest({
      version: 1,
      id: 'oabc1234',
      agents: [
        { id: 'orchestrator', state: 'idle' },
        { id: 'claude-1', state: 'dancing' },
        { id: '../x', state: 'done' },
        { id: 'claude-2', state: 'done', progress: 250, after: ['claude-1', 'BAD', 3] },
        { id: 'claude-2', state: 'thinking' },
        'garbage',
      ],
      messages: [message(1), { id: 'x', text: 'no' }, { id: 2 }, message(3, { delivery: 'nope' })],
      goal: 5,
      autonomous: 'yes',
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.agents.map((a) => a.id)).toEqual(['orchestrator', 'claude-2'])
    expect(parsed!.agents[1]).toMatchObject({
      progress: 100,
      after: ['claude-1'],
      lines: [],
      history: [],
      claudeSessionId: null,
      launchedWith: null,
    })
    expect(parsed!.messages.map((m) => m.id)).toEqual([1, 3])
    expect(parsed!.messages[1].delivery).toBeUndefined()
    expect(parsed!.goal).toBe('')
    expect(parsed!.autonomous).toBe(false)
    expect(parsed!.cwd).toBeNull()
  })

  it('never keeps a conversation id that is not a UUID (it would reach claude --resume)', () => {
    const forged = parseManifest({
      version: 1,
      id: 'oabc1234',
      agents: [{ id: 'claude-1', state: 'thinking', claudeSessionId: 'a&calc' }],
    })
    expect(forged!.agents[0].claudeSessionId).toBeNull()
    expect(isConversationId(conv('claude-1'))).toBe(true)
    expect(isConversationId('a&calc')).toBe(false)
    expect(isConversationId(`${conv('claude-1')} --x`)).toBe(false)
    expect(isConversationId(null)).toBe(false)
  })
})

describe('resumePlan', () => {
  const mixed = () =>
    manifest({
      agents: [
        agent('orchestrator', { state: 'idle' }),
        agent('claude-1', { state: 'done', progress: 100, area: 'core' }),
        agent('claude-2', { state: 'editing', area: 'ui' }),
        agent('claude-3', { state: 'idle', claudeSessionId: null, area: 'docs' }),
        agent('claude-4', { state: 'waiting', after: ['claude-2'], ptyId: null }),
        agent('claude-5', { state: 'exited', exitCode: 1, exitReason: 'exited' }),
        agent('claude-6', {
          state: 'blocked',
          blocked: { reason: 'dependency', text: 'claude-5', at: 1 },
        }),
        agent('claude-7', {
          state: 'blocked',
          blocked: { reason: 'permission', text: 'Allow Bash?', at: 1 },
        }),
      ],
      messages: [
        message(1, { delivery: 'delivered' }),
        message(2, { delivery: 'pending' }),
        message(3, { delivery: 'queued', to: 'claude-4' }),
        message(4, { from: 'claude-9', to: 'orchestrator' }),
      ],
    })

  it('relaunches the orchestrator and every unfinished worker, in their conversations', () => {
    const plan = resumePlan(mixed())
    expect(plan.launches.map((l) => l.agentId)).toEqual([
      'orchestrator',
      'claude-2',
      'claude-3',
      'claude-7',
    ])
    const byId = Object.fromEntries(plan.launches.map((l) => [l.agentId, l.resume]))
    expect(byId['orchestrator'].claudeSessionId).toBe(conv('orchestrator'))
    expect(byId['orchestrator'].prompt).toBe(plan.notice)
    expect(byId['claude-2']).toEqual({
      claudeSessionId: conv('claude-2'),
      prompt: WORKER_RESUMED_PROMPT,
    })
    expect(byId['claude-3']).toEqual({ claudeSessionId: null, prompt: WORKER_RESTARTED_PROMPT })
  })

  it('leaves a worker that had failed as it was: its task may be someone else’s now', () => {
    const plan = resumePlan(mixed())
    expect(plan.launches.some((l) => l.agentId === 'claude-5')).toBe(false)
    const failed = plan.agents.find((a) => a.id === 'claude-5')!
    expect(failed).toMatchObject({ state: 'exited', exitCode: 1, ptyId: null })
    expect(plan.notice).toContain(
      'Failed before the close and not relaunched (the user can restart them from their panels): claude-5 (api).',
    )
    expect(plan.notice).not.toMatch(/Resumed in their own conversations:[^.]*claude-5/)
  })

  it('restores the agents ready to start, and leaves finished and waiting ones alone', () => {
    const agents = Object.fromEntries(resumePlan(mixed()).agents.map((a) => [a.id, a]))
    for (const id of ['orchestrator', 'claude-2', 'claude-3', 'claude-7']) {
      expect(agents[id]).toMatchObject({
        state: 'starting',
        ptyId: null,
        exitCode: null,
        exitReason: null,
        blocked: null,
        finishedAt: null,
      })
    }
    expect(agents['claude-1']).toMatchObject({ state: 'done', progress: 100, ptyId: null })
    expect(agents['claude-4'].state).toBe('waiting')
    expect(agents['claude-6']).toMatchObject({
      state: 'blocked',
      blocked: { reason: 'dependency' },
    })
    // What the agents did is kept.
    expect(agents['claude-2']).toMatchObject({ progress: 40, toolCalls: 3, model: 'opus' })
  })

  it('brings each agent back on the account, model and effort it ran with', () => {
    const plan = resumePlan(
      manifest({
        agents: [
          agent('orchestrator', {
            launchedWith: { account: 'acc-a', model: 'opus', effort: 'max' },
          }),
          // Ran on Claude Code's own config dir: the explicit null must survive.
          agent('claude-1', { launchedWith: { account: null, model: 'sonnet', effort: null } }),
          // A manifest from before `launchedWith`: the agent's fields held the same values.
          agent('claude-2', { launchedWith: undefined, account: 'acc-b', model: 'haiku' }),
          // Never launched: nothing to keep, today's defaults apply when it starts.
          agent('claude-3', {
            launchedWith: undefined,
            ptyId: null,
            claudeSessionId: null,
            state: 'starting',
          }),
        ],
      }),
    )
    const byId = Object.fromEntries(plan.agents.map((a) => [a.id, a.launchedWith]))
    expect(byId['orchestrator']).toEqual({ account: 'acc-a', model: 'opus', effort: 'max' })
    expect(byId['claude-1']).toEqual({ account: null, model: 'sonnet', effort: null })
    expect(byId['claude-2']).toEqual({ account: 'acc-b', model: 'haiku', effort: null })
    expect(byId['claude-3']).toBeNull()
  })

  it('in another folder, every agent starts over instead of looking for its conversation', () => {
    const plan = resumePlan(mixed(), { folderChanged: true })
    for (const launch of plan.launches) expect(launch.resume.claudeSessionId).toBeNull()
    const byId = Object.fromEntries(plan.launches.map((l) => [l.agentId, l.resume.prompt]))
    expect(byId['claude-2']).toBe(WORKER_MOVED_PROMPT)
    expect(byId['claude-3']).toBe(WORKER_MOVED_PROMPT)
    expect(plan.notice).toContain('It now runs in another folder')
    expect(plan.notice).not.toContain('Resumed in their own conversations')
  })

  it('marks messages still on their way as failed, so they can be sent again', () => {
    const messages = resumePlan(mixed()).messages
    expect(messages.map((m) => [m.id, m.delivery, m.failure])).toEqual([
      [1, 'delivered', undefined],
      [2, 'failed', 'exited'],
      [3, 'failed', 'exited'],
      [4, undefined, undefined],
    ])
  })

  it('numbers new workers after the highest claude-N, bus included', () => {
    expect(resumePlan(mixed()).nextWorker).toBe(10)
    expect(resumePlan(manifest({ agents: [agent('orchestrator')], messages: [] })).nextWorker).toBe(
      1,
    )
  })

  it('tells the orchestrator what came back, on one line', () => {
    const { notice } = resumePlan(mixed())
    expect(notice).not.toMatch(/[\r\n]/)
    expect(notice).toContain('Alethe was closed while this orchestration was running')
    expect(notice).toContain('Resumed in their own conversations: claude-2 (ui), claude-7 (api).')
    expect(notice).toContain('no conversation to resume): claude-3 (docs).')
    expect(notice).toContain('Already finished before the close: claude-1 (core).')
    expect(notice).toContain(
      'Still waiting for their dependencies: claude-4 (api), claude-6 (api).',
    )
    expect(notice).toContain('2 bus message(s) had not been delivered')
    expect(notice).toContain('numbered from claude-10')
  })

  it('brings back an orchestrator even when the manifest lost it', () => {
    const plan = resumePlan(manifest({ agents: [agent('claude-1')] }))
    expect(plan.agents[0]).toMatchObject({ id: 'orchestrator', state: 'starting' })
    expect(plan.launches[0]).toEqual({
      agentId: 'orchestrator',
      resume: { claudeSessionId: null, prompt: plan.notice },
    })
  })
})

describe('summary, fate and the not-resumed fallback', () => {
  it('counts the workers by what a resume does with them', () => {
    const plan = manifest({
      agents: [
        agent('orchestrator'),
        agent('claude-1', { state: 'done' }),
        agent('claude-2', { state: 'exited' }),
        agent('claude-3', { state: 'waiting' }),
        agent('claude-4', { state: 'thinking', claudeSessionId: null }),
      ],
    })
    expect(summarizeManifest(plan)).toEqual({
      workers: 4,
      done: 1,
      failed: 1,
      waiting: 1,
      unfinished: 1,
    })
    expect(plan.agents.map((a) => agentFate(a))).toEqual([
      'resume',
      'finished',
      'failed',
      'wait',
      'restart',
    ])
    expect(agentFate(plan.agents[0], { folderChanged: true })).toBe('restart')
  })

  it('starts a worker over and keeps the orchestrator informed when --resume fails', () => {
    expect(notResumedPrompt('claude-2', WORKER_RESUMED_PROMPT)).toBe(WORKER_NOT_RESUMED_PROMPT)
    const orchestrator = notResumedPrompt('orchestrator', '[orchestra] notice.')
    expect(orchestrator.startsWith('[orchestra] notice. ')).toBe(true)
    expect(orchestrator).toContain('could not be resumed')
  })

  it('compares folders the way Windows does', () => {
    expect(sameFolder('C:\\Repo\\', 'c:/repo')).toBe(true)
    expect(sameFolder('C:\\Repo', 'C:\\Repo2')).toBe(false)
    expect(sameFolder(null, 'C:\\Repo')).toBe(false)
  })
})
