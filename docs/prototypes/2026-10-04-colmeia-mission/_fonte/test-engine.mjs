// Roda o motor sem navegador e confere o roteiro: nascimentos com --after, bloqueio, falha,
// substituto, ideias do criativo, escriba, conclusão e reinício. Uso: node _fonte/test-engine.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const context = { console, setTimeout, clearTimeout }
context.globalThis = context
vm.createContext(context)
vm.runInContext(readFileSync(path.join(here, 'sim-engine.js'), 'utf8'), context)

const sim = context.AletheSim.create({ seed: 7, loop: true })
const seen = { spawn: [], states: new Set(), messages: new Set(), resets: 0, scribe: 0, permission: 0 }
sim.on('spawn', (e) => seen.spawn.push(`${e.agent.id}${e.agent.after ? `<-${e.agent.after}` : ''}@${e.t.toFixed(1)}`))
sim.on('state', (e) => seen.states.add(e.to))
sim.on('message', (e) => seen.messages.add(e.message.kind))
sim.on('scribe', () => (seen.scribe += 1))
sim.on('permission', () => (seen.permission += 1))
sim.on('reset', () => (seen.resets += 1))

let doneAt = null
for (let i = 0; i < 4000 && seen.resets === 0; i += 1) {
  sim.step(0.1)
  if (doneAt === null && sim.agent('orchestrator')?.state === 'done') doneAt = sim.t
}

const failures = []
const expect = (ok, what) => {
  if (!ok) failures.push(what)
}
expect(seen.spawn.length === 7, `7 nascimentos (veio ${seen.spawn.length}: ${seen.spawn.join(' ')})`)
for (const state of ['starting', 'thinking', 'reading', 'editing', 'testing', 'blocked', 'waiting', 'done', 'exited']) {
  expect(seen.states.has(state), `estado ${state} aparece`)
}
for (const kind of ['task', 'report', 'block', 'answer', 'fail', 'idea', 'scribe', 'chat']) {
  expect(seen.messages.has(kind), `mensagem ${kind} no bus`)
}
expect(seen.permission === 1, 'um pedido de permissão')
expect(seen.scribe >= 8, `escriba grava várias vezes (${seen.scribe})`)
expect(doneAt !== null && doneAt < 260, `sessão termina em menos de 260 s (${doneAt?.toFixed(1)})`)
expect(seen.resets === 1, 'reinicia sozinho depois do fim')

console.log('nascimentos:', seen.spawn.join(' '))
console.log('fim da sessão em', doneAt?.toFixed(1), 's · gravações do escriba:', seen.scribe)
if (failures.length) {
  console.error('FALHOU:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log('ok: roteiro completo')
