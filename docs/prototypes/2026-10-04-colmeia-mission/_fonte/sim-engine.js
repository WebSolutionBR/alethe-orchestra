/* <sim-engine> Motor de simulação dos protótipos da Orquestra (Colmeia e Mission Control).
   Fonte única: prototipos/_fonte/sim-engine.js. Cada variante leva uma cópia inline entre os
   marcadores <sim-engine> e </sim-engine>; rode `node _fonte/sync-engine.mjs` para atualizar todas.
   Sem dependências e sem DOM: as variantes desenham, o motor só simula a orquestração. */
;(function (global) {
  'use strict'

  /** Estados reais da Orquestra. Ícone + rótulo + `motion` garantem leitura sem depender de cor. */
  const STATES = {
    starting: { label: 'iniciando', icon: '◌', busy: true, motion: 'spin' },
    thinking: { label: 'pensando', icon: '✻', busy: true, motion: 'breathe' },
    reading: { label: 'lendo', icon: '◎', busy: true, motion: 'scan' },
    editing: { label: 'editando', icon: '✎', busy: true, motion: 'type' },
    testing: { label: 'testando', icon: '▶', busy: true, motion: 'tick' },
    blocked: { label: 'bloqueado', icon: '⏸', busy: false, motion: 'alert' },
    waiting: { label: 'aguardando', icon: '⧗', busy: false, motion: 'none' },
    done: { label: 'concluído', icon: '✓', busy: false, motion: 'none' },
    exited: { label: 'falhou', icon: '✕', busy: false, motion: 'none' },
    idle: { label: 'ocioso', icon: '·', busy: false, motion: 'none' },
  }

  const ROLES = {
    orchestrator: 'orquestrador',
    worker: 'worker',
    creative: 'criativo',
    scribe: 'escriba Obsidian',
  }

  const GOAL = 'Terminal próprio na Orquestra: rolar, copiar e acabar com o texto embaralhado'
  const PROJECT = 'alethe-orchestra'
  const NOTE = '2026-10-04 Orchestra.md'

  /** A equipe do cenário (a sessão real de 04/10/2026, comprimida em ~3 minutos). */
  const PLAN = [
    {
      id: 'claude-2',
      area: 'espelho-core',
      task: 'Um terminal headless por PTY, sempre no tamanho real do PTY',
      files: ['src/lib/terminalMirror/mirror.ts', 'src/lib/terminalMirror/lines.ts', 'src-tauri/src/pty.rs'],
      duration: 52,
      spawnAt: 3,
      blockAt: 0.34,
      permission: { tool: 'Edit', detail: 'src-tauri/src/pty.rs: emitir o pendente antes do clear' },
    },
    {
      id: 'claude-1',
      area: 'xterm-clássico',
      task: 'Restaurar o histórico pelo espelho, sem replay em outra largura',
      files: ['src/components/XTermView/useXtermSession.ts', 'src/lib/terminalReplay.ts'],
      duration: 64,
      spawnAt: 3.6,
      failAt: 0.58,
    },
    {
      id: 'claude-5',
      area: 'obsidian-contexto',
      task: 'Consultar o Obsidian antes de cada orquestração começar',
      files: ['src-tauri/src/obsidian.rs', 'src/components/Orchestra/scribe/context.ts'],
      duration: 58,
      spawnAt: 4.2,
    },
    {
      id: 'claude-6',
      area: 'agente-criativo',
      role: 'creative',
      task: 'Propor recursos úteis e o que costuma passar despercebido',
      files: ['docs/ideias-orquestra.md'],
      duration: 80,
      spawnAt: 4.8,
    },
    {
      id: 'claude-3',
      area: 'live-terminal-ui',
      task: 'Renderizador DOM com grade exata, seleção, busca e links',
      files: ['src/components/LiveTerminal/index.tsx', 'src/components/LiveTerminal/cells.ts', 'src/components/LiveTerminal/layout.ts'],
      duration: 56,
      spawnAt: 5.6,
      after: 'claude-2',
    },
    {
      id: 'claude-4',
      area: 'integração',
      task: 'LiveTerminal no painel do agente e nas células da visão Terminais',
      files: ['src/components/Orchestra/AgentTerminal.tsx', 'src/stores/orchestraStore.ts'],
      duration: 38,
      spawnAt: 6.4,
      after: 'claude-3',
    },
  ]

  const RETRY = {
    id: 'claude-7',
    area: 'xterm-clássico · retomada',
    task: 'Retomar de onde o claude-1 parou e corrigir a restauração',
    files: ['src/components/XTermView/useXtermSession.ts'],
    duration: 30,
  }

  const IDEAS = [
    'atalho para copiar a última resposta de um agente',
    'estado vazio do bus com exemplos de comando',
    'desfazer “parar orquestração” por 5 s',
    'aviso quando um worker fica 2 min sem reportar',
    'exportar a sessão inteira como nota do Obsidian',
  ]

  const THINK = [
    'Pensando no menor caminho que não quebra o contrato…',
    'Comparando com o que o XTermView já faz…',
    'Conferindo o histórico do embaralhamento (7 causas)…',
    'Separando o que é pure function do que é DOM…',
    'Lendo o contrato 00-contrato-live-terminal.md…',
  ]

  function seeded(seed) {
    let s = seed >>> 0 || 1
    return () => {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      return ((s >>> 0) % 1000003) / 1000003
    }
  }

  function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds))
    const m = Math.floor(s / 60)
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  function tokens(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace('.', ',')}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')}k`
    return String(Math.round(n))
  }

  /** Copia texto; usa a Clipboard API e cai para execCommand fora de contexto seguro. */
  function copyText(text) {
    if (global.navigator && navigator.clipboard && global.isSecureContext !== false) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    if (typeof document === 'undefined') return false
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (error) {
      ok = false
    }
    area.remove()
    return ok
  }

  function create(options) {
    const opts = Object.assign({ speed: 1, seed: 7, loop: true, autoApproveAfter: 14 }, options)
    const listeners = new Map()
    let rand = seeded(opts.seed)
    let speed = opts.speed
    let paused = false
    let running = false
    let frame = null
    let last = 0
    let session = 0
    let world = null

    function emit(type, payload) {
      const event = Object.assign({ type, t: world ? world.t : 0 }, payload)
      for (const key of [type, '*']) {
        const set = listeners.get(key)
        if (set) for (const fn of [...set]) {
          try {
            fn(event)
          } catch (error) {
            if (global.console) console.error('[sim] listener', error)
          }
        }
      }
    }

    function on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
      return () => listeners.get(type).delete(fn)
    }

    function makeAgent(def, role, hue) {
      return {
        id: def.id,
        role,
        area: def.area,
        task: def.task,
        files: def.files ? def.files.slice() : [],
        touched: [],
        state: role === 'scribe' ? 'idle' : 'starting',
        progress: 0,
        after: def.after || null,
        hue,
        duration: def.duration || 60,
        blockAt: def.blockAt,
        failAt: def.failAt,
        permission: null,
        pendingPermission: def.permission || null,
        lines: [],
        tokens: 0,
        startedAt: world.t,
        endedAt: null,
        nextLine: 0,
        phaseUntil: 0,
        reported: 0,
        unread: 0,
      }
    }

    function fresh() {
      session += 1
      rand = seeded(opts.seed + session * 97)
      world = {
        t: 0,
        session,
        goal: GOAL,
        project: PROJECT,
        agents: [],
        byId: new Map(),
        bus: [],
        scribe: { note: NOTE, writes: 0, last: null, writing: false },
        timeline: [],
        finishedAt: null,
        nextMessageId: 1,
        spawned: new Set(),
        retried: false,
        ideas: 0,
      }
      const orch = makeAgent(
        { id: 'orchestrator', area: 'orquestração', task: 'Dividir a meta, despachar workers, responder bloqueios e fechar a sessão', duration: 999 },
        'orchestrator',
        0,
      )
      orch.state = 'starting'
      add(orch)
      const scribe = makeAgent({ id: 'obsidian', area: 'escriba', task: `Registrar a sessão em ${NOTE}`, duration: 999 }, 'scribe', 0)
      add(scribe)
      schedule(0.6, () => setState(orch, 'reading'))
      schedule(0.8, () => line(orch, 'tool', '⏺ Read(Alethe Orchestra/2026-10-04 Orchestra.md)'))
      schedule(1.2, () => line(orch, 'note', '  ⎿  Contexto do Obsidian: 3 notas lidas'))
      schedule(1.4, () => scribeWrite('Sessão iniciada · objetivo e contexto'))
      schedule(1.8, () => setState(orch, 'thinking'))
      schedule(2.0, () => line(orch, 'think', '✻ Dividindo a meta em 6 frentes com posse de arquivos disjunta…'))
      for (const def of PLAN) schedule(def.spawnAt, () => spawn(def))
    }

    function add(agent) {
      world.agents.push(agent)
      world.byId.set(agent.id, agent)
    }

    const queue = []
    function schedule(at, fn) {
      queue.push({ at, fn })
      queue.sort((a, b) => a.at - b.at)
    }

    function spawn(def) {
      if (world.spawned.has(def.id)) return
      world.spawned.add(def.id)
      const workers = world.agents.filter((a) => a.role === 'worker' || a.role === 'creative')
      const agent = makeAgent(def, def.role || 'worker', workers.length + 1)
      add(agent)
      const orch = world.byId.get('orchestrator')
      line(orch, 'tool', `⏺ Bash(orch spawn ${agent.id}${agent.after ? ` --after ${agent.after}` : ''})`)
      message('orchestrator', agent.id, `tarefa: ${agent.task}`, 'task')
      emit('spawn', { agent })
      line(agent, 'prompt', `> ${agent.task}`)
      if (agent.after) {
        const dep = world.byId.get(agent.after)
        if (!dep || dep.state !== 'done') {
          setState(agent, 'waiting')
          line(agent, 'note', `  aguardando ${agent.after} terminar (--after)`)
          return
        }
      }
      setState(agent, 'starting')
      agent.phaseUntil = world.t + 1.2
    }

    function setState(agent, next) {
      if (agent.state === next) return
      const from = agent.state
      agent.state = next
      if (next === 'done' || next === 'exited') agent.endedAt = world.t
      world.timeline.push({ at: world.t, id: agent.id, state: next })
      if (world.timeline.length > 600) world.timeline.splice(0, world.timeline.length - 600)
      emit('state', { agent, from, to: next })
    }

    function line(agent, kind, text) {
      const entry = { at: world.t, kind, text }
      agent.lines.push(entry)
      if (agent.lines.length > 400) agent.lines.splice(0, agent.lines.length - 400)
      agent.unread += 1
      emit('line', { agent, line: entry })
    }

    function message(from, to, text, kind) {
      const entry = { id: world.nextMessageId++, at: world.t, from, to, text, kind: kind || 'chat' }
      world.bus.push(entry)
      if (world.bus.length > 250) world.bus.splice(0, world.bus.length - 250)
      emit('message', { message: entry })
      return entry
    }

    function scribeWrite(text) {
      const scribe = world.byId.get('obsidian')
      world.scribe.writes += 1
      world.scribe.last = { at: world.t, text }
      world.scribe.writing = true
      setState(scribe, 'editing')
      line(scribe, 'tool', `⏺ Append(${NOTE})`)
      line(scribe, 'ok', `  ⎿  ${text}`)
      message('obsidian', NOTE, text, 'scribe')
      emit('scribe', { write: world.scribe.last, count: world.scribe.writes })
      schedule(world.t + 1.4, () => {
        world.scribe.writing = false
        setState(scribe, 'idle')
      })
    }

    function pick(list) {
      return list[Math.floor(rand() * list.length) % list.length]
    }

    function workPhase(agent) {
      const p = agent.progress / 100
      if (p < 0.12) return rand() < 0.5 ? 'reading' : 'thinking'
      if (p < 0.72) return rand() < 0.7 ? 'editing' : rand() < 0.5 ? 'reading' : 'thinking'
      if (p < 0.9) return 'testing'
      return 'editing'
    }

    function narrate(agent) {
      const file = pick(agent.files.length ? agent.files : ['README.md'])
      switch (agent.state) {
        case 'starting':
          line(agent, 'note', '  iniciando Claude Code…')
          break
        case 'thinking':
          line(agent, 'think', `✻ ${pick(THINK)}`)
          break
        case 'reading':
          line(agent, 'tool', `⏺ Read(${file})`)
          line(agent, 'note', `  ⎿  Read ${80 + Math.floor(rand() * 400)} lines`)
          break
        case 'editing': {
          const plus = 4 + Math.floor(rand() * 60)
          const minus = Math.floor(rand() * 20)
          line(agent, 'tool', `⏺ Update(${file})`)
          line(agent, 'ok', `  ⎿  Updated ${file} with ${plus} additions and ${minus} removals`)
          if (!agent.touched.includes(file)) agent.touched.push(file)
          break
        }
        case 'testing': {
          const files = 3 + Math.floor(rand() * 6)
          const tests = 20 + Math.floor(rand() * 70)
          line(agent, 'tool', '⏺ Bash(npx vitest run)')
          line(agent, 'ok', `  ⎿  ✓ ${tests} passed (${files} files)`)
          break
        }
        default:
          break
      }
    }

    function report(agent) {
      const step = Math.floor(agent.progress / 25) * 25
      if (step <= agent.reported || step === 0 || step >= 100) return
      agent.reported = step
      const label = STATES[agent.state] ? STATES[agent.state].label : agent.state
      line(agent, 'tool', `⏺ Bash(orch report ${step} ${agent.state} "${agent.area}")`)
      message(agent.id, 'orchestrator', `${step}% · ${label}: ${agent.area}`, 'report')
    }

    function finish(agent) {
      agent.progress = 100
      setState(agent, 'done')
      line(agent, 'tool', `⏺ Bash(orch report 100 done "${agent.area} pronto")`)
      line(agent, 'ok', '  ⎿  ✓ tsc limpo · testes ok · seção registrada no Obsidian')
      message(agent.id, 'orchestrator', `100% · concluído: ${agent.area}`, 'report')
      scribeWrite(`${agent.id} · ${agent.area} concluído`)
      for (const other of world.agents) {
        if (other.after === agent.id && other.state === 'waiting') {
          message('orchestrator', other.id, `${agent.id} terminou: pode começar`, 'task')
          setState(other, 'starting')
          other.startedAt = world.t
          other.phaseUntil = world.t + 1.2
          line(other, 'note', `  ${agent.id} terminou; começando agora`)
        }
      }
    }

    function fail(agent) {
      agent.failing = false
      setState(agent, 'exited')
      line(agent, 'error', '  ⎿  ✕ 2 failed · restaura o histórico em 80 colunas')
      line(agent, 'error', '  processo encerrado com código 1')
      message(agent.id, 'orchestrator', 'falhei: 2 testes de restauração; o PTY encerrou', 'fail')
      scribeWrite(`${agent.id} falhou · substituto a caminho`)
      const orch = world.byId.get('orchestrator')
      schedule(world.t + 2.2, () => {
        line(orch, 'think', `✻ ${agent.id} caiu; mando um substituto que continua do estado atual`)
        if (!world.retried) {
          world.retried = true
          spawn(Object.assign({}, RETRY))
        }
      })
    }

    function block(agent) {
      agent.permission = agent.pendingPermission || { tool: 'Bash', detail: 'npm install' }
      agent.pendingPermission = null
      agent.blockedAt = world.t
      setState(agent, 'blocked')
      line(agent, 'error', `⏸ Permissão: ${agent.permission.tool}(${agent.permission.detail})`)
      line(agent, 'note', '  aguardando aprovação (A aprova, N nega)')
      message(agent.id, 'orchestrator', `pede permissão: ${agent.permission.tool} ${agent.permission.detail}`, 'block')
      emit('permission', { agent, request: agent.permission })
    }

    function resolve(id, approved, by) {
      const agent = world.byId.get(id)
      if (!agent || agent.state !== 'blocked') return false
      const request = agent.permission
      agent.permission = null
      message(by === 'auto' ? 'orchestrator' : 'você', agent.id, approved ? 'aprovado, pode seguir' : 'negado: siga sem tocar nesse arquivo', 'answer')
      line(agent, approved ? 'ok' : 'error', approved ? '  ✓ aprovado' : '  ✕ negado; seguindo por outro caminho')
      setState(agent, approved ? 'editing' : 'thinking')
      agent.phaseUntil = world.t + 2
      emit('resolved', { agent, approved, request })
      return true
    }

    function stepAgent(agent, dt) {
      if (agent.role === 'scribe' || agent.role === 'orchestrator') return
      if (!STATES[agent.state].busy || agent.failing) return
      if (agent.state === 'starting') {
        if (world.t >= agent.phaseUntil) setState(agent, 'reading')
        return
      }
      const rate = (100 / agent.duration) * (0.75 + rand() * 0.5)
      agent.progress = Math.min(100, agent.progress + rate * dt)
      agent.tokens += (60 + rand() * 140) * dt
      if (agent.blockAt && agent.pendingPermission && agent.progress >= agent.blockAt * 100) {
        block(agent)
        return
      }
      if (agent.failAt && agent.progress >= agent.failAt * 100) {
        agent.failAt = null
        agent.failing = true
        setState(agent, 'testing')
        line(agent, 'tool', '⏺ Bash(npx vitest run src/components/XTermView)')
        schedule(world.t + 1.6, () => fail(agent))
        return
      }
      if (agent.id === 'claude-3' && !world.chatted && agent.progress > 30) {
        world.chatted = true
        message('claude-3', 'claude-4', 'deixo data-live-terminal na raiz e no textarea, combinado?', 'chat')
        schedule(world.t + 2, () => message('claude-4', 'claude-3', 'combinado: uso para focar a célula e para o Esc', 'chat'))
      }
      if (agent.progress >= 100) {
        finish(agent)
        return
      }
      if (world.t >= agent.phaseUntil) {
        setState(agent, workPhase(agent))
        agent.phaseUntil = world.t + 2.5 + rand() * 4
      }
      if (world.t >= agent.nextLine) {
        narrate(agent)
        agent.nextLine = world.t + 1.4 + rand() * 2.6
      }
      report(agent)
      if (agent.role === 'creative' && world.ideas < IDEAS.length && agent.progress > 12 + world.ideas * 16) {
        const idea = IDEAS[world.ideas]
        world.ideas += 1
        line(agent, 'ok', `💡 proposta ${world.ideas}: ${idea}`)
        message(agent.id, 'orchestrator', `proposta: ${idea}`, 'idea')
      }
    }

    function stepOrchestrator(dt) {
      const orch = world.byId.get('orchestrator')
      const workers = world.agents.filter((a) => a.role === 'worker' || a.role === 'creative')
      orch.tokens += 30 * dt
      if (world.finishedAt !== null) return
      const blocked = workers.find((a) => a.state === 'blocked')
      if (blocked && opts.autoApproveAfter > 0 && world.t - blocked.blockedAt > opts.autoApproveAfter) {
        line(orch, 'think', `✻ ${blocked.id} esperou demais; aprovo (edição dentro da posse dele)`)
        resolve(blocked.id, true, 'auto')
      }
      if (world.t < 7) return
      if (workers.length > 0 && workers.every((a) => a.state === 'done' || (a.state === 'exited' && world.retried))) {
        world.finishedAt = world.t
        setState(orch, 'testing')
        line(orch, 'tool', '⏺ Bash(npm test)')
        schedule(world.t + 2.5, () => {
          line(orch, 'ok', '  ⎿  ✓ 856 passed (96 files) · tsc limpo')
          setState(orch, 'done')
          message('orchestrator', 'você', 'tudo pronto: 6 frentes concluídas, 1 retomada', 'report')
          scribeWrite('Fechamento da sessão · verificação final ok')
          if (opts.loop) schedule(world.t + 9, () => reset())
        })
        return
      }
      if (orch.state !== 'thinking' && orch.state !== 'reading' && world.t > (orch.phaseUntil || 0)) {
        setState(orch, rand() < 0.6 ? 'thinking' : 'reading')
        orch.phaseUntil = world.t + 4 + rand() * 4
      } else if (world.t > (orch.phaseUntil || 0)) {
        setState(orch, orch.state === 'thinking' ? 'reading' : 'thinking')
        orch.phaseUntil = world.t + 4 + rand() * 4
        if (rand() < 0.5) line(orch, 'think', `✻ ${pick(['Conferindo os reports…', 'Respondendo o bus…', 'Revisando a posse de arquivos…'])}`)
      }
    }

    function advance(dt) {
      world.t += dt
      while (queue.length && queue[0].at <= world.t) queue.shift().fn()
      for (const agent of world.agents) stepAgent(agent, dt)
      stepOrchestrator(dt)
      emit('tick', { dt })
    }

    // Relógio por timer (~30 Hz), não por requestAnimationFrame: segue rodando em miniaturas e no
    // Edge headless (onde o rAF quase não dispara). As variantes animam com CSS e redesenham no 'tick'.
    const TICK_MS = 33
    const now = () => (global.performance && performance.now ? performance.now() : Date.now())

    function loop() {
      frame = null
      if (!running) return
      const current = now()
      const dt = last ? Math.min(0.25, (current - last) / 1000) : 0
      last = current
      if (!paused && dt > 0) advance(dt * speed)
      frame = setTimeout(loop, TICK_MS)
    }

    function start() {
      if (running) return api
      running = true
      last = 0
      frame = setTimeout(loop, 0)
      return api
    }

    function stop() {
      running = false
      if (frame !== null) clearTimeout(frame)
      frame = null
    }

    function reset() {
      queue.length = 0
      fresh()
      emit('reset', {})
    }

    function counts() {
      const out = {}
      for (const key of Object.keys(STATES)) out[key] = 0
      for (const agent of world.agents) if (agent.role !== 'scribe') out[agent.state] += 1
      return out
    }

    function overall() {
      const workers = world.agents.filter((a) => (a.role === 'worker' || a.role === 'creative') && !(a.state === 'exited' && world.retried))
      if (!workers.length) return 0
      return workers.reduce((sum, a) => sum + a.progress, 0) / workers.length
    }

    const api = {
      STATES,
      ROLES,
      on,
      start,
      stop,
      reset,
      pause() {
        paused = true
        emit('pause', { paused })
      },
      resume() {
        paused = false
        emit('pause', { paused })
      },
      toggle() {
        paused = !paused
        emit('pause', { paused })
        return paused
      },
      get paused() {
        return paused
      },
      get speed() {
        return speed
      },
      setSpeed(value) {
        speed = Math.max(0.25, Math.min(8, value))
        emit('speed', { speed })
      },
      /** Avança a simulação na mão (útil com pausa ou em testes). */
      step(seconds) {
        advance(seconds)
      },
      get t() {
        return world.t
      },
      get session() {
        return world.session
      },
      get goal() {
        return world.goal
      },
      get project() {
        return world.project
      },
      get agents() {
        return world.agents
      },
      get workers() {
        return world.agents.filter((a) => a.role === 'worker' || a.role === 'creative')
      },
      get bus() {
        return world.bus
      },
      get scribe() {
        return world.scribe
      },
      get timeline() {
        return world.timeline
      },
      agent(id) {
        return world.byId.get(id) || null
      },
      overall,
      counts,
      approve(id) {
        return resolve(id, true, 'você')
      },
      deny(id) {
        return resolve(id, false, 'você')
      },
      /** Mensagem do usuário a um agente: entra no bus e o agente responde. */
      send(to, text) {
        const agent = world.byId.get(to)
        if (!agent || !text) return null
        const entry = message('você', to, text, 'user')
        line(agent, 'prompt', `> ${text}`)
        schedule(world.t + 1.4, () => {
          const reply = agent.state === 'done' ? 'já terminei; posso revisar se quiser' : 'entendido, incorporo agora'
          line(agent, 'ok', `⏺ ${reply}`)
          message(to, 'você', reply, 'chat')
        })
        return entry
      },
      transcript(id) {
        const agent = world.byId.get(id)
        return agent ? agent.lines.map((l) => l.text).join('\n') : ''
      },
      clock,
      tokens,
      copyText,
    }

    fresh()
    return api
  }

  global.AletheSim = { create, STATES, ROLES, clock, tokens, copyText }
})(typeof window !== 'undefined' ? window : globalThis)
/* </sim-engine> */
