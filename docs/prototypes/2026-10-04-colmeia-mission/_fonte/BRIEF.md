# Briefing comum: protótipos da Colmeia e do Mission Control (Alethe Orchestra)

## Pedido do dono (literal)
"Gostei muito da visualização Colmeia e também da Mission Control. Quero alguns protótipos dessas
versões, principalmente da Colmeia, em HTML local, para visualizar e talvez aprovar um visual novo.
Quero vê-la em funcionamento, com cores mais vibrantes, chamando mais atenção, com aqueles designs
de que você sabe que eu gosto."

Cada subagente faz **uma** variante: um arquivo HTML autocontido em
`C:\Users\Profile\Documents\Alethe\Sistemas_e_autromacoes\prototipos\` (nome dado na tarefa).
Não mexa em nenhum outro arquivo (nem em `_fonte/`, nem no repositório do app).

## O que é a Orquestra
App desktop (Tauri + React) em que um **orquestrador** (Claude Code) divide uma meta e despacha
**workers** (`claude-1`… `claude-N`) que trabalham em paralelo. Papéis:
- **orquestrador**: centro de tudo; coordena, responde bloqueios, fecha a sessão.
- **workers**: cada um com área (ex.: `espelho-core`), tarefa, progresso 0–100 e transcrição.
  Um worker pode nascer com `--after claude-N` e fica **aguardando** até a dependência terminar.
- **criativo** (papel `creative`): worker que propõe ideias; identidade **rosa** e ícone de faísca.
- **escriba Obsidian** (papel `scribe`, id `obsidian`): não é worker; grava a sessão numa nota do
  Obsidian. Identidade **roxa do Obsidian** (`#8b6cef` no escuro, `#6c4ee0` no claro), ícone de
  cristal (não use o logo do Obsidian). Mostre quando ele grava (pulso) e a contagem de gravações.
- **message bus**: mensagens entre agentes (delegação, report, pedido de permissão, resposta,
  falha, ideia, gravação do escriba, conversa entre workers, mensagens do usuário "você").

Referências do que existe hoje (só para entender; não copie o visual):
- Colmeia atual: hexágonos em anéis em volta do orquestrador; o nível de "líquido" dentro do
  hexágono é o progresso; bus embaixo; painel de detalhes à direita.
  Código: `C:\Users\Profile\Documents\GitHub\alethe-orchestra\src\components\Orchestra\views\HiveView.tsx`
  e o conceito `C:\Users\Profile\Documents\GitHub\alethe-orchestra\docs\concepts\f-colmeia.html`.
- Mission Control atual: cabeçalho com anel de progresso geral; grade de cards por agente com
  minitranscrição; bus à direita com filtros.
  Código: `...\views\MissionControlView.tsx` e `docs\concepts\b-mission-control.html`.

## Gosto do dono (do Obsidian: "Identidade Visual", "Stack de 3D, Glass e Interatividade",
## "Transições e Animações", "Ideias de Cursor", Opala, Hyprland/macOS, Wellhub)
- **Neon sobre preto profundo**: preto `#121212`, roxo elétrico `#5600FF`, ciano `#00FFFF`,
  rosa `#FF6AFF`, verde neon `#8FFF00`; branco `#FFFFFF`, cinza `#D9D9D9`.
  Texto roxo sobre escuro só em `#A78BFA` (o `#5600FF` não tem contraste para texto).
- **Glassmorphism**: `backdrop-filter: blur(20px) saturate(1.2)`, raio ~14px, borda 1px
  translúcida, highlight interno, sombra suave. Vidro só sobre fundo com cor (manchas/aurora),
  nunca sobre branco liso.
- **Granulado (noise)**: SVG `feTurbulence` inline em `background-image` (data URI), sutil.
- **Formas orgânicas**, manchas desfocadas que derivam devagar, aurora (roxo → rosa → azul).
- **Tipografia forte**: Readex Pro (títulos), Outfit (interface), JetBrains Mono (terminal).
  Google Fonts é o único recurso externo permitido, sempre com fallback real
  (`'Readex Pro', 'Segoe UI', system-ui, sans-serif`; mono: `'JetBrains Mono', 'Cascadia Mono',
  Consolas, monospace`).
- **Movimento premium**: easing `cubic-bezier(0.16, 1, 0.3, 1)`, fade+blur nas entradas,
  stagger 50–80 ms, nada linear, nada > 1,5 s em interação; animar só `transform`/`opacity`.
- **Cursor custom opcional** (glass orb / anel neon com inércia), sempre com fallback e desligado
  em `prefers-reduced-motion` e em touch.
- **macOS/Hyprland**: traffic lights `#FF5F57 #FEBC2E #28C840`, ilhas tipo Waybar, launcher tipo
  Spotlight/fuzzel, vidro fosco, Inter/SF.
- Nada de visual genérico de template. Cada variante precisa ter personalidade própria.

