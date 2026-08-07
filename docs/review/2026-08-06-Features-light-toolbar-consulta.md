# Code Review — /consulta: toolbar do grid na barra de filtros (2026-08-06, 2ª passada)

## Resumo
Alvo: `/consulta` — **não há documento de plano dedicado**; a régua e a referência de estado
são as seções do `CLAUDE.md` que descrevem a rota ("BARRA DE FILTROS de `/consulta` — GRADE
ÚNICA de 8 colunas", "FILTROS DEDICADOS…", "DOIS seletores de data…", "BUSCA AUTOMÁTICA…" e a
linha de `/consulta` na tabela de rotas). O argumento **não** é `--escopo`, então o diff segue
completo.
Modo: light (sem passo de ataque, sem verificação adversarial)
Delta: 10 arquivos alterados, 0 novos, +1585/−184 linhas (os 2 untracked em `docs/review/` são
relatórios, excluídos do conjunto pelo rito)
Régua: `CLAUDE.md` do projeto (Regras mandatórias 1/2/5/6 + as seções de `/consulta`) +
`CLAUDE.md` do workspace
Gates: vitest frontend-vite **816/816** (142 arquivos, `--maxWorkers=1`) · api-backend 523/523 ·
portal-next 2/2 · pytest **1100/1100** · lint **0/0** nos 4 workspaces · typecheck **OK** nos 4 ·
ts-prune **0** · **e2e Playwright não executado — exige navegador (o renderer crasha no sandbox
do agente)**

Segunda passada sobre o mesmo working tree. A primeira (`2026-08-06-Features-light.md`) cobriu o
filtro de planos em uso, o portal do react-select e a busca em memória, e suas duas correções
seguem no lugar e travadas por teste (reconferidas aqui). **O que esta passada revisa de novo é a
mudança seguinte**: mover os controles da toolbar do grid (densidade · colunas · restaurar) para a
1ª coluna da 2ª linha da barra de filtros, por portal.

O achado central é que essa mudança **reintroduziu, no botão "Colunas", exatamente o defeito que a
mudança anterior tinha acabado de corrigir no filtro de plano de contas**: o popover é `absolute`
e passou a viver dentro do `overflow-x-auto`, que corta na vertical. Confirmado por sonda
executada. Nenhum gate pega isso — jsdom não faz layout, e foi por isso que o guarda do
react-select precisou ser estrutural.

## Achados

### 🔴 Bloqueantes

- [apps/frontend-vite/src/components/molecules/ColumnVisibilityMenu.tsx:99] O painel "Gerenciar
  colunas" é `position: absolute` e, com a toolbar movida para a grade de filtros, passou a ter
  como ancestral o `overflow-x-auto` que corta na vertical — o mesmo mecanismo que deixava o menu
  do `ChartAccountSelect` invisível.
  Falha:     em `/consulta`, clicar em "Colunas" abre o painel (288px de largura, até ~350px de
             altura) ancorado num botão que está na **2ª e última linha** da grade. O contêiner
             tem a altura das duas linhas (~84px) e `overflow-x: auto`, o que faz o `overflow-y`
             computar para `auto` também: o painel nasce cortado logo abaixo do botão. Como
             elemento absoluto não expande o contêiner, o que sobra é uma tira de poucos pixels
             (ou nada) — **a gestão de colunas fica inutilizável na tela**, que é justamente a
             função que o usuário pediu para trazer à barra. Mostrar/ocultar e fixar coluna são o
             caminho para caber o grid em telas menores, então a perda não é cosmética.
  Evidência: sonda executada sobre `Consulta.test.tsx` (cópia temporária, removida em seguida) —
             abrir o menu e verificar `painel.closest('.overflow-x-auto')`: retornou o contêiner,
             não `null` (o guarda equivalente do react-select, `o menu do filtro de plano abre
             FORA do contêiner que corta`, exige exatamente `null`). Código: `absolute right-0
             z-40 mt-1 w-72` em `ColumnVisibilityMenu.tsx:99`, dentro do `div.relative` da linha
             80; o slot da toolbar está em `Consulta.tsx:1258`, filho da grade que vive no
             `overflow-x-auto` de `Consulta.tsx:1113`.
  Correção:  mesmo tratamento do react-select — renderizar o painel por `createPortal` no
             `document.body` com posição `fixed` derivada do rect do botão. ⚠️ O clique-fora
             precisa passar a considerar **dois** nós (wrapper e painel): hoje ele fecha quando o
             alvo não está dentro de `ref.current`, e com o painel no body **um clique dentro do
             próprio painel fecharia o menu**.
  Regra:     `CLAUDE.md` § 🔴 "O menu do `ChartAccountSelect` (variante filtro) sai por PORTAL" —
             "`overflow-x: auto` com `overflow-y: visible` faz o Y computar para `auto` também… o
             react-select renderiza o menu inline, logo abaixo do controle, então ele nascia
             CLIPADO". A regra descreve o mecanismo, não o componente.

