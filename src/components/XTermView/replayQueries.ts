import type { IDisposable, Terminal } from '@xterm/xterm'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

/**
 * Makes xterm ignore the queries of a replayed history while `isReplaying()`
 * holds: device attributes (DA1/DA2/DA3), status and cursor position reports
 * (DSR), mode reports (DECRQM), the terminal version (XTVERSION), setting
 * reports (DECRQSS) and colour queries (OSC 4/10/11/12 with `?`).
 *
 * The program got its answers when it first asked; answering again would type
 * the answers into whatever it is doing now. Outside a replay every query falls
 * through to xterm's own handlers, so a live program is answered as usual.
 */
export function swallowReplayedQueries(
  terminal: Pick<Terminal, 'parser'>,
  isReplaying: () => boolean,
): IDisposable[] {
  const swallow = () => isReplaying()
  const { parser } = terminal
  return [
    parser.registerCsiHandler({ final: 'c' }, swallow),
    parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow),
    parser.registerCsiHandler({ prefix: '=', final: 'c' }, swallow),
    parser.registerCsiHandler({ final: 'n' }, swallow),
    parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow),
    parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow),
    parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow),
    parser.registerCsiHandler({ prefix: '>', final: 'q' }, swallow),
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow),
    ...[4, 10, 11, 12].map((ident) =>
      parser.registerOscHandler(ident, (data) => isReplaying() && data.includes('?')),
    ),
  ]
}

/**
 * Whether `data` is a focus report. xterm sends one as soon as a program turns
 * focus reporting on, so a replay that turns it back on would send one too; no
 * key produces either sequence.
 */
export function isFocusReport(data: string): boolean {
  return data === FOCUS_IN || data === FOCUS_OUT
}
