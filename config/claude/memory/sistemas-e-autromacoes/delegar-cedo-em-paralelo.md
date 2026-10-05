---
name: delegar-cedo-em-paralelo
description: "As orchestrator, spawn workers in parallel early instead of investigating alone for long"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 996ea5e4-f3f3-4283-b159-f6a787b03339
  modified: 2026-10-05T00:21:19.263Z
---

As the Alethe Orchestra orchestrator, start distributing workers in parallel as soon as the work areas are clear; do the deep investigation inside workers (with precise task files) rather than spending a long time diagnosing alone.

**Why:** The user said (2026-10-04): "além disso já comece a distribuir os agentes em paralelo" after I spent a long time reading code and reproducing the bug myself.

**How to apply:** Do a short context pass (Obsidian + key files), write task files with disjoint file ownership, spawn 3–6 workers at once, then review. Workers stay on the default account (Claude Contábil) unless the user says otherwise — account choice is the user's. Related: [[consultar-obsidian-antes]], [[pedidos-viram-recursos-do-orchestra]].