### 🟡 Recomendados

- [apps/frontend-vite/src/components/molecules/GridToolbar.tsx:150] No modo portal a faixa acima
  do grid deixou de reservar altura, então marcar a primeira linha **empurra o grid para baixo**.
  Falha:     antes, o wrapper `py-2` existia sempre (com os controles dentro) e a barra de seleção
             aparecia **dentro** da faixa já reservada — o deslocamento era da diferença de altura
             entre os dois blocos, ~6px. Agora, sem seleção nada é renderizado; ao marcar a
             primeira conta, surge um bloco de ~62px (barra `py-1.5` com um `.btn` dentro, mais o
             `py-2` do wrapper) e todo o grid desce. Quem seleciona várias contas em sequência
             para baixa em lote — a tarefa que a barra existe para servir — clica, o conteúdo se
             desloca sob o ponteiro e o clique seguinte pode cair na linha errada.
  Evidência: `GridToolbar.tsx:150-155` — no ramo do portal o wrapper só é emitido quando
             `selection` existe; no ramo inline (`:141`) ele é incondicional. A altura vem de
             `px-3 py-1.5` + `.btn` (`py-1.5 text-sm`) na barra, mais `py-2` do wrapper.
  Correção:  é um trade-off de produto, não um defeito de implementação: reservar a altura devolve
             ~40px de espaço morto permanente — metade do ganho vertical que motivou a mudança —
             enquanto não reservar mantém o deslocamento. Decisão sua; por isso vai para os
             adiados, não para a correção automática.
  Regra:     nenhuma regra escrita do projeto cobre layout shift; o critério aqui é a robustez de
             interação da grade do Passo 4.

### 🔵 Opcionais

- [apps/frontend-vite/src/pages/Consulta.tsx:1114] O novo mínimo da coluna 1 (25rem) veio de
  **estimativa** da soma dos botões (~24,5rem), não de medição em tela — e o `CLAUDE.md` do
  projeto registra o precedente oposto: "a estimativa de 9rem ≈ o texto a `text-sm` ficou curta na
  medida real do navegador; não repetir sem conferir em tela". O dano máximo é contido pelo
  `flex-wrap` que acompanha o bloco (quebra em duas linhas em vez de invadir a coluna 2), mas o
  número entrou no doc afirmado como fato.
- [apps/frontend-vite/src/components/molecules/GridToolbar.tsx:87] O bloco de controles ganhou
  `flex-wrap`, o que também vale para as outras cinco telas com grid (`/emails`, `/cobranca/erros`,
  `/fornecedores`, centros de custo, `CrudTablePage`): em tela estreita os botões passam a quebrar
  entre si em vez de o bloco inteiro descer. Diferença cosmética, sem efeito funcional.
- [apps/frontend-vite/src/components/organisms/DataGrid.tsx:121] Se um consumidor futuro passar
  `toolbarControlsTarget` e o nó de destino **nunca** montar (render condicional), os controles
  somem sem erro nenhum — o `null` que evita o flash no primeiro quadro é indistinguível de um
  destino que não existe. Hoje inalcançável: o slot de `/consulta` é incondicional.

