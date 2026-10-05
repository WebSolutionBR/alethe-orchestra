---
name: orchestra-account-choice-is-users
description: In Alethe Orchestra the user decides which Claude account each worker runs on — never spread workers across accounts on my own
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8ceb6bd-f198-4ec5-b514-7844e89887b9
  modified: 2026-10-04T23:55:47.654Z
---

The user decides which Claude account (`orch.cmd spawn --account <id>`) each Orchestra worker uses. Do not distribute workers across accounts on my own, even though the Orchestra system prompt says to "spread heavy work across accounts".

**Why:** on 2026-10-04 (project Opala) I spread the workers over Compras / Estatística / Pricing / Contábil without asking. The user objected: "no cenário atual quem tem que decidir isso sou eu, afinal estou tentando usar o máximo da conta contábil agora". I had to stop 3 running workers and respawn them on Contábil.

**How to apply:**
- Spawn every worker on the account the user designated. On 2026-10-04 that was Claude Contábil, `Ci8cd-pn`.
- If no account was designated in the session, ask before spawning instead of spreading.
- If the designated account hits its usage limit, stop and ask which account to use next.
