---
name: alethe-orchestra-source
description: "Where the Alethe Orchestra app source lives vs. the installed build the user runs, and the repo's working rules"
metadata:
  node_type: memory
  type: reference
  originSessionId: 3ecd46cd-6b06-4b13-9a1a-d967db825dc4
  modified: 2026-10-04T21:56:12.488Z
---

- Source repo of the Alethe Orchestra desktop app (Tauri 2 + React): `C:\Users\Profile\Documents\GitHub\alethe-orchestra` (fork of Alethe 1.7.8, branch `master`, lots of uncommitted owner work in the tree).
- The app the user runs is the INSTALLED build `C:\Users\Profile\AppData\Local\Alethe Orchestra\alethe-orchestra.exe` (not `tauri dev`), so source edits only show up after a new installer build. Orchestra sessions (orchestrator + workers) run inside it, so never kill it.
- Orchestra UI code: `src/components/Orchestra/`, store `src/stores/orchestraStore.ts`, Rust bridge `src-tauri/src/orchestra.rs`, agent launcher `src-tauri/src/cli_resolver.rs`.
- Repo rules (CLAUDE.md): no commit/push without explicit owner permission and never a Co-Authored-By line; don't restart the app/dev server; i18n en + pt-BR mandatory; changelog entry under [Unreleased] for every feature; tokens only, no gradients.
- Machine has only Windows PowerShell 5.1 (no pwsh).

Related: [[orch-spawn-prompt-cut]]