## Pendências (trabalho incompleto)
Nenhuma. A varredura de marcadores (`TODO|FIXME|HACK|XXX|WIP`, `@todo`, `todo:`) sobre o diff e os
untracked não retornou ocorrências, e não há stub, `it.skip`, `console.log` nem bloco de debug no
delta.

## Drift código × documentação
- **Herdado da 1ª passada, ainda sem decisão sua:** `CLAUDE.md` § "BARRA DE FILTROS…" tem um bullet
  que cita `w-max` onde o código usa `w-full min-w-max`. Continua pendente.
- **Novo:** o mesmo bloco afirma que os botões "somam **~24,5rem**" e que a coluna 1 subiu por
  causa disso. O número é estimativa minha, não medição — no resto daquela seção os números
  (1672px, 42%) são deriváveis do template, mas este não é. Ou se mede em tela, ou se marca como
  estimativa no doc; qual dos dois é decisão sua.

## Não coberto
- **Verificação em navegador** — nenhuma das duas mudanças visuais desta rodada foi vista sob
  render real: (a) o clipe do painel de colunas é *inferido* da estrutura (a sonda prova o
  ancestral, não o corte pintado); (b) a largura de 25rem não foi medida. `npm run test:e2e` na
  sua máquina cobriria o axe das páginas protegidas, mas **não** abre o menu de colunas — nenhum
  spec o exercita.
- **O painel de colunas aberto não entra em nenhum teste de a11y**: `Consulta.a11y.test.tsx`
  escaneia a página em repouso e com o modal de detalhe, nunca com esse `role="dialog"` montado.
  Um `aria` quebrado ali passaria despercebido.
- **Reconferência da 1ª passada, não reanálise**: os arquivos de `ChartAccountSelect`,
  `services/supabase.ts` e o restante de `Consulta.tsx` foram analisados no relatório anterior de
  hoje; aqui verifiquei apenas que as duas correções continuam no lugar e travadas por teste
  (`applyPeriod` derivando de `f`; `stableOrder` no `order` da consulta paginada).
- **Leitura parcial de `Consulta.tsx`** (~1.450 linhas): li o diff inteiro e os blocos da barra de
  filtros, dos handlers e da montagem do grid; grid, detalhe, modais e exportação não foram
  relidos — estão fora do delta desta rodada.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Painel "Gerenciar colunas" clipado pelo `overflow-x-auto` | ✅ corrigido | `ColumnVisibilityMenu.tsx` — `createPortal` no body + `position: fixed` medido do botão. Guarda estrutural em `Consulta.test.tsx` (`o painel de Colunas abre FORA do contêiner que corta`), validada por mutante (voltar a `{open && painel}` deixa vermelho) |
| R1 | Layout shift ao selecionar a 1ª linha (faixa deixou de reservar altura) | ⏸️ adiado | Trade-off de produto, não defeito de implementação: reservar a altura devolve ~40px de espaço morto permanente — metade do ganho vertical que motivou a mudança. A decisão é sua |

**Achados novos, encontrados no re-review da própria correção** (item 6 do Passo 8) — os dois em
código que a correção acabara de introduzir, ambos corrigidos numa 2ª rodada:

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B2 | O `scroll` com `capture` fechava o menu ao rolar a **própria lista** de colunas (`max-h-72 overflow-y-auto`) — com ~14 colunas em `/consulta`, rolar até a coluna procurada é o uso normal | ✅ corrigido | `onReflow` ignora evento originado dentro do painel. Par de guardas (`NÃO fecha ao rolar a lista` + `fecha ao rolar fora`), validado por mutante |
| B3 | A posição era medida no wrapper `div.relative` (block-level: fora de um flex, esticaria e o alinhamento pela direita sairia na borda do contêiner, não do botão) | ✅ corrigido | Passou a medir `e.currentTarget` — o botão. Removeu junto o `useCallback` e o acoplamento ao layout do consumidor |

Gates após a correção: vitest frontend-vite **821 (+5)** · api-backend 523 · portal-next 2 ·
pytest 1100 · lint 0/0 · typecheck OK · ts-prune 0
Baseline (Passo 3):   vitest frontend-vite 816 · api-backend 523 · portal-next 2 ·
pytest 1100 · lint 0/0 · typecheck OK · ts-prune 0

