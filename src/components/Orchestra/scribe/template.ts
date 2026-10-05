/**
 * Built-in copy of the owner's diary template (`Diário/_Template - Sessão diária.md`). The
 * author always reads the template live from the vault, so editing it there changes the notes;
 * this copy is only the fallback when the vault cannot be read. It is the owner's own note
 * format, hence in Portuguese.
 */
export const FALLBACK_TEMPLATE = `---
tags: [diario, sessao, claude]
data: AAAA-MM-DD
# opcionais, quando fizer sentido:
# projeto: Go Further
# status: em andamento | concluído | em aberto
# aliases: []
---

# Sessão AAAA-MM-DD — <título curto do dia>

> [!success] Estado / verificação ao vivo (opcional)
> Use um callout no topo quando o dia deixou algo **em produção** ou validado ao
> vivo: PID/serviço rodando, versão publicada, teste confirmado. Callouts úteis:
> \`[!success]\` (ok/validado), \`[!warning]\` (ressalva), \`[!info]\` (contexto),
> \`[!danger]\` (risco). Remova se não se aplicar.

## Resumo do dia
*Um ou dois parágrafos: como foi o dia, as frentes principais e o fio
condutor. Se houve várias frentes, cite-as aqui em uma linha cada.*

## Casos / atividades
*Um bloco por caso resolvido. Repita o \`###\` quantas vezes precisar.*

### <Caso 1 — título>
- **Contexto / pedido:** *quem pediu e o quê (cite a fala do solicitante se relevante).*
- **O que foi feito:** *ações e a decisão tomada.*
- **Validação:** *como foi provado que funcionou (versão, readback, teste ao vivo).*
- **Gotcha:** *a pegadinha do caso — o que quase deu errado ou enganou.*

## Pontos-chave / decisões
- *Decisões duráveis do dia, em uma linha cada — o que passa a ser regra.*

## O que foi aprendido (gotchas)
- *Lições e armadilhas que valem para o futuro: comandos que funcionaram ou
  enganaram, suposições corrigidas, pegadinhas de ferramenta.*

## Conclusões
- *Estado final: o que ficou pronto, validado e no ar; o que ficou de pé.*

## Notas tocadas
- [[Nota relacionada]] — *o que mudou nela.*

## A fazer / pendências
- [ ] *Pendência concreta, com responsável se houver.*

---

# Notas relacionadas
- [[Nota relacionada]] — *comentário curto.*
`
