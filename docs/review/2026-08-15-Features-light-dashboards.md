# Code Review — Features / dashboards (2026-08-15)

## Resumo

**Alvo:** `/dashboard_despesas` e `/dashboard_vencimentos`
(`~/.claude/plans/spicy-hatching-sunrise.md` — "default 'A vencer em 7 dias', layout 3×2 do
/dashboard_despesas e limpeza"; o plano foi resolvido e usado como régua de pendências).
**Modo:** light (sem passo de ataque, sem verificação adversarial)
**Delta:** 16 arquivos alterados, 0 novos, +453/−319 linhas (working tree, nada commitado)
**Régua:** `CLAUDE.md` (projeto) · `docs/knowledge/dashboards.md` · `CLAUDE.md` do workspace ·
`~/.claude/CLAUDE.md` (global) · o plano acima
**Gates:** frontend-vite **876** (145 arquivos, `--maxWorkers=1`) · api-backend **613** ·
packages/shared **53** · portal-next **2** · pytest **1.428** · lint **0/0** (4 workspaces) ·
typecheck **OK** (4 workspaces) · ts-prune **0** · e2e a11y **não executado** (exige navegador; o
renderer do Chromium não sobe no sandbox do agente — limitação registrada no `CLAUDE.md`)

A mudança é inteiramente de apresentação: default de filtro nas duas telas, remoção do card
"Ranking de centros de custo" com a query que só existia para ele, fusão dos dois grids de
`/dashboard_despesas` numa grade 3×2, e a documentação correspondente. Nenhuma migration, nenhum
caminho de escrita, nenhum contrato de dados tocado. **A limpeza está completa e verificada** — não
sobrou nenhuma referência viva a `costCenterRanking`/`ccKeyOf`/`'costCenter'`/`cost_center` no
caminho do dashboard financeiro (só menções em comentário, deliberadas), e os dois testes que
cobriam regra ainda viva foram **portados** em vez de apagados, exatamente como o plano previa.
Não há bloqueante. Os três recomendados são todos sobre **o que o novo default deixou de dizer ou
de exercitar**, não sobre o número que ele calcula.

## Achados

### 🔴 Bloqueantes

Nenhum.

### 🟡 Recomendados

- [apps/frontend-vite/src/pages/Dashboard.tsx:100-101,154-155] Os dois cards exclusivos de
  `/dashboard_vencimentos` afirmam no subtítulo um escopo que o novo default de filtro torna
  impossível, e nenhum dos dois declara o recorte.
  **Falha:** abertura da tela (filtro `vencendo7`). (a) O card "Contas críticas e prioritárias" tem
  subtítulo "Água, luz, internet, aluguel, tributos **e vencidas**", mas `matchesKpiFilter` exige
  `status_id === A_VENCER` e `PriorityAccount.critical = isVencido` — as duas condições são
  mutuamente exclusivas **por construção**, então é impossível haver uma linha vencida ali no estado
  de abertura, em qualquer base de dados. (b) O card "Movimentações mês a mês" tem subtítulo "Total
  a pagar vs. pago por vencimento — 2026" e desenha 12 colunas, das quais no máximo uma tem barra
  (`fYear` também passa pelo filtro). Quem lê o card conclui "2026 só teve movimento em agosto" e
  "não há conta vencida" — o oposto do que a base diz (126 contas em `vencido` na medição
  registrada no `CLAUDE.md`).
  **Evidência:** `services/supabase.ts:1130` (`case 'vencendo7'` exige `STATUS_ID_A_VENCER`),
  `:1236` (`fYear` filtrado), `:1287-1289` (`critical: isVencido`); subtítulos em `Dashboard.tsx:101`
  e `:155`. O chip "filtrando: A vencer em 7 dias" existe no cabeçalho, mas é global — não está no
  card que faz a afirmação.
  **Correção:** aplicar aos dois subtítulos o mesmo `kpiSuffix` que `/dashboard_despesas` já usa no
  donut "Classificação Financeira" (`DashboardFinanceiro.tsx:124`) — 3 linhas, mecanismo já
  existente e testado na tela irmã.
  **Regra:** `CLAUDE.md`, Onda 9 / migration 124 — *"o número está certo, e a ausência da ressalva
  faz o leitor concluir o oposto"* e *"função que agrupa por período DECLARA o balde parcial"*. O
  plano decidiu **filtrar tudo** (comportamento); não decidiu **não declarar** o recorte (rótulo).

- [apps/frontend-vite/src/pages/Dashboard.test.tsx] A regra nova "trocar de mês/ano limpa o filtro"
  é testada só na função PURA (o hook); nenhum teste a exercita no call site, com a página montada.
  **Falha:** o efeito que o usuário enxerga é "clicar noutro mês recarrega o dashboard SEM o
  filtro". Hoje isso depende de três peças testadas em separado — o header chamar
  `filters.setMonth` (testado com mock), o hook limpar (testado isolado) e `load` refazer o fetch
  com o novo par (mês, filtro). Um defeito na composição — por exemplo dois fetches por clique, ou
  o `load` disparando com o filtro antigo — passa com a suíte inteira verde, porque nenhum teste
  observa a chamada resultante.
  **Evidência:** `useDashboardFilters.test.ts:56-100` cobre o hook; `DashboardHeader.test.tsx:24`
  usa `setMonth: vi.fn()` (mock); em `Dashboard.test.tsx` não há nenhum clique em botão de mês —
  os casos de filtro clicam em card de KPI e em `<select>` de empresa.
  **Correção:** um caso em `Dashboard.test.tsx` que clica noutro mês e assevera
  `getDashboardData` **chamado uma vez** com `(novoMes, ano, 'month', 'total', undefined)`.
  **Regra:** `CLAUDE.md`, Regra 2 item 5 — *"testar a função PURA não cobre o CALL SITE"*.

- [apps/frontend-vite/e2e/protected.a11y.e2e.ts:17] A camada de a11y em **navegador** perde, de
  forma determinística, a única renderização real das linhas críticas do `PriorityList`.
  **Falha:** o spec navega para `/dashboard_vencimentos` e escaneia o DOM como ele abre. Com o
  default `vencendo7`, o ramo `err` do `PriorityList` (`bg-status-error-bg` +
  `border-l-status-error-solid` + selo `bg-status-error-solid/10 text-status-error-fg` +
  `StatusBadge` "vencido") **nunca** é renderizado — não por falta de dado, mas porque filtro e
  condição são incompatíveis por construção. É justamente a família de par tintado que o
  `CLAUDE.md` registra como só detectável em navegador (o jsdom tem `color-contrast` desligado, e
  `contrast-usage.a11y.test.ts` cobre `status-error-fg`/`gray-600` sobre `status-error-bg`, mas não
  `slate-700` nem o selo do ícone).
  **Evidência:** `PriorityList.tsx:28-40` (ramo `err`); `e2e/protected.a11y.e2e.ts:37-43` (goto +
  scan, sem interação); `tests/contrast-usage.a11y.test.ts:101-102` (os dois únicos pares sobre
  `status-error-bg` no ratchet).
  **Correção:** no caso do Dashboard, limpar o filtro antes do scan (clique no ✕ "filtrando") ou
  escanear os dois estados — mesmo padrão de `DashboardHeader.a11y.test.tsx`, que já varre "os dois
  estados que mudam a árvore acessível".
  **Regra:** `CLAUDE.md`, seção de acessibilidade — a camada de navegador existe para o que o jsdom
  não vê, e já pagou por si (45 violações de contraste encontradas).

### 🔵 Opcionais

- [apps/frontend-vite/src/services/supabase.ts:1452] O comentário do `case 'grupoTipo'` ainda diz
  "o Tipo do subgrupo informado (5/6/7)" enquanto o campo `typeGroupId`, 40 linhas acima, já diz
  "(5/6/7/9)" — o tipo 9 (Custos de Importação) entrou em 2026-08-14. Linha adjacente ao hunk, não
  tocada por ele.
- [apps/frontend-vite/src/hooks/useDashboardFilters.ts:61] `<T,>` — a vírgula de desambiguação só é
  necessária em arquivo `.tsx`; aqui é `.ts`. Inofensiva.

## Pendências (trabalho incompleto)

- [plano § Verificação, item 4] Conferência **visual** das 3 linhas × 2 colunas, do estado de
  abertura (card marcado + selo "filtrando") e do comportamento ao trocar o mês — exige navegador e
  olho humano; não executável aqui. — **recomendada**
- [plano § Verificação, item 5] `npm run test:e2e` (a11y em navegador) — não roda no sandbox do
  agente; fica para a máquina do usuário ou para o workflow `.github/workflows/a11y.yml` no PR. O
  achado R3 acima só é observável nessa camada. — **recomendada**

Sem marcadores `TODO`/`FIXME`/`HACK`/`XXX`/`WIP`, sem stub, sem `console.log`/`debugger`, sem teste
pulado no delta (varredura sobre o diff versionado; não há arquivo untracked).

## Drift código × documentação

- `docs/knowledge/dashboards.md:65` diverge do código: o parágrafo do escopo ainda diz "TODA métrica
  (os 5 KPIs valor+contagem, o card de total, os 5 donuts e os **2 rankings**)". A seção "Ranking"
  do mesmo arquivo (`:211-232`) já foi atualizada para UM ranking — o mesmo commit corrigiu uma
  metade e deixou a outra. O invariante em si continua correto; o número está velho. — decisão
  pendente do usuário
- `CLAUDE.md:2117` (entrada `BreakdownDonut`) descreve o token `sm` como "108px/inset-3 (**4 donuts
  na mesma linha nos DOIS dashboards**)". Vale para `/dashboard_vencimentos` (`xl:grid-cols-4`), mas
  não para `/dashboard_despesas`, que hoje tem **5** donuts numa grade de 2 colunas e ainda
  sobrepõe o tamanho com `diameterPx`. Imprecisão anterior a este delta (nasceu com o 5º donut, em
  2026-08-14), adjacente ao que foi mexido. — decisão pendente do usuário

