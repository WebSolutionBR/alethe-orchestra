// Abre uma variante no Edge headless, deixa a simulação rodar e confere a saúde da página.
// Uso: node _fonte/check.mjs <arquivo.html> [--shot saida.png] [--size 1440x900] [--query "theme=light"]
//      [--budget 8000]
// Lê do DOM final: data-sim-t (tempo simulado), data-errors (erros de JS) e #__errors.
// Sai com código 1 se houver erro de JS ou se a simulação não avançou.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--') && arg.endsWith('.html'))
if (!file) {
  console.error('uso: node _fonte/check.mjs <arquivo.html> [--shot saida.png] [--size 1440x900] [--query "theme=light"]')
  process.exit(2)
}
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const size = option('--size', '1440x900').replace('x', ',')
const query = option('--query', '')
const budget = option('--budget', '8000')
const shot = option('--shot', null)
const url = pathToFileURL(path.resolve(file)).href + (query ? `?${query}` : '')

const run = (extra) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'proto-edge-'))
  try {
    return execFileSync(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--allow-file-access-from-files',
        '--hide-scrollbars',
        `--window-size=${size}`,
        `--virtual-time-budget=${budget}`,
        ...extra,
        url,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}

const dom = run(['--dump-dom'])
const attr = (name) => {
  const match = dom.match(new RegExp(`<html[^>]*\\s${name}="([^"]*)"`))
  return match ? match[1] : null
}
const simT = Number(attr('data-sim-t') ?? 'NaN')
const errors = Number(attr('data-errors') ?? '0')
const errorList = (dom.match(/<pre id="__errors"[^>]*>([\s\S]*?)<\/pre>/) || [])[1] || ''

console.log(`${path.basename(file)}${query ? ` ?${query}` : ''}: sim-t=${simT} errors=${errors}`)
if (errorList.trim()) console.log(errorList.trim())
if (shot) {
  run([`--screenshot=${path.resolve(shot)}`])
  console.log(`screenshot: ${path.resolve(shot)}`)
}
if (errors > 0 || !(simT > 1)) process.exit(1)
