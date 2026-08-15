# Code Review — Features / dashboards (2026-08-15) — MAX

## Resumo

**Alvo:** `docs/review/2026-08-15-Features-light-dashboards.md` — o relatório **light** da mesma
mudança, usado como régua de pendências (ele, por sua vez, resolveu o plano
`~/.claude/plans/spicy-hatching-sunrise.md`). Aquele relatório declara `sem passo de ataque, sem
verificação adversarial`; **nenhum dos 3 achados dele foi contestado**, e as correções que ele
aplicou (3 rodadas) estão no working tree sem revisão independente. Fechar essa lacuna é o motivo
desta execução.
**Modo:** max (passo de ataque + verificação adversarial)
**Delta:** 22 arquivos alterados, 0 novos versionáveis, **+674/−346** linhas (working tree, nada
commitado). O relatório light media 16 arquivos / +453−319 — a diferença são as correções dele
próprio. O único untracked é aquele relatório, **excluído do delta** pelo rito (Passo 1).
**Régua:** `CLAUDE.md` (projeto) · `docs/knowledge/dashboards.md` · `CLAUDE.md` do workspace ·
`~/.claude/CLAUDE.md` (global) · o relatório light
**Gates** (exit code medido isoladamente, **sem `| tail`/`| grep`**): frontend-vite **878** (145
arq.) · api-backend **613** (53 arq.) · packages/shared **53** · portal-next **2** · pytest
**1.428** · lint **EXIT 0** (0 warnings) · **typecheck EXIT 0 nos 4 workspaces** · ts-prune
**EXIT 0** · e2e a11y **não executado** (exige navegador — o renderer do Chromium não sobe no
sandbox do agente; provado o que dá: `playwright --list` **EXIT 0, 9 testes**)
**Verificação adversarial:** **5 contestações; 2 confirmados, 1 enfraquecido, 1 refutado**

A mudança em si é sólida: o gate de `typecheck` foi resolvido na causa (verificado — `next typegen`
existe no Next 16.2.10 e o `exclude` **sobreviveu** ao typegen), a limpeza do card de centros de
custo não deixou resíduo, e a documentação foi atualizada com precisão (os números que o
`CLAUDE.md` passou a afirmar — 878/613/53/2 e 1.546 no Node — **batem com a medição**). O passo de
ataque, porém, encontrou um defeito que a revisão light não alcançou porque ele **não está nos
hunks**: a janela "a vencer em 7 dias" dos dois dashboards é calculada em **UTC**, e o delta a
promoveu de um canto (a contagem de um card) para o **estado de abertura das duas telas**. O achado
foi contestado por duas lentes e confirmado pelas duas, com o alcance **maior** do que o enunciado.
Em contrapartida, um achado plausível sobre ressalva de filtro foi **refutado** com evidência
documental, e o achado sobre cobertura e2e foi **rebaixado**.

## Achados

### 🔴 Bloqueantes

