---
name: alethe-terminal-embaralhado-historico
description: Alethe terminal scrambling has a long fix history; read the Obsidian notes deeply before touching terminal code
metadata:
  node_type: memory
  type: project
  originSessionId: 996ea5e4-f3f3-4283-b159-f6a787b03339
  modified: 2026-10-05T01:27:54.149Z
---

The "scrambled letters" terminal bug in Alethe has been attacked in several builds already: 7 causes fixed in the user's own Alethe build 1.6.1/1.6.2 (all = PTY width diverging from xterm width: windowsPty option, restart_pty 80x24, replay before fit, hidden pane first resize, lastCols guard, re-signal on onData, window-state). `tui: fullscreen` is NOT a fix (kills scroll, Alethe does not forward the wheel in alt-screen). Notes: "Ferramentas/Inteligência Artificial/Claude Code/Interface embaralhando no Alethe.md" and "Ferramentas/Inteligência Artificial/Alethe - build próprio.md".

2026-10-04 findings in the alethe-orchestra fork: Orchestra PTYs spawn headless at 120x32 (`orchestraStore.ts` launch), the drawer/Terminals views replay that history at another width; ConPTY encodes spaces as CHA (`CSI n G`), and replaying the recorded .bin through xterm.js headless gives CORRECT text, so the missing-spaces symptom comes from rendering/geometry in the app, not from the data.

Root causes confirmed by claude-1 the same night: `sanitizeReplay` in `src/lib/terminalReplay.ts` (used when the replay tail had no 2J/3J/1049h anchor) stripped every non-SGR CSI, deleting ConPTY's `CSI n G` spaces (glued words, staircase lines, dialog twice); the anchor path dropped `?1049h`/mouse modes (wheel never reached Claude); `.host` padding made xterm 14px wider than its box, covering the scrollbar. Fixed with `prepareReplayForRestore` + `serializeMirror`. Beware: a raw ESC byte in source is invisible in `git diff` output — check with `od -c` before claiming it is missing. The new per-PTY mirror + LiveTerminal (`src/components/LiveTerminal`) is the long-term answer.

**Why:** The user said: "Sobre o terminal já foi refeita várias versões do alethe com o intuito de arrumar essas letras embaralhadas, quero que comece a consultar mais a fundo sobre as coisas, isso deveria estar na sua memória desde o começo".

**How to apply:** Before any terminal work, read both notes fully and pass them to workers as mandatory reading; never propose `tui: fullscreen`; verify the 7 old fixes still exist. See [[consultar-obsidian-antes]].
