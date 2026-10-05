// Copia _fonte/sim-engine.js para dentro de cada variante, entre os marcadores do motor.
// Uso: node _fonte/sync-engine.mjs   (roda na pasta prototipos ou de qualquer lugar)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const engine = readFileSync(path.join(here, 'sim-engine.js'), 'utf8').trim()
const block = /\/\* <sim-engine>[\s\S]*?\/\* <\/sim-engine> \*\//

for (const name of readdirSync(root).filter((entry) => entry.endsWith('.html'))) {
  const file = path.join(root, name)
  const html = readFileSync(file, 'utf8')
  if (!block.test(html)) continue
  const next = html.replace(block, () => engine)
  if (next !== html) {
    writeFileSync(file, next, 'utf8')
    console.log(`atualizado: ${name}`)
  } else {
    console.log(`igual: ${name}`)
  }
}