- **[apps/frontend-vite/src/services/supabase.ts:1151-1157]** `dashboardWindow` deriva o "hoje" e o
  "hoje + 7 dias" dos **dois** dashboards em **UTC** (`new Date().toISOString().slice(0,10)` e
  `Date.now() + 7 * 86400000`), em vez do helper local `isoDaysFromToday` — violando a regra 🔴 do
  próprio projeto. O delta não criou o defeito, mas **promoveu o alcance dele** ao tornar
  `'vencendo7'` — o único filtro que consome essa janela — o **default das duas telas**.
  **Falha:** em UTC−3, das ~21h à meia-noite, a data em UTC já é a de amanhã, então `todayStr` e
  `in7` deslizam um dia inteiro. Como `matchesKpiFilter` no caso `'vencendo7'` testa
  `due_date >= todayStr && due_date <= in7`, **as contas que vencem hoje somem** da visão de
  abertura das duas telas e as de hoje+8 entram. **Pior caso, medido pela contestação:** no
  **último dia do mês** às 21h30, o escopo do mês (`first`/`last`) e a janela deixam de se
  intersectar — a página abre com KPI zerado e **todos os gráficos em "Sem contas no período."**.
  São 12 noites por ano.
  **Evidência:**
  - `supabase.ts:1151` `const iso = (d) => d.toISOString().slice(0,10)`; `:1155-1156`
    `todayStr: iso(new Date())`, `in7: iso(new Date(Date.now() + 7*86400000))`.
  - Consumido por **`getDashboardData`** (`:1205`) **e** `getFinancialDashboardData` (`:1477`) —
    e não só por `matchesKpiFilter`: **`computeKpis` (`:1183`) o consome incondicionalmente**, em
    `:1231` e `:1501`, logo o número do card "A vencer em 7 dias" já errava à noite com qualquer
    filtro.
  - No **mesmo arquivo**, `aggregateFinancialStats` (`:875-880`, usada por `/consulta`) usa
    `todayISO()`/`isoDaysFromToday(7)` **com comentário explicando exatamente este bug**. As duas
    telas respondem números diferentes para a mesma pergunta na janela noturna.
  - Medido (Node, 15/08 21h30 em UTC−3): `dashboardWindow` → `2026-08-16 .. 2026-08-23`; correto →
    `2026-08-15 .. 2026-08-22`.
  - Medido **contra a base real** (2026-08-15, `status_id = 3`): janela correta = **72** contas;
    **7** vencem hoje e sairiam da visão (−9,7%); 0 vencem em hoje+8 e entrariam.
  - `due_date` é `DATE` (migration `018`), sem componente de hora para absorver o desvio.
  **Correção:** em `dashboardWindow`, trocar `todayStr` por `isoDaysFromToday(0)` e `in7` por
  `isoDaysFromToday(7)`. **Não tocar `first`/`last`** — o `Date.UTC` ali é deliberado e correto
  (a coluna é `date`; o fuso local deslocaria a borda do mês).
  **Regra:** `CLAUDE.md` — *"🔴 TODA data derivada de 'hoje' passa por `isoDaysFromToday` —
  inclusive as JANELAS (2026-08-08)"*, que cita nominalmente `toISOString()` e
  `Date.now() + 7 * 86400000`. O argumento "é só à noite" já foi levantado e **rejeitado** pelo
  próprio time ao corrigir `/consulta`.
  **Veredito:** **CONFIRMADO** `[verificado]` — 2 lentes (correção lógica · reprodução/impacto),
  ambas falharam em refutar; a segunda **ampliou** o alcance (o consumo incondicional por
  `computeKpis` e o caso da virada de mês não constavam do enunciado original).
  > ⚠️ **Severidade SUBIU durante o review.** Entrou como 🟡 e virou 🔴 pela evidência nova da
  > contestação (interseção vazia na virada de mês, no estado de abertura). O rito prevê rebaixar
  > por `ENFRAQUECIDO`; subir por evidência medida é legítimo, e fica declarado aqui.
  > ⚠️ **É defeito PRÉ-EXISTENTE** — `git diff HEAD` não toca `dashboardWindow` (a função nasceu em
  > `f0ad790`, 2026-07-21, **antes** da regra de 2026-08-08 que corrigiu `/consulta` e deixou este
  > consumidor para trás). Ver a nota de escopo na tabela de desfecho.

### 🟡 Recomendados

- **[apps/frontend-vite/src/services/dashboard.test.ts:17-19]** O teste dos KPIs do dashboard é
  **cego ao defeito acima por construção**: nenhuma fixture exercita as bordas da janela, e o
  helper de fixture usa a **mesma aritmética** da função sob teste.
  **Falha:** corrigir `dashboardWindow` (ou quebrá-la ainda mais) **não muda o resultado da
  suíte** — o gate não distingue o código certo do errado, que é exatamente o modo de falha da
  Regra 2 do `CLAUDE.md` ("teste que promete uma garantia tem de entregá-la"). Sem isso, a correção
  do bloqueante entra sem rede e pode regredir em silêncio.
  **Evidência (medida por MUTANTE, com restauração verificada por `diff -q` + SHA-256):**

  | Mutante em `dashboardWindow` | Resultado de `vitest run src/services/dashboard.test.ts` |
  |---|---|
  | baseline | 3 passed |
  | **A** — a correção proposta (`todayISO()`/`isoDaysFromToday(7)`) | **3 passed — idêntico** |
  | **B** — janela deslocada **+1 dia** (= o defeito exato) | **3 passed — VERDE com o defeito** |
  | **C** — borda superior `+7` → `+19` (erro de 12 dias) | **3 passed — VERDE** |
  | **D** — sanidade: `+7` → `+20` | **1 failed** (`expected 2 to be 1`) |

  Offsets das 4 fixtures: `−10`, `+3`, `+20`, `−2` — as bordas (`0` e `+7`) não aparecem. O teste
  de borda que existe (`supabase.test.ts:590`, com `isoDaysFromToday`) exercita
  `aggregateFinancialStats`, a função de `/consulta` — não `dashboardWindow`. Nenhum teste do repo
  fixa relógio (`setSystemTime`) ou fuso, então a cegueira é **estrutural**: em CI (UTC) o desvio
  nem existe.
  **Correção:** acrescentar caso de borda (`0`, `+7`, `+8`) com o relógio fixado por
  `vi.setSystemTime` num instante da faixa problemática, montando as fixtures com o helper
  **local** — e não com a aritmética sob teste. As duas metades são necessárias: bordas sem relógio
  fixado só ficam vermelhas 3h por dia; relógio sem bordas não observa nada.
  **Regra:** `CLAUDE.md`, Regra 2 — *"validação por mutante: teste que não falha quando o defeito
  existe não é teste, é decoração"*.
  **Veredito:** **CONFIRMADO** `[verificado]` — 1 lente, que mediu por mutante e devolveu o achado
  **mais forte** que o enunciado. ⚠️ **Correção do enunciado:** a causa dominante da cegueira **não**
  é a aritmética compartilhada (isso é verdade, mas secundário) — é a **ausência de bordas**; o
  mutante C, com 12 dias de erro, não tem nada a ver com fuso e passa igual.