> Nenhum dos dois foi corrigido: sincronizar doc de estado durante o review apagaria a evidência da
> divergência (rito, Passo 4 item 4 e `correcao.md` item 1).

## Não coberto

- **e2e a11y em navegador** — não executado (renderer do Chromium não sobe no sandbox). É o gate que
  observaria o achado R3; ele foi derivado por leitura de código + construção lógica, não por
  execução.
- **Conferência visual do layout** — `self-start`, `sm:grid-cols-2` e a altura da linha 3 foram
  verificados por asserção de classe (jsdom não faz layout). O efeito visual descrito nos
  comentários (~150px de branco sob o anel) **não** foi medido nesta revisão.
- **`docs/knowledge/dashboards.md`** — lido por inteiro e conferido contra o código; as duas
  divergências acima estão na seção Drift. O restante do arquivo (dashboard de vencimentos, donuts,
  drill-down) foi lido, não re-verificado linha a linha contra o código fora do delta.
- **Dimensões de dados** (transação, idempotência, ETL, SQL) — não aplicadas: o delta não toca
  banco, migration nem caminho de escrita. Declarado, não omitido.
- **Superfície adjacente varrida e limpa:** `costCenterRanking`/`ccKeyOf`/`'costCenter'` não têm
  nenhum consumidor vivo (`grep` em `src/`); `useDashboardFilters` só é consumido pelas duas páginas
  e pelo `DashboardHeader`; `getExpenseDetailColumns` não lê centro de custo; `MonthlyFlow` já
  protege a divisão com `Math.max(1, …)`, então o cenário "todos os baldes zerados" que o novo
  default torna provável **não** produz `NaN`.

