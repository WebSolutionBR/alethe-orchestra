---
name: orch-spawn-prompt-cut
description: "In the installed Alethe Orchestra build, `orch spawn` task text never reaches the worker; resend it with `orch send` after the worker reports blocked"
metadata:
  node_type: memory
  type: project
  originSessionId: 3ecd46cd-6b06-4b13-9a1a-d967db825dc4
  modified: 2026-10-04T23:32:22.418Z
---

As of 2026-10-04 the installed build launches agents through Windows PowerShell 5.1, whose legacy native-argument passing splits arguments containing double quotes. The orchestra system prompts contain quotes, so the orchestrator starts with only "spawn" as its first message and every worker with only "report"; the spawn task text is lost.

**Why:** `cli_resolver.rs::command_builder_for_terminal` wraps args in PowerShell single quotes but 5.1 does not escape embedded `"` when calling claude.exe. A fix was delegated on 2026-10-04 (worker `pty-quoting`, cli_resolver.rs).

**Status:** the fix is in the NSIS installer built 2026-10-04 20:29 (`src-tauri/target/release/bundle/nsis/Alethe Orchestra_1.7.8_x64-setup.exe` in the repo, same version 1.7.8); it only takes effect after the user installs it. If a fresh worker still receives only "report", the old build is still installed.

**How to apply:** until a build with that fix is installed, after `orch spawn` wait for the worker's "blocked / no task" turn-finished message, then deliver the full task with `orch send claude-N <task>` (sending before its PTY exists drops the message). Once the fix ships, delete this memory.

Related: [[alethe-orchestra-source]]