## Motor de simulação (obrigatório, igual em todas)
Arquivo fonte: `C:\Users\Profile\Documents\Alethe\Sistemas_e_autromacoes\prototipos\_fonte\sim-engine.js`.
Copie o conteúdo **inteiro e sem alterar** para um `<script>` da sua página (o arquivo já começa
com `/* <sim-engine>` e termina com `/* </sim-engine> */`; esses marcadores permitem atualizar
todas as variantes depois com `node _fonte/sync-engine.mjs`). Não edite o motor: se achar um bug,
contorne na sua página e conte no relatório.

API (global `AletheSim`):
```js
const sim = AletheSim.create({ speed: 1, seed: 7, loop: true }) // roteiro de ~170 s a 1×; reinicia sozinho
sim.start()                          // relógio por timer (~30 Hz)
sim.on('tick', fn)                   // a cada passo (redesenhe aqui ou em rAF + fallback no tick)
sim.on('spawn' | 'state' | 'line' | 'message' | 'scribe' | 'permission' | 'resolved' | 'reset' | 'pause' | 'speed' | '*', fn)
// eventos: { type, t, agent?, from?, to?, line?, message?, write?, count?, request?, approved? }
sim.pause(); sim.resume(); sim.toggle(); sim.paused; sim.setSpeed(0.5..4); sim.speed; sim.step(seg)
sim.t; sim.goal; sim.project; sim.session
sim.agents      // todos (inclui orquestrador e escriba); sim.workers (workers + criativo)
sim.agent(id)   // { id, role: 'orchestrator'|'worker'|'creative'|'scribe', area, task, state,
                //   progress 0..100, after, hue (1..7 p/ workers), files, touched, permission
                //   ({tool, detail} quando bloqueado), lines [{at, kind:'tool'|'ok'|'error'|'note'|'prompt'|'think', text}],
                //   tokens, startedAt, endedAt }
sim.bus         // [{ id, at, from, to, text, kind: 'task'|'report'|'block'|'answer'|'fail'|'idea'|'scribe'|'chat'|'user' }]
sim.scribe      // { note, writes, last: {at, text}, writing }
sim.timeline    // [{ at, id, state }] mudanças de estado (para linhas do tempo)
sim.overall()   // progresso geral 0..100;  sim.counts() → { thinking: n, … }
sim.approve(id); sim.deny(id)        // resolve o pedido de permissão de um agente bloqueado
sim.send(id, texto)                  // mensagem do usuário ("você") → bus + transcrição; o agente responde
sim.transcript(id)                   // texto da transcrição, para copiar
AletheSim.STATES[estado] → { label (pt-BR), icon, busy, motion: 'spin'|'breathe'|'scan'|'type'|'tick'|'alert'|'none' }
AletheSim.clock(seg) → 'mm:ss';  AletheSim.tokens(n) → '12,3k';  AletheSim.copyText(texto) → Promise
```
Roteiro (seed 7): orquestrador lê o Obsidian → nascem claude-2, claude-1, claude-5, claude-6
(criativo), claude-3 `--after claude-2`, claude-4 `--after claude-3` → claude-2 **bloqueia** pedindo
permissão (aprovação automática em 14 s se ninguém clicar) → claude-1 **falha** em testes → nasce
claude-7 (substituto) → criativo manda 5 ideias → escriba grava ~9 vezes → todos concluem →
orquestrador roda a verificação final → 9 s depois a sessão reinicia (sessão 2, 3…).

Estados (use os rótulos e ícones do motor): iniciando ◌, pensando ✻, lendo ◎, editando ✎,
testando ▶, bloqueado ⏸, aguardando ⧗ (dependência `--after`), concluído ✓, falhou ✕, ocioso ·.

## Requisitos funcionais (todos obrigatórios)
1. **Simulação ao vivo** com o motor: orquestrador, workers nascendo (mostre `--after` e a ligação
   com a dependência), progresso, estados mudando, bloqueio pedindo permissão (destaque forte +
   botões Aprovar/Negar), falha, conclusão, mensagens no bus, escriba gravando, criativo propondo.
2. **Estado inconfundível sem depender de cor**: ícone + rótulo de texto + um padrão/forma/
   movimento próprio por estado (ex.: bloqueado pulsa e tem borda serrilhada; aguardando é tracejado;
   falhou é rachado/riscado; concluído é sólido com ✓). Teste mentalmente em escala de cinza.
3. **Interação**: hover (realce + tooltip ou resumo), clique seleciona um agente e abre o **painel
   do agente** com: estado, tarefa, progresso, arquivos, tokens, tempo e a **transcrição simulada
   que rola sozinha** (gruda no fim; se o usuário rolar para cima, para de grudar e mostra
   "↓ novas linhas") e um botão **Copiar** (use `AletheSim.copyText`, mostre confirmação), mais um
   campo para mandar mensagem (`sim.send`). Bloqueado: Aprovar/Negar no painel e no próprio agente.
4. **Colmeia**: **zoom e pan** (roda do mouse com Ctrl ou sem, arrastar, botões +/−/ajustar,
   duplo clique ajusta). Mission Control: filtros do bus por agente e foco num card.