---

## Errata do Passo 3 — o baseline de `typecheck` estava errado

O Resumo acima registra `typecheck OK (4 workspaces)`. **Está errado, e o erro é de medição, não
de código.** Ao repetir os gates na fase de correção, com o código-fonte e o exit code medidos
explicitamente:

```
npm run typecheck   → EXIT 1 · 5 erros, TODOS em apps/api-backend/.next/dev/types/routes.d.ts
```

O arquivo é **gerado** (`next dev`), está **gitignored** (`apps/api-backend/.gitignore:17`) e ficou
**corrompido por escrita parcial** — o bloco das linhas 92-100 reaparece a partir da 101, começando
no meio de um token. `mtime = 11:29:52`, ou seja, **antes desta sessão** (primeira medição às
12:48). Nenhum arquivo de `apps/api-backend` está no delta, e os outros três workspaces
(`frontend-vite`, `portal-next`, `@sheild/shared`) compilam limpos.

**Por que passou despercebido:** as duas medições do baseline terminavam em `| tail -12` e
`| grep -E "^>"`. O exit code de um pipeline é o do ÚLTIMO comando, então o `1` do npm virou `0` do
`tail`/`grep`; e como o `tsc` imprime erro em **stdout**, o `grep "^>"` ainda filtrou as cinco
linhas de erro. É exatamente a armadilha registrada na memória `pipe-tail-masks-exit-code` — anotada
aqui porque um baseline verde por acidente é pior que baseline ausente: ele faria qualquer
vermelho posterior parecer regressão da correção.