Re-review do diff da correção: **2 achados novos na 1ª rodada** (B2 e B3 acima), corrigidos e
re-verificados; a 2ª rodada não encontrou defeito novo. Três mutantes aplicados **em série** e
revertidos com confirmação por `diff -q`.

### ⚠️ Defeito no meu próprio processo, registrado por honestidade

A sonda descartável desta passada (`Consulta.tmpprobe2.test.tsx`, cópia de `Consulta.test.tsx`
usada para provar o clipe) **não foi removida quando eu disse que tinha sido**: o `rm -f` usou
caminho relativo errado (o `cd` do comando já era `src/pages`, e o caminho repetia o prefixo) e o
`-f` engoliu o erro, de modo que o `ls || echo "SONDA REMOVIDA"` imprimiu a confirmação — falsa.
O arquivo ficou no repositório e entrou na suíte: a medição intermediária de **864 testes em 143
arquivos** estava contaminada por ~45 casos duplicados. Detectado ao estranhar o número (eu havia
acrescentado 3 testes, não 48), removido de verdade com confirmação positiva (`ls && echo "AINDA
EXISTE" || echo "REMOVIDA DE FATO"`) e a suíte re-medida. **Nenhum arquivo de sonda ou `.bak`
permanece no working tree** — confirmado por `git status`. É a mesma classe de armadilha que o
rito documenta para reversão de mutante: *confirmação de remoção precisa ser positiva, e `-f`
mais caminho relativo é a combinação que produz o falso verde.*

Não corrigido por decisão sua:
- **R1** (layout shift ao selecionar) — trade-off de produto, descrito acima.
- **Drift do `w-max`** no `CLAUDE.md`, herdado da 1ª passada.
- **A estimativa de 25rem** — marquei no `CLAUDE.md` como "estimativa, não medida em tela";
  confirmar no navegador é o passo que falta.
- **Os 3 achados 🔵 opcionais.**

Nada foi commitado.

---

## Adendo — R1 resolvido a pedido do usuário (2026-08-06)

O achado 🟡 R1, registrado acima como `⏸️ adiado` por ser trade-off de produto, foi resolvido
depois que o usuário pediu explicitamente.

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Marcar a 1ª linha empurrava o grid ~62px para baixo | ✅ corrigido | `GridToolbar.tsx` — a faixa da barra de seleção passa a ser SEMPRE emitida, com `min-h-12` (≈48px, a altura que a barra ocupa) e sem `py-*`. Guarda em `GridToolbar.test.tsx` (`reserva a altura da faixa de seleção mesmo sem seleção`), validada por mutante: voltar ao `{selection && …}` deixa vermelho |

**Alternativa considerada e descartada:** barra flutuante (`position: fixed`) no rodapé, padrão
de Gmail/Drive, que resolveria o salto **sem** devolver os 48px. Descartada por colisão: o rodapé
de `/consulta` ("N de M registros · Carregar mais") fica logo abaixo do card, em fluxo normal —
uma barra presa ao rodapé da viewport passaria por cima dele com frequência, e o canto inferior
direito já é ocupado pelo botão do assistente de IA (o `pr-20` daquele rodapé existe por isso).
Seria trocar um defeito por outro.

**Custo assumido, explicitado:** o espaço vertical que mover os botões havia liberado volta a ser
ocupado por uma faixa vazia de ~48px. O pedido original era de **organização** ("encaixar esses
botões na 1ª coluna da 2ª linha"), não de ganho de altura, então a reserva não contraria a
intenção — mas é uma reversão parcial do efeito colateral positivo, e por isso está registrada
aqui e no `CLAUDE.md`.

Gates após esta correção: vitest frontend-vite **825 (+4 sobre 821)** · lint 0/0 · typecheck OK ·
ts-prune 0. Working tree sem temporários (`git status` conferido).

Re-review do diff desta correção: sem achado novo — a mudança é uma classe (`min-h-12`), a
remoção de um condicional e quatro casos de teste; não introduz caminho de erro, não altera
assinatura e não duplica regra existente.

Nada foi commitado.