5. **Teclas**: Espaço pausa/continua; `+`/`-` velocidade; `1`–`9` selecionam agentes (0 =
   orquestrador); setas navegam a seleção; `Esc` fecha o painel; `A` aprova e `N` nega quando o
   selecionado está bloqueado; `C` copia a transcrição do selecionado; `T` alterna claro/escuro;
   `?` mostra a ajuda. Colmeia: `F` ajusta a vista. Não capture teclas enquanto o foco estiver num
   campo de texto.
6. **Velocidade ajustável** (0,5× / 1× / 2× / 4×) e **botão pausar** sempre visíveis.
7. **`prefers-reduced-motion: reduce`**: sem animações decorativas (deriva, partículas, brilho
   pulsando, cursor com inércia); estados continuam legíveis (troque movimento por padrão estático).
8. **Contraste ≥ 4,5:1 em todo texto** (≥ 3:1 só para texto ≥ 24px ou ≥ 19px bold), nos dois
   temas. Neon em texto pequeno sobre claro quase sempre falha: use versões escuras no tema claro.
   Foco visível em todos os controles (`:focus-visible`).
9. **Tema claro e escuro** com tokens CSS (`:root` + `[data-theme="light"]`), padrão definido pela
   sua direção; `T` e um botão alternam. Parâmetros de URL (para a galeria):
   - `?theme=light|dark` força o tema;
   - `?speed=N` define a velocidade inicial;
   - `?embed=1` = modo miniatura: esconde rodapé e painéis laterais, mantém a cena viva, sem
     capturar teclado nem cursor custom.
10. **Rodapé** (visível, recolhível) com duas listas curtas, honestas e específicas da sua variante:
    - **"Dá para levar ao app"**: o que dela cabe no app atual.
    - **"Conflita com a regra atual"**: o que choca com o design system do repositório hoje
      (**sem gradiente, cores só por tokens de `theme.css`**, sem dependências novas, i18n),
      dizendo que **a decisão é do dono**.
11. Autocontido: HTML completo (`<!doctype html>`, `lang="pt-BR"`, `<meta charset>`, viewport,
    `<title>`), CSS e JS inline, sem imagens externas (SVG inline ou data URI), só Google Fonts.
    Texto da interface em pt-BR.
12. Saúde (obrigatório, para a verificação automática), no início do `<body>`:
    ```html
    <pre id="__errors" hidden></pre>
    <script>
      window.addEventListener('error', (e) => { const p = document.getElementById('__errors'); p.textContent += (e.message || e) + '\n'; document.documentElement.dataset.errors = String((+document.documentElement.dataset.errors || 0) + 1) })
      window.addEventListener('unhandledrejection', (e) => { const p = document.getElementById('__errors'); p.textContent += 'promise: ' + (e.reason && e.reason.message || e.reason) + '\n'; document.documentElement.dataset.errors = String((+document.documentElement.dataset.errors || 0) + 1) })
    </script>
    ```
    e, depois de criar o `sim`: `sim.on('tick', () => { document.documentElement.dataset.simT = String(Math.round(sim.t)) })`.
13. Desempenho: até ~8 agentes + bus de 250 mensagens sem travar. Não recrie o DOM inteiro a cada
    tick: atualize o que mudou (ou use canvas/SVG com cuidado). Bus: mostre as últimas ~60.
14. Acessibilidade: elementos clicáveis são `button` ou têm `role`/`tabindex` e `aria-label`;
    o painel do agente é navegável por teclado; uma região `aria-live="polite"` anuncia só
    eventos importantes (bloqueio, falha, conclusão).

## Verificação (faça antes de devolver)
Na pasta `C:\Users\Profile\Documents\Alethe\Sistemas_e_autromacoes\prototipos`:
```
node _fonte/check.mjs <seu-arquivo>.html --shot <scratch>/a.png                 # escuro, 1440x900
node _fonte/check.mjs <seu-arquivo>.html --query "theme=light" --shot <scratch>/b.png
node _fonte/check.mjs <seu-arquivo>.html --query "embed=1&speed=4" --size 720x450 --shot <scratch>/c.png
node _fonte/check.mjs <seu-arquivo>.html --budget 40000 --query "speed=4" --shot <scratch>/d.png  # sessão adiantada (bloqueio, falha)
```
(`<scratch>` = uma pasta temporária sua; não grave prints dentro de `prototipos`.) Precisa sair
com `errors=0` e `sim-t` > 1. **Olhe os prints** (ferramenta Read na imagem) e corrija o que estiver
feio, cortado, ilegível ou genérico. Confira o contraste dos textos com cálculo (luminância
relativa WCAG) para os pares de cor que você usou nos dois temas.

## O que devolver (texto, em pt-BR)
1. Caminho completo do arquivo (formato do Explorer).
2. Um parágrafo descrevendo a variante (direção, como mostra cada estado sem cor, interações).
3. As duas listas do rodapé.
4. Resultado das verificações (as linhas `sim-t=… errors=…`) e o que corrigiu ao olhar os prints.
5. Qualquer limitação conhecida.