**Classificação correta:** gate vermelho **no baseline**, por artefato de build fora do delta
(rito, Passo 3 item 4). Não é achado desta revisão nem regressão da correção.
**Passo para o usuário:** `rm -rf apps/api-backend/.next` (ou parar e subir o `next dev` de novo) e
repetir `npm run typecheck`. Não executado aqui: apagar o cache de build enquanto um `next dev`
pode estar rodando na máquina do usuário é efeito colateral fora do escopo do review.

## Correções aplicadas

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| R1 | Cards de `/dashboard_vencimentos` afirmam ano/vencidas sem declarar o filtro | ✅ corrigido | `Dashboard.tsx:64-77,113,170` — os dois subtítulos passam a levar o sufixo do KPI ativo, pelo mesmo mecanismo e mesmo formato (` - `) de `/dashboard_despesas`. Novo caso em `Dashboard.test.tsx` cobre o estado filtrado **e** o estado limpo; validado por mutante (remover o sufixo ⇒ 1 vermelho) |
| R2 | Regra "navegar limpa o filtro" sem teste no call site | ✅ corrigido | `Dashboard.test.tsx` — clica noutro mês e assevera a chamada resultante `(outroMes, ano, 'month', 'total', undefined)`, o **delta** de chamadas (= 1, provando que mês+filtro vão no mesmo lote) e o sumiço do chip. Validado por mutante no hook (tirar o `setFilter('total')` ⇒ este teste de PÁGINA fica vermelho) |
| R3 | A camada a11y de navegador perde a linha crítica do `PriorityList` | ⏸️ adiado | Correção é de 2 linhas em `e2e/protected.a11y.e2e.ts` (limpar o filtro antes do scan), mas **não consigo validá-la**: o Chromium não sobe no sandbox e o spec roda em todo PR pelo `a11y.yml` — um seletor errado reprovaria o CI sem eu ter como ver. `correcao.md` item 6 |

**Achado novo, encontrado no re-review da própria correção (Passo 8 item 6) e corrigido na mesma
fase:** o fix de R1 criou uma **segunda cópia** da expressão do sufixo (uma em cada página), com o
separador ` - ` decorado nos dois lugares — precisamente o padrão "a 2ª cópia diverge no primeiro
ajuste" que o `CLAUDE.md` registra à exaustão, e ainda por cima na regra cuja função é impedir que o
leitor conclua o oposto do dado. Extraído para **`kpiFilterSuffix(filter)`** em
`components/dashboard/constants.ts`, ao lado do `KPI_FILTER_LABEL` que ele consome (o comentário
daquele mapa já declarava "o cabeçalho e os subtítulos dos gráficos consomem o mesmo mapa" — a
extração completa essa intenção). `DashboardFinanceiro.tsx` passou a usar o helper; comportamento
byte a byte idêntico, provado pelos testes daquela página, que asseveram a string renderizada.

```
Gates após a correção: frontend-vite 878 (145 arq.) · api-backend 613 · shared 53 · portal-next 2
                       · pytest 1.428 · lint EXIT 0 · prune EXIT 0
                       · typecheck EXIT 1 — 5 erros, todos no artefato gerado (ver Errata)
Baseline (Passo 3):    frontend-vite 876 (145 arq.) · api-backend 613 · shared 53 · portal-next 2
                       · pytest 1.428 · lint 0/0 · prune 0
                       · typecheck: MESMOS 5 erros, mascarados pelo pipe (ver Errata)
Re-review do diff da correção: 1 achado novo (a 2ª cópia do sufixo), corrigido na mesma rodada;
                       2ª passada sem achado novo.
```

Delta dos testes: **+2** no `frontend-vite` (876 → 878) — os dois casos novos em
`Dashboard.test.tsx`. Nenhum teste existente foi alterado ou removido pela correção.

**Não corrigido por decisão sua:**

