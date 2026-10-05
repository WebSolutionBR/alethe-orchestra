import { type CSSProperties, memo } from 'react'

import type { MirrorRun } from '../../lib/terminalMirror'
import type { RowRun } from './cells'
import styles from './LiveTerminal.module.css'

/** One visual row: cells [c0, c1) of a mirror line, drawn at visual row `row`. */
export type RowModel = {
  row: number
  line: number
  c0: number
  c1: number
  runs: RowRun[]
  signature: string
}

function boxWidth(cells: number): string {
  return cells === 1 ? 'var(--lt-cell-w)' : `calc(var(--lt-cell-w) * ${cells})`
}

function runStyle(run: MirrorRun): CSSProperties | undefined {
  let color = run.fg ?? undefined
  // Faint text keeps its background; only the glyphs fade, as in xterm.js.
  if (run.dim) color = `color-mix(in srgb, ${run.fg ?? 'var(--lt-fg)'} 50%, transparent)`
  if (!color && !run.bg) return undefined
  return { color, backgroundColor: run.bg ?? undefined }
}

function runClass(run: MirrorRun): string | undefined {
  const classes: string[] = []
  if (run.bg) classes.push(styles.filled)
  if (run.bold) classes.push(styles.bold)
  if (run.italic) classes.push(styles.italic)
  if (run.underline && run.strike) classes.push(styles.underStrike)
  else if (run.underline) classes.push(styles.underline)
  else if (run.strike) classes.push(styles.strike)
  if (run.invisible) classes.push(styles.invisible)
  return classes.length > 0 ? classes.join(' ') : undefined
}

function RowView({ model }: { model: RowModel }) {
  return (
    <div
      className={styles.row}
      style={{ top: `calc(${model.row} * var(--lt-row-h))` }}
      data-line={model.line}
      data-c0={model.c0}
      data-c1={model.c1}
    >
      {model.runs.map(({ run, segments }, runIndex) => {
        const className = runClass(run)
        const style = runStyle(run)
        if (segments.length === 1) {
          const segment = segments[0]
          return (
            <span
              key={runIndex}
              className={segment.boxed ? `${styles.box} ${className ?? ''}` : className}
              style={segment.boxed ? { ...style, width: boxWidth(segment.cells) } : style}
              data-c={segment.cell}
              data-w={segment.boxed ? segment.cells : undefined}
            >
              {segment.text}
            </span>
          )
        }
        return (
          <span key={runIndex} className={className} style={style}>
            {segments.map((segment, index) => (
              <span
                key={index}
                className={segment.boxed ? styles.box : undefined}
                style={segment.boxed ? { width: boxWidth(segment.cells) } : undefined}
                data-c={segment.cell}
                data-w={segment.boxed ? segment.cells : undefined}
              >
                {segment.text}
              </span>
            ))}
          </span>
        )
      })}
    </div>
  )
}

/** Rows only re-render when what they show changed. */
export const Row = memo(
  RowView,
  (previous, next) =>
    previous.model.signature === next.model.signature &&
    previous.model.row === next.model.row &&
    previous.model.line === next.model.line &&
    previous.model.c0 === next.model.c0 &&
    previous.model.c1 === next.model.c1,
)