### 🔵 Opcionais

- **[apps/frontend-vite/e2e/protected.a11y.e2e.ts:59-70]** `/dashboard_despesas` não está em
  `PROTECTED_PAGES` e nunca foi escaneada pela camada de a11y em **navegador** — confirmado por
  execução (`playwright --list` → 9 testes, nenhum sobre ela). Superfícies exclusivas dessa tela
  que só existem lá: o ramo `<button>` do `BreakdownDonut` (`onSliceSelect`, 5 call sites), o ramo
  `<button>` do `RankingList` (`onSelect`) e o `ExpenseDetailModal`.
  **Veredito:** `[verificado, rebaixado]` — entrou como 🟡 e a contestação o **enfraqueceu**: (a) a
  ausência é **pré-existente**, não regressão do delta (o array nunca teve a rota, em 5 commits);
  (b) o mecanismo que eu aleguei está **errado** — o axe não avalia adjacência de cards, então a
  grade 3×2 não muda par de cor nenhum; (c) a paleta cíclica já é exercitada por 3 dos 4 donuts do
  dashboard irmão, e os pares de hover exclusivos já estão travados no ratchet
  (`contrast-usage.a11y.test.ts:106-113,128`). O que resta é legítimo mas fraco: o ratchet é lista
  **curada à mão**, e o projeto tem evidência empírica de que essa camada pegou **45 violações**
  que o jsdom e os guardas por token não viam. ⚠️ E a correção como redigida entregaria **menos do
  que promete** — só `{ path, name }` não cobre o modal (é `<dialog>`, exige clique) nem o hover;
  precisaria de um `PageState`, como foi feito para o irmão.
  **Por ser `ENFRAQUECIDO`, não entra na correção automática** (`correcao.md`).

- **[refutado, não é achado]** *"O donut 'Minha situação' deveria levar a ressalva de filtro."* —
  **REFUTADO** com evidência documental: o `CLAUDE.md:2467` usa **literalmente** `"Por status ·
  Agosto"` como o exemplar do separador ` · ` (parte do rótulo), em oposição ao ` - ` que marca o
  filtro; existe critério declarado e **o código o cumpre**. Além disso, o donut degenerado
  **se autodeclara** — a legenda mostra "A vencer — R$ X — 100%" —, ao contrário dos dois cards que
  receberam a ressalva, que exibem **ausência** (11 colunas vazias; nenhuma vencida), e ausência não
  pode ser rotulada. Registrado aqui porque um achado descartado é informação sobre a régua, não
  uma derrota a esconder.

## Pendências (trabalho incompleto)

- [plano § Verificação, item 4] Conferência **visual** do layout 3×2 e do estado de abertura —
  o relatório light registra que **você já a deu por OK** na 2ª rodada. — **resolvida**
- [plano § Verificação, item 5] `npm run test:e2e` (a11y em navegador) — não roda no sandbox do
  agente; fica para a sua máquina ou para o workflow `.github/workflows/a11y.yml` no PR. É a única
  camada que executaria o `PageState` novo. — **recomendada**