- os **dois itens de Drift** (`dashboards.md:65` "2 rankings"; `CLAUDE.md:2117` "4 donuts nos DOIS
  dashboards") — doc de estado não é sincronizado durante o review;
- os **dois 🔵 opcionais** (comentário "(5/6/7)" em `supabase.ts:1452`; `<T,>` em arquivo `.ts`);
- **R3** (spec e2e), pelo motivo na tabela;
- as **duas pendências do plano** (conferência visual e `npm run test:e2e`), que exigem navegador.

**Documentação que a correção deixou desatualizada** — não editada aqui, pelo mesmo guard-rail de
doc de estado, mas registrada para você aplicar ou autorizar: `CLAUDE.md:2426` diz que
`KPI_FILTER_LABEL` é "Consumido pelo `DashboardHeader` (chip) **e** pelo subtítulo do donut
'Classificação Financeira' de `/dashboard_despesas`". Passou a ter um terceiro consumidor — o
helper `kpiFilterSuffix`, usado também pelos dois cards de `/dashboard_vencimentos`.

Nada foi commitado.

---

## 2ª rodada — itens resolvidos a pedido do usuário

| # | Item | Desfecho | Observação |
|---|---|---|---|
| — | Pendência: conferência visual do layout 3×2 | ✅ resolvida pelo usuário | Confirmada como OK |
| R3 | Camada a11y de navegador perde a linha crítica do `PriorityList` | ✅ corrigido | `e2e/protected.a11y.e2e.ts` — ver desenho abaixo |
| O1 | Comentário "(5/6/7)" em `supabase.ts` | ✅ corrigido | Passa a "(5/6/7/9)", nomeando o tipo 9 e a data em que ele entrou |
| O2 | `<T,>` em arquivo `.ts` | ✅ corrigido | `useDashboardFilters.ts` |
| Doc | `CLAUDE.md:2426` — consumidores do `KPI_FILTER_LABEL` | ✅ corrigido | Reescrito em torno de `kpiFilterSuffix`, com o porquê da ressalva e do separador |
| Drift | `dashboards.md:65` "os 5 donuts e os **2 rankings**" | ✅ corrigido | → "e o ranking" |
| Drift | `CLAUDE.md:2117` token `sm` = "4 donuts nos DOIS dashboards" | ✅ corrigido | Distingue as duas telas (4 numa linha × 5 em grade de 2 colunas com `diameterPx`) |

> Os dois itens de Drift **não** estavam na lista do usuário, que pediu "Doc". Foram incluídos por
> serem factualmente inequívocos (o próprio `dashboards.md` já dizia "um ranking" na seção vizinha)
> e por estarem na mesma superfície que a correção de doc pedida — reverter qualquer um é um
> `git checkout` do arquivo.

### R3 — o desenho, e o que nele é robustez

`e2e/protected.a11y.e2e.ts` ganhou o conceito de **estado extra da mesma rota** (`PageState =
{ name, enter }`), com um `test` por estado. Hoje há um: `Dashboard — /dashboard_vencimentos (sem
filtro de KPI)`.

- **Estrutura:** o estado é declarado **na entrada da rota**, não num `if` dentro do laço — a
  próxima tela que precisar disso não mexe no laço, e o título do teste nomeia o estado, então a
  falha diz o que quebrou. `abrir()` extraiu o `goto` + `networkidle` que estavam duplicados e
  acrescentou a espera pelo `h1`: `networkidle` prova que a rede sossegou, não que o React
  renderizou.
- **Robustez do `enter`:** é **tolerante à ausência** do gatilho — se o chip "filtrando: …" não
  estiver lá (o default já mudou duas vezes: `total` → `aVencer` → `vencendo7`), não clica — e
  **intolerante à permanência** do estado que promete deixar: termina com
  `expect(chip).toHaveCount(0)`. Sem essa asserção, um `enter` que falhasse em silêncio faria o
  teste escanear o MESMO DOM duas vezes e reportar verde — pior que não existir, porque a suíte
  passaria a declarar uma cobertura que não tem.
- **Seletor por regex** (`/^filtrando:/`), não pelo rótulo do KPI — sobrevive à próxima troca de
  default.
- **`waitForLoadState` após o clique:** limpar o filtro REFAZ a leitura; escanear antes dela voltar
  mediria a tela em carregamento.
- **`.first()` no `h1`:** o strict mode do Playwright explodiria numa página com dois `h1`,
  transformando um detalhe de marcação num erro que não menciona acessibilidade.
- ⚠️ **Deliberadamente NÃO assertado:** a presença de uma linha crítica. Isso acoplaria o CI ao dado
  de produção e faria a suíte falhar num mês sem conta vencida. O estado restaura a cobertura que
  existia antes do novo default; não inventa garantia de dado.

**Verificação possível aqui:** o arquivo **typecheca** (`tsc --strict` avulso sobre `e2e/`, exit 0 —
o `e2e/` fica fora do `npm run typecheck`) e o **Playwright carrega e lista** os 9 testes, com o novo
título no lugar certo (`--list`, exit 0). **Não executado:** o Chromium não sobe no sandbox; a
execução real fica para a sua máquina ou para o `a11y.yml` no PR.

```
Gates (final): frontend-vite 878 (145 arq.) · api-backend 613 · shared 53 · portal-next 2
               · pytest 1.428 · lint EXIT 0 · prune EXIT 0 · test_doc_links 4
               · typecheck EXIT 1 — os MESMOS 5 erros do artefato gerado (ver Errata; inalterado)
               · e2e: typecheck avulso EXIT 0 · playwright --list EXIT 0 (9 testes) · execução não
```

Nada foi commitado.

---

## 3ª rodada — o gate de `typecheck`, resolvido na causa

A Errata acima classificou o vermelho como "artefato de build corrompido, fora do delta" e deixou
o passo `rm -rf .next` para o usuário. **Isso trata o sintoma:** o artefato volta a ser escrito no
próximo `next dev`, e o gate volta a poder quebrar por algo que ninguém escreveu. Resolvido na
causa, em 4 arquivos:

| Arquivo | Mudança |
|---|---|
| `apps/api-backend/package.json` · `apps/portal-next/package.json` | `typecheck` passa a ser **`next typegen && tsc --noEmit`** |
| `apps/api-backend/tsconfig.json` · `apps/portal-next/tsconfig.json` | `exclude` ganha **`.next/dev/types`** |

**O diagnóstico que faltava.** O `include` que o Next gerencia traz **dois** diretórios de tipos
gerados, e eles têm donos diferentes:

- `.next/types/**` — produzido sob demanda por `next typegen` / `next build`;
- `.next/dev/types/**` — **cache do `next dev`**, escrito quando o servidor de desenvolvimento roda
  e nunca mais revisado.

O segundo é a fonte da não-determinação: o arquivo de 11:29:52 tinha **7 linhas duplicadas**
terminando em `{ id } = await context.params` (escrita parcial) **e** estava desatualizado — não
conhecia `/api/contas/[id]/attachments/[attId]` nem `/upload-url`, rotas que existem há semanas.

Medição que decidiu o desenho: `next typegen` **não tocou** no cache do dev numa invocação e tocou
na seguinte. Como não dá para confiar nisso, a exclusão é o que garante o determinismo — o `tsc`
passa a ler **um só** artefato, e esse é regenerado imediatamente antes da checagem. **`exclude`
vence `include`**, então a regra sobrevive ao Next reescrever o `include` (verificado: o `include`
saiu intacto do `typegen` e o `exclude` continuou lá).

**Provado por mutante, nas duas direções** — porque "o gate ficou verde" sozinho não distingue
consertado de cego:

| Mutante | Esperado | Medido |
|---|---|---|
| A — recorromper `.next/dev/types/routes.d.ts` com a MESMA forma do defeito real (112 linhas) | gate **verde** (o cache saiu do programa) | `tsc --noEmit` **exit 0** |
| B — trocar `params: Promise<{ id: string }>` por `{ idErrado: string }` em `app/api/contas/[id]/route.ts` | gate **vermelho** pela validação de rotas | **exit 2**, 1º erro em `.next/types/validator.ts`: *"does not satisfy the constraint `RouteHandlerConfig<"/api/contas/[id]">`"* |

Os dois foram revertidos com confirmação por `diff -q`.

**Ganho não previsto:** num clone limpo (ou no CI) `.next` não existe, o glob não casava nada e o
**`validator.ts`** — o arquivo gerado que confere a assinatura de cada `route.ts` contra as rotas
reais — **nunca era checado**; ele só entrava no programa se alguém tivesse rodado `next dev` ou
`next build` antes na mesma máquina. Provado removendo o `.next` do `portal-next` e rodando o gate:
**exit 0**, com `typegen` criando os três arquivos do zero. Ou seja, o gate deixou de depender do
histórico da máquina e passou a checar mais do que antes. Custo: ~5 s por app Next.

```
Gates (3ª rodada): typecheck EXIT 0 nos 4 workspaces  ← primeiro verde da sessão
                   lint EXIT 0 · prune EXIT 0
                   api-backend 613 · portal-next 2 · shared 53 · test_doc_links 4
                   frontend-vite 878 (145 arq., medido na 2ª rodada; nada aqui o toca)
```

Regra registrada no `CLAUDE.md`, junto do bloco das armadilhas do dev server Next — inclusive o
aviso de **nunca medir gate com `| tail`/`| grep`**, que foi o que escondeu este vermelho em duas
medições (memória `pipe-tail-masks-exit-code`).

Nada foi commitado.
