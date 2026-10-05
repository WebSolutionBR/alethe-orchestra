---
name: padrao-de-notas-obsidian
description: "How the user wants Obsidian notes written (template, structure, linking) — knowledge notes, not logs"
metadata:
  node_type: memory
  type: user
  originSessionId: 996ea5e4-f3f3-4283-b159-f6a787b03339
  modified: 2026-10-05T00:36:52.595Z
---

The user's notes are knowledge notes, not logs: each has purpose, beginning/middle/end, decisions with the why, learnings (gotchas), related links, future goals and next steps — useful to both the user and AIs that later search the vault and trace lines of reasoning.

Template: `Diário/_Template - Sessão diária.md` (frontmatter `tags: [diario, sessao, claude, ...]`, `data`, optional `projeto`/`status`; sections Resumo do dia · Casos/atividades (Contexto/pedido, O que foi feito, Validação, Gotcha) · Pontos-chave/decisões · O que foi aprendido (gotchas) · Conclusões · Notas tocadas · A fazer/pendências). Diary notes live in `Diário/AAAA/MM - Mês/Sessão AAAA-MM-DD — <título>.md`. Topic notes (e.g. `Ferramentas/Inteligência Artificial/Alethe - travamento em sessão RDP (clipboard).md`) use frontmatter tags/status, "Problema x solução" tables, timeline, evidence, plano de ação and "Notas relacionadas"; hubs like [[Alethe]] get backlinks under "Relacionados". Callouts ([!info], [!warning], [!success], [!danger]) for state. Model for big notes: [[Automação de Liberação de E-mails — Documentação Completa]].

**How to apply:** Whenever writing to the vault (my own notes or any scribe feature), follow this structure, link only notes that exist, update hubs' "Relacionados", never dump raw event logs. Related: [[consultar-obsidian-antes]].
