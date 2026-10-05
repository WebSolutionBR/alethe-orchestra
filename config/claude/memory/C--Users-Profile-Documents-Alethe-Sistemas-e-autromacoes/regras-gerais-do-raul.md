---
name: regras-gerais-do-raul
description: "The user's standing rules (from the vault) — report table, Explorer paths, local HTML deliverables, every prompt becomes a note"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 996ea5e4-f3f3-4283-b159-f6a787b03339
  modified: 2026-10-05T01:30:56.279Z
---

Standing rules recorded in the vault notes "Claude + Obsidian - Preferências e regras de uso" and "Entregaveis sempre em HTML local" (the user's other profile has them in memory; this account did not):
1. End every work response with a **report table**: path/link, what changed, next steps, owner.
2. Paths always in full **Explorer format** (`C:\Users\...`), never `/c/...` or relative.
3. Visual deliverables are **self-contained local HTML** in a permanent folder under `Documents\` (inline CSS/JS, Google Fonts ok, light/dark tokens, decent `@media print`) — **never publish an Artifact** and never cloud docs. Return the file path.
4. **Everything becomes a note**: each prompt gets an entry in the day's diary note (`Diário/…Sessão AAAA-MM-DD — …md`) as `## Prompt — <tema>` with **Pedido** and **Feito**, written when each answer closes; each subject gets/updates its topic note in the right folder, linked both ways; pt-BR, dates DD/MM/AAAA, wikilinks only to existing notes, closing `---` + `# Notas relacionadas` (H1) with 3–5 real links and a short comment after `—`; preserve that section when editing; no secrets.
5. No cloud/remote execution (no `isolation: "remote"`).

**Why:** These are the user's explicit permanent rules; I violated 1–4 early in the 2026-10-04 session before reading them.

**How to apply:** Apply to every response and every worker task; put them in the shared task rules. Related: [[padrao-de-notas-obsidian]], [[consultar-obsidian-antes]].
