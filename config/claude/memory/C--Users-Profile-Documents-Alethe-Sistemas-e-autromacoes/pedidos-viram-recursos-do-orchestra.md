---
name: pedidos-viram-recursos-do-orchestra
description: Workflow rules the user gives the orchestrator must also be built as native features of the Alethe Orchestra app
metadata:
  node_type: memory
  type: feedback
  originSessionId: 996ea5e4-f3f3-4283-b159-f6a787b03339
  modified: 2026-10-05T00:16:05.767Z
---

When the user states a workflow need or rule during an Orchestra session (e.g. "consult Obsidian before starting", terminal scroll, a real-time transcript terminal with copy/paste), they want it implemented as a feature of the Alethe Orchestra app itself (repo `C:\Users\Profile\Documents\GitHub\alethe-orchestra`), not only followed by me in this session.

**Why:** The user said (2026-10-04): "Isso tudo que eu estou passando devem ser recursos do alethe orchestra, inclusive o de consulta no obsidian" — the goal of the "Sistemas e automações" project is improving Alethe Orchestra, so every behavior they ask for should become product behavior (e.g. injected into orchestrator/worker prompts or done by the app automatically).

**How to apply:** For each rule/request, (1) follow it now, and (2) plan a task that builds it into the app (prompt rule in `withObsidianRule`, scribe/obsidian backend, UI). Related: [[consultar-obsidian-antes]].
