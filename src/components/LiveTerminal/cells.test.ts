import { describe, expect, it } from 'vitest'

import type { MirrorLine, MirrorRun } from '../../lib/terminalMirror'
import {
  clipboardText,
  firstMatchFrom,
  lineCells,
  lineText,
  logicalText,
  matchRanges,
  rowRuns,
  rowSignature,
  runSegments,
  selectionText,
  textRanges,
  unitAt,
  usedCells,
} from './cells'

function run(text: string, extra: Partial<MirrorRun> = {}): MirrorRun {
  return {
    text,
    cells: Array.from(text).length,
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    invisible: false,
    ...extra,
  }
}

function line(index: number, runs: MirrorRun[], wrapped = false): MirrorLine {
  return { index, wrapped, runs }
}

describe('runSegments', () => {
  it('keeps ASCII, accents and box drawing as one plain segment', () => {
    expect(runSegments(run('olá ─│ ação'), 4)).toEqual([
      { text: 'olá ─│ ação', cell: 4, cells: 11, boxed: false },
    ])
  })

  it('boxes symbols a fallback font would draw at another width', () => {
    expect(runSegments(run('✻ Thinking…'), 0)).toEqual([
      { text: '✻', cell: 0, cells: 1, boxed: true },
      { text: ' Thinking', cell: 1, cells: 9, boxed: false },
      { text: '…', cell: 10, cells: 1, boxed: true },
    ])
  })

  it('boxes a wide char over its two cells', () => {
    expect(runSegments(run('漢', { cells: 2 }), 6)).toEqual([
      { text: '漢', cell: 6, cells: 2, boxed: true },
    ])
  })

  it('keeps a combining mark with its base char in one cell', () => {
    const segments = runSegments(run('éx', { cells: 2 }), 0)
    expect(segments).toEqual([
      { text: 'é', cell: 0, cells: 1, boxed: true },
      { text: 'x', cell: 1, cells: 1, boxed: false },
    ])
  })

  it('boxes a run whose cells do not match its characters', () => {
    expect(runSegments(run('ab', { cells: 3 }), 1)).toEqual([
      { text: 'ab', cell: 1, cells: 3, boxed: true },
    ])
  })
})

describe('rowRuns and line text', () => {
  const sample = line(0, [run('ab'), run('漢', { cells: 2, fg: '#f00' }), run('cd  ')])

  it('counts the cells of the runs', () => {
    expect(lineCells(sample)).toBe(8)
    expect(lineText(sample)).toBe('ab漢cd  ')
  })

  it('slices a row on cell boundaries; a box stays where its first cell is', () => {
    expect(lineText(sample, 1, 3)).toBe('b漢')
    expect(lineText(sample, 3, 6)).toBe('cd')
    expect(rowRuns(sample, 4, 5).map((part) => part.segments)).toEqual([
      [{ text: 'c', cell: 4, cells: 1, boxed: false }],
    ])
  })

  it('ignores trailing blanks unless they show something', () => {
    expect(usedCells(sample)).toBe(6)
    expect(usedCells(line(1, [run('x'), run('   ', { bg: '#123456' })]))).toBe(4)
    expect(usedCells(line(2, [run('    ')]))).toBe(0)
  })

  it('changes the signature only when the row changes', () => {
    const a = rowSignature(rowRuns(sample))
    expect(
      rowSignature(rowRuns(line(0, [run('ab'), run('漢', { cells: 2, fg: '#f00' }), run('cd  ')]))),
    ).toBe(a)
    expect(
      rowSignature(rowRuns(line(0, [run('ab'), run('漢', { cells: 2, fg: '#0f0' }), run('cd  ')]))),
    ).not.toBe(a)
  })
})

describe('selectionText', () => {
  const lines = [
    line(3, [run('first line   ')]),
    line(4, [run('wrapped part')]),
    line(5, [run(' end   ')], true),
    line(6, [run('last')]),
  ]

  it('joins soft-wrapped rows and trims trailing spaces of logical lines', () => {
    expect(selectionText(lines, { line: 3, cell: 0 }, { line: 6, cell: 4 })).toBe(
      'first line\nwrapped part end\nlast',
    )
  })

  it('cuts the first and last rows at the selected cells', () => {
    expect(selectionText(lines, { line: 3, cell: 6 }, { line: 4, cell: 7 })).toBe('line\nwrapped')
  })

  it('formats the clipboard like xterm.js', () => {
    expect(clipboardText('a\xa0b\nc', false)).toBe('a b\nc')
    expect(clipboardText('a\nb\r\nc', true)).toBe('a\r\nb\r\nc')
  })
})

describe('logical text for links', () => {
  const rows = [line(0, [run('see https://exa')]), line(1, [run('mple.com/x ok')], true)]

  it('maps every character back to its line and cell', () => {
    const logical = logicalText(rows)
    expect(logical.text).toBe('see https://example.com/x ok')
    const start = logical.text.indexOf('https')
    expect(unitAt(logical, { line: 1, cell: 2 })).toBe(17)
    expect(textRanges(logical, start, start + 'https://example.com/x'.length)).toEqual([
      { line: 0, start: 4, end: 15 },
      { line: 1, start: 0, end: 10 },
    ])
  })

  it('maps a wide char to both of its cells', () => {
    const logical = logicalText([line(0, [run('a'), run('漢', { cells: 2 }), run('b')])])
    expect(unitAt(logical, { line: 0, cell: 2 })).toBe(1)
    expect(textRanges(logical, 1, 2)).toEqual([{ line: 0, start: 1, end: 3 }])
  })
})

describe('search ranges', () => {
  it('splits a match that crosses a soft wrap', () => {
    expect(matchRanges({ line: 2, start: 8, end: 13 }, 10)).toEqual([
      { line: 2, start: 8, end: 10 },
      { line: 3, start: 0, end: 3 },
    ])
  })

  it('finds the first match that reaches a line', () => {
    const matches = [
      { line: 0, start: 0, end: 2 },
      { line: 2, start: 8, end: 13 },
      { line: 5, start: 0, end: 1 },
    ]
    expect(firstMatchFrom(matches, 3, 10)).toBe(1)
    expect(firstMatchFrom(matches, 4, 10)).toBe(2)
    expect(firstMatchFrom(matches, 6, 10)).toBe(3)
  })
})
