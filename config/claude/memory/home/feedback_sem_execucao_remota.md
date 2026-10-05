---
name: feedback-sem-execucao-remota
description: Ambiente remoto (nuvem) desabilitado neste perfil — nada de execução/sessão na nuvem; trabalho sempre local. Remote Control fica mantido.
metadata:
  node_type: memory
  type: feedback
  modified: 2026-09-27
---

Não usar ambiente de execução remoto (nuvem) em nenhuma sessão deste perfil (`Profile`). Na prática: não iniciar nem fixar sessão de nuvem (`/remote-env`), não passar `isolation: "remote"` ao lançar agentes, não rodar o trabalho num sandbox de nuvem. Tudo roda localmente. Confirmado pelo usuário em **27/09/2026**.

**Why:** Mesma governança de dados de [[feedback-artefatos-sempre-local]] — conteúdo interno da Go Further e dos clientes da Web Solution não sai da infraestrutura da empresa nem roda na nuvem. É a mesma razão que já tinha desligado o Remote Control no perfil `ti001` (04/09/2026).

**How to apply:**
- `settings.json` não fixa `remote.defaultEnvironmentId` (não há bloco `remote`); manter assim.
- Nunca usar `isolation: "remote"` no Agent; usar execução local (ou `worktree` quando precisar isolar).
- **Não desligar o Remote Control** (`disableRemoteControl`) — o usuário escolheu manter em 27/09; ele desabilitou só o *ambiente* remoto, não o controle remoto.
- Não há chave de settings que "proíba" execução na nuvem sem também matar o Remote Control; a regra é comportamental e mora aqui e no vault ([[feedback-artefatos-sempre-local]]).
- Se algum dia a execução remota for mesmo necessária, perguntar antes.

Documentada no vault em `Ferramentas/Inteligência Artificial/IA de texto/Claude/Claude + Obsidian - Preferências e regras de uso.md` conforme [[feedback-obsidian-padrao-notas]].
