---
name: orchestra-obsidian-note-rule
description: "Alethe Orchestra workers must log their changes in PT-BR in the day's Obsidian note before reporting done"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e6b96018-e396-4587-b67f-ff5ac8570850
  modified: 2026-10-04T22:17:51.211Z
---

Before reporting done as an Alethe Orchestra worker, record every change, deploy and decision in Brazilian Portuguese in the Obsidian note `Alethe Orchestra/<YYYY-MM-DD> Orchestra.md` (vault `G:\Meu Drive\Anotações\TODO`), under a heading with the worker id and area (e.g. `## claude-3 · store-sessions ✅`): what changed, which files, why, and how it was verified. Use the obsidian MCP tool `obsidian_append_content` (fallback: Obsidian Local REST API at https://127.0.0.1:27124). If Obsidian times out, retry later instead of skipping.

**Why:** it is the user's mandatory rule. On 2026-10-04 a PowerShell 5.1 quoting bug cut it out of the worker prompts, and the orchestrator had to resend it.
**How to apply:** in any orchestra worker session (cwd `C:\Users\Profile\Documents\Alethe\IA`), write the note even if the spawn prompt does not mention it, and match the existing sections' format.
