---
name: reference_obsidian_rest_api_conta_alethe
description: Nesta conta do Alethe (Ci8cd-pn) o MCP do Obsidian não está registrado; gravar no vault pela API REST local (porta 27124) com a chave do ~/.claude.json
metadata:
  type: reference
---

A conta do Alethe desta sessão (`Ci8cd-pn`, <e-mail>) tem `mcpServers` vazio no seu `.claude.json`, então as ferramentas `mcp__obsidian__*` não existem aqui (ToolSearch "+obsidian" não acha nada). O servidor `obsidian` só está registrado no `C:\Users\Profile\.claude.json` da conta padrão.

**Como aplicar:** com o Obsidian aberto, usar a API REST do plugin direto com curl: `https://127.0.0.1:27124/vault/<caminho url-encoded>` (PUT cria/sobrescreve com `Content-Type: text/markdown`, GET lê, `-k` por causa do certificado autoassinado), header `Authorization: Bearer <OBSIDIAN_API_KEY>` lido de `mcpServers.obsidian.env.OBSIDIAN_API_KEY` no `~/.claude.json`. Confirmado em 04/10/2026 (PUT devolve 204 e o arquivo aparece em `G:\Meu Drive\Anotações\TODO`). É o mesmo canal que o MCP usa, então respeita a regra "sempre via API, não via filesystem" de [[feedback_obsidian_padrao_notas]]. Solução definitiva: registrar o servidor `obsidian` no `.claude.json` desta conta e reiniciar. Ver também [[reference_obsidian_vault]].