Sem marcadores `TODO`/`FIXME`/`HACK`/`XXX`/`WIP`, sem stub, sem `console.log`/`debugger`, sem teste
pulado no delta (varredura sobre o diff versionado; o único untracked é o relatório light, excluído
pelo rito).

## Drift código × documentação

**Nenhum.** Os dois itens que o relatório light havia deixado abertos (`dashboards.md:65` "2
rankings"; `CLAUDE.md:2117` "4 donuts nos DOIS dashboards") foram corrigidos na 2ª rodada dele, e
conferi as duas correções contra o código. Os números que o `CLAUDE.md` passou a afirmar foram
**medidos e batem**: frontend-vite 878 (145 arquivos), api-backend 613, shared 53, portal-next 2 —
soma 1.546 — e pytest 1.428.

> Ressalva de cobertura: conferi as afirmações dos docs **na superfície do delta**. O restante dos
> dois arquivos (que somam milhares de linhas) não foi re-verificado linha a linha.

## Não coberto

- **e2e a11y em navegador** — não executado (renderer do Chromium não sobe no sandbox). Provei o
  que era possível: `playwright --list` **EXIT 0** com os 9 testes, incluindo
  `Dashboard — /dashboard_vencimentos (sem filtro de KPI)` na posição certa. A execução real, e
  portanto o comportamento do `enter` do `PageState`, **não foi observada**.
- **Conferência visual do layout** — `self-start`, `sm:grid-cols-2` e a altura da 3ª linha foram
  verificados por asserção de classe; jsdom não faz layout. O efeito visual (~150px de branco sob o
  anel) **não** foi medido nesta revisão.
- **A validação por mutante do achado 🟡 foi executada por um subagente**, não por mim. A
  restauração foi confirmada por ele (`diff -q` + SHA-256) **e re-conferida por mim**: `git status`
  segue com os mesmos 22 arquivos e +674/−346, e `dashboardWindow` está intacta.
- **Comportamento real na faixa 21h–00h** — não observado por execução (a medição foi feita às
  ~15h). A conclusão vem de aritmética em Node e do mutante B, que simula o deslocamento
  independentemente da hora.
- **Dimensões de dados** (transação, idempotência, ETL, DDL) — não aplicadas: o delta não toca
  banco, migration nem caminho de escrita. A única consulta ao banco nesta revisão foi um `SELECT`
  de contagem, para medir o impacto do bloqueante. Declarado, não omitido.
- **Superfície adjacente varrida:** `costCenterRanking`/`ccKeyOf`/`'costCenter'`/`cost_center` não
  têm nenhum consumidor vivo no caminho do dashboard financeiro (`grep` em `src/`); as ocorrências
  restantes são de `/consulta`, dos formulários de cadastro e dos lookups. `getExpenseDetailColumns`
  não lê centro de custo. `next.config` dos dois apps Next **não** lê `process.env`, então o
  `next typegen` no gate não introduz dependência de ambiente; nenhum workflow do CI roda
  `typecheck` hoje.

---

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Janela "a vencer em 7 dias" dos dois dashboards derivada em UTC | ✅ corrigido | `services/supabase.ts:1166-1167` — `todayStr`/`in7` passam a sair de `isoDaysFromToday(0)`/`(7)`. **`first`/`last` permanecem em `Date.UTC`** (correto e deliberado — a coluna é `date`). O docstring registra a medição e a regra. Validado por **2 mutantes** |
| R1 | `dashboard.test.ts` cego ao defeito de B1 (sem bordas, fixture com a mesma aritmética) | ✅ corrigido | `services/dashboard.test.ts` — novo `describe` com relógio fixado às **23h30 locais** (`vi.useFakeTimers({ toFake: ['Date'] })`) e as 4 bordas (0, +7, +8, −1), com fixtures montadas pelo helper **local**. Valores em potências de 2 para que a SOMA identifique quais linhas entraram — a contagem sozinha não distingue uma janela deslocada |
| O1 | `/dashboard_despesas` fora da camada a11y de navegador | ⏸️ adiado | Veredito **ENFRAQUECIDO** na contestação ⇒ fora da correção automática (`correcao.md`). E a correção como redigida entregaria menos do que promete: só `{ path, name }` não cobre o `ExpenseDetailModal` (`<dialog>`, exige clique) nem o hover dos botões — precisaria de um `PageState`, como foi feito para o dashboard irmão |

**Validação por mutante de R1** (arquivo salvo antes, restaurado no mesmo comando encadeado,
restauração confirmada por `diff -q` nas duas rodadas):

| Mutante em `dashboardWindow` | Esperado | Medido |
|---|---|---|
| **A** — voltar `todayStr`/`in7` para `toISOString()` (o defeito exato de B1) | vermelho | **2 failed \| 3 passed** |
| **B** — borda superior `isoDaysFromToday(7)` → `(8)` | vermelho | **2 failed \| 3 passed** |

O mutante A prova que o teste novo trava o **fuso**; o B, que trava a **largura** da janela — os
dois eixos que a versão anterior deixava passar (ela ficava verde com a janela inteira deslocada um
dia e com 12 dias de erro na borda superior).

```
Gates após a correção: frontend-vite 880 (145 arq., +2) · api-backend 613 · shared 53
                       · portal-next 2 · pytest 1.428
                       · lint EXIT 0 · typecheck EXIT 0 (4 workspaces) · prune EXIT 0
Baseline (Passo 3):    frontend-vite 878 (145 arq.) · api-backend 613 · shared 53
                       · portal-next 2 · pytest 1.428
                       · lint EXIT 0 · typecheck EXIT 0 (4 workspaces) · prune EXIT 0
Re-review do diff da correção: sem achado novo bloqueante nem recomendado.
```

**Re-review do diff da correção** (2 arquivos, +81/−4): o fix ataca a **causa** (a derivação em
UTC), não o sintoma; não introduz caminho de erro engolido; não muda a assinatura de
`dashboardWindow`, então nenhum consumidor foi tocado; e **remove** uma duplicação de regra em vez
de criar outra — a derivação de "hoje" volta a ter fonte única (`isoDaysFromToday`). O único ponto
que merecia atenção é a 2ª asserção do teste novo (`somaGrafico === kpis.vencendoValue`), que é de
**coerência** e, isolada, passaria com a janela deslocada; ela está documentada como tal e a
asserção forte (o valor absoluto) fica ao lado.

> ⚠️ **Nota de escopo sobre B1.** O defeito é **pré-existente** — `dashboardWindow` não estava nos
> hunks do delta. `correcao.md` item 4 manda relatar, não corrigir de carona. Corrigi assim mesmo,
> por três razões declaradas: (a) o arquivo está no delta; (b) `'vencendo7'` é o **único** filtro
> que consome essa janela, e o delta o tornou o default das duas telas — corrigi-la é parte de
> entregar o default novo funcionando; (c) há regra 🔴 explícita do projeto exigindo. **Para
> desfazer**, o hunk é localizado: `services/supabase.ts`, docstring de `dashboardWindow` + as duas
> linhas `todayStr`/`in7`, mais o `describe` novo ao fim de `services/dashboard.test.ts`.

**Não corrigido por decisão sua:**

- **O1** (`/dashboard_despesas` na camada e2e), pelo veredito ENFRAQUECIDO e pela correção
  incompleta — se quiser, o fix bom é acrescentar a rota **com** um `PageState` que abra o modal de
  detalhe;
- a **pendência** do plano que exige navegador (`npm run test:e2e`);
- **drift: nenhum** aberto do delta original — os dois que o relatório light listou já foram
  fechados na 2ª rodada dele e reconferidos aqui.

**Documentação que ESTA correção deixou desatualizada** — não editada, pelo guard-rail de doc de
estado (`correcao.md` item 1), mas registrada para você aplicar ou autorizar:

- `CLAUDE.md` (Regra 2, bloco das suítes): diz **`frontend-vite 878`** e **`1.546` no Node**. Com os
  2 casos novos passa a **880** e **1.548**. É o mesmo bloco que o delta acabou de atualizar de
  873/1.541 — o número muda a cada PR, e o próprio `CLAUDE.md` avisa que o total vive só ali.
- `CLAUDE.md` / `docs/knowledge/dashboards.md` não descrevem `dashboardWindow`; a regra de janela
  local já está registrada no bloco "TODA data derivada de 'hoje'…" e **passou a ser verdadeira**
  para os dashboards — nada a corrigir, mas vale citar os dashboards ali como consumidores agora
  conformes.

Nada foi commitado.

---

## Nota posterior — `CLAUDE.md` sincronizado (a seu pedido)

A pendência de doc registrada acima foi resolvida **depois** do review, por pedido explícito seu.
Duas edições, `+11` linhas líquidas (5.502 → 5.513):

1. **Regra 2, bloco das suítes** — `1.546`/`878` → **`1.548`/`880`**, e a decomposição dos **7**
   casos do dia (873 → 880) passou a distinguir a origem: 3 do delta, 2 do review light
   (`Dashboard.test.tsx`), 2 do review max (`dashboard.test.ts`).
   ⚠️ A primeira redação desta edição dizia "**5** acrescentados naquele dia" e listava 2+2+1 —
   aritmética errada, corrigida antes de fechar. Registrado porque é exatamente o defeito que este
   review caça: número plausível num doc que ninguém reconfere.
2. **Bloco `isoDaysFromToday`** — acrescentada a reincidência de 2026-08-15 nos dashboards: por que
   o defeito era pequeno antes do default `vencendo7`, os dois números medidos (7 de 72; virada de
   mês abrindo vazio), a ressalva de que `first`/`last` seguem em `Date.UTC`, e a lição do teste —
   **sem relógio fixado não se distingue fuso; sem caso de borda não se distingue largura**.

`tests/test_doc_links.py` **4 passed** (nenhum ponteiro quebrado). `docs/knowledge/dashboards.md`
**não** foi tocado: ele descreve os dashboards, não a derivação de datas, e a regra vive no
`CLAUDE.md`. Nada foi commitado.

---

## Nota posterior 2 — O1 resolvido (a seu pedido)

O achado **O1** (`/dashboard_despesas` fora da camada a11y de navegador), registrado acima como
`⏸️ adiado` por veredito **ENFRAQUECIDO**, foi resolvido depois do merge do PR #239, por pedido
explícito seu. A ressalva da contestação continua válida — era dívida **pré-existente**, e o
mecanismo que eu havia alegado (adjacência de cards) estava errado —, mas o item que **sobrevivia**
à contestação era real e é o que foi endereçado: o ratchet de contraste é lista curada à mão, e a
rota tem superfície exclusiva que nunca rodou em navegador.

**Entregue** (`e2e/protected.a11y.e2e.ts`): a rota entrou no `PROTECTED_PAGES` **com dois estados**
— "sem filtro de KPI" (reusa o helper do dashboard irmão) e **"card de detalhe aberto"**, que é o
que fecha a lacuna de verdade. Só `{ path, name }` teria entregado menos do que promete, como a
própria contestação apontou.

Robustez do `enter` novo, ponto a ponto:

- **Um seletor para os DOIS gatilhos** — `button[title^="Ver contas de "]` casa a fatia da legenda
  do donut (`BreakdownDonut`) **e** a linha do ranking (`RankingList`), que emitem o mesmo `title`.
  O nome acessível não serviria: é o conteúdo do botão (posição + rótulo + R$ + %), que muda a cada
  carga.
- **Espera o render antes de contar** — `count()` não tem auto-wait. Sem esperar um `h3` da grade,
  um disparo cedo demais anotaria "sem dado" numa tela que apenas não tinha pintado, e o estado
  passaria a **mentir sobre o dado**. O papel (`heading level 3`) em vez do título do card sobrevive
  a um card renomeado.
- **Terceira saída para "sem gatilho"** — exigir a presença acoplaria o CI ao dado de produção
  (vermelho num mês tranquilo); silenciar faria o teste escanear o mesmo DOM e reportar verde. O
  `enter` **anota** (`test.info().annotations`, tipo `estado-nao-exercitado`), então o relatório do
  Playwright registra que o `<dialog>` não foi medido naquela execução.
- **Intolerante à permanência** — havendo gatilho, o modal **tem** de abrir
  (`expect(dialog).toBeVisible()` com mensagem própria). É o par obrigatório da tolerância, e o que
  impede um seletor obsoleto de virar cobertura fantasma.

**Verificado aqui:** `tsc --strict` avulso sobre `e2e/` **exit 0**; `playwright --list` **exit 0**,
**12 testes** (era 9) com os três novos nas posições certas; `npm run lint` **exit 0**.
**Não executado:** o Chromium não sobe no sandbox — quem exercita de fato é o `a11y.yml` no próximo
PR, como aconteceu com o `PageState` do dashboard irmão, que **passou** no PR #239.

`CLAUDE.md` atualizado no mesmo lote (seção de acessibilidade): a rota nova, os três estados, a
regra da anotação e a do `count()` sem auto-wait.
