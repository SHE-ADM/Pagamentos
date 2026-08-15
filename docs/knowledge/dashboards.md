# Dashboards — `/dashboard_vencimentos` e `/dashboard_despesas`

Extraído do `CLAUDE.md` em 2026-08-10, quando as duas linhas da tabela de rotas somavam **15.695
caracteres** (4% do arquivo) numa única célula de tabela — formato em que ninguém consegue ler nem
revisar. O `CLAUDE.md` guarda os **invariantes** ("o que não pode quebrar"); aqui fica o **porquê**,
a decisão de produto que originou cada escolha e a medição que a sustenta.

> As duas telas compartilham a **casca** (`useDashboardFilters` + `DashboardHeader` + `KpiRow`) e os
> primitivos de gráfico (`BreakdownDonut`/`KpiCard`/`RankingList` + cores) em
> `components/dashboard/`. Essa parte continua no `CLAUDE.md`, nas seções "Casca compartilhada dos
> dashboards" e "Destaque dos cards de KPI" — é regra de reuso, não detalhe de tela.

---

## `/dashboard_vencimentos` (`Dashboard.tsx`)

KPIs e gráficos de `financial_account_control` por mês ou geral (`getDashboardData`).

**Filtro por EMPRESA** (`<select>` "Empresa", 1º dos controles; vazio = TODAS; hook
`useCompanyOptions`): é o 5º parâmetro `skCompany` de `getDashboardData`, aplicado nas **DUAS**
leituras (escopo + ano) — senão o gráfico anual mostraria as duas empresas. Aqui ele escopa
**TUDO** (KPIs, donuts e gráfico anual), porque no dashboard todo indicador deriva do escopo; e
**aplica na hora** (não há "Buscar"). Convive com o filtro de KPI.

> *Até 2026-08-08 este trecho contrastava com `/consulta`, "cujos KPIs gerais são globais".
> `/consulta` passou a filtrar os 5 KPIs também, então o contraste não existe mais.*

**Cards de KPI clicáveis = filtro** (Total / Pagos / A vencer / A vencer em 7 dias / Vencidas):
clicar aplica o filtro (`KpiFilter`) a TODOS os gráficos; os KPIs seguem com os totais completos.

**ABRE FILTRADO em "A vencer em 7 dias"** (`useDashboardFilters('vencendo7')`, decisão do usuário
2026-08-15 — antes abria em `total`, sem card marcado). Duas consequências que são da SEMÂNTICA do
filtro, não defeitos, e foram aceitas explicitamente ao decidir:

- o gráfico **anual** "Movimentações mês a mês" também é recortado (`fYear` passa pelo mesmo
  `matchesKpiFilter`), então abre com ~1 barra;
- **"Contas críticas e prioritárias" não mostra vencidas na abertura**: `vencendo7` exige
  `status_id = a vencer`, e vencida é outro status.

Um clique no card marcado (ou no ✕ do cabeçalho) devolve a visão completa. A alternativa —
o anual ignorar o filtro sempre — foi descartada: faria o anual divergir dos demais gráficos em
QUALQUER filtro, não só no default.

**4 donuts:** situação · tipos de conta · **Tributos** (só guias tributárias, detalhadas) · formas
de pagamento. O donut de tipos de conta **colapsa os tributários numa fatia "Tributos"** via
`groupDocumentTypeLabel`/`isTaxDocumentType`. Usam `size="sm"` (os 4 na mesma linha no `xl`; só o
círculo é menor — 108px). O donut de situação (`StatusDonut`) é local desta página.

**Também exclusivo desta tela:** o gráfico "Movimentações mês a mês" (`MonthlyFlow`) e a lista
"Contas críticas e prioritárias" (`PriorityList`/`classifyPriority`/`priorityAccounts`).

---

## `/dashboard_despesas` (`DashboardFinanceiro.tsx`)

### Escopo — o invariante central

`financial_account_control` **escopado a DESPESAS + CUSTO** (`getFinancialDashboardData`): conta
cujo plano de contas tem grupo com Natureza "Despesas" **ou** "Custo"
(`chart_account.group.type_group_id ∈ {TYPE_GROUP_ID_DESPESAS=2, TYPE_GROUP_ID_CUSTO=8}`, migration
094). Decisão do usuário em 2026-07-22: **custo de mercadoria é conta a pagar** e entra em toda
métrica.

🔴 **Dashboard EXCLUSIVO do escopo — não regredir.** TODA métrica (os 5 KPIs valor+contagem, o card
de total, os 5 donuts e o ranking) é computada ÚNICA e EXCLUSIVAMENTE sobre linhas do escopo. O
recorte é feito por `isExpenseRow` **ANTES de qualquer agregação** (`monthRows =
monthRowsAll.filter(isExpenseRow)`; KPIs sobre `monthRows`, gráficos/rankings sobre `fMonth`,
derivado dele). Conta **SEM classificação** — ou de outra natureza, ex. Passivo — fica FORA de tudo:
não soma nem conta.

A página consome **um ÚNICO serviço** (`getFinancialDashboardData`); **não há busca paralela de
totais globais**.

**Mantém** os 5 KPIs, o filtro de EMPRESA, mês/ano e escopo — todos restritos ao escopo 2+8.

### Estado inicial e leitura

**ABRE FILTRADO no KPI "A vencer em 7 dias"** (`useDashboardFilters('vencendo7')`, decisão do
usuário 2026-08-15 — antes era `'aVencer'`): os CARDS seguem com os totais completos do mês e só os
gráficos filtram, então o card "Despesas no mês" e o furo dos donuts mostram números diferentes
**de propósito**. O card abre com o destaque de selecionado (ver "Destaque dos cards de KPI" no
`CLAUDE.md`) e o ✕ do cabeçalho — ou clicar no card — limpa para `total`.

🔴 **Trocar de mês/ano LIMPA o filtro de KPI** (`useDashboardFilters`, mesma mudança). `vencendo7`
é uma janela MÓVEL a partir de hoje, então só intersecta o mês corrente: mantendo-o grudado,
navegar para outro mês devolveria "Sem contas no período." em TODOS os gráficos — mensagem que
culpa o PERÍODO por um recorte que é do FILTRO, e o mês escolhido tem contas. A limpeza só dispara
quando o valor MUDA de fato (clicar no mês já selecionado preserva o filtro) e vale para mês e ano;
**escopo fica de fora**, porque "todas as contas" + próximos 7 dias é combinação válida.

**NÃO tem o gráfico "Movimentações mês a mês"** (removido a pedido do usuário) — por isso faz
**leitura ÚNICA** (só o mês). O read do ANO existia apenas para alimentar aquele gráfico e foi
eliminado junto, com `monthlyFlow` fora de `FinancialDashboardData`.

**Read do mês** traz UM embed de classificação — `chart_account → group/subgroup → type_group`
(+ `account_code`/`account_description`) —, espelhando os aliases/FKs do `SELECT_WITH_EMBEDS`, mais
o `chart_account_id`. 🔴 **O embed `cost_center` e a coluna `cost_center_id` SAÍRAM da leitura em
2026-08-15**, junto com o card "Ranking de centros de custo": eram a ÚNICA coisa que os lia nesta
tela — nem o escopo (`isExpenseRow`), nem os KPIs, nem os donuts, nem o ranking de contas, nem as
colunas do card de detalhe os consomem. Não reintroduzir "por precaução".

`ExpenseMonthRow` **não herda `MonthRow`**: faz `Pick` de `id`/`amount`/`status_id`/`due_date` +
`supplier(trade_name,legal_name)` + o embed de classificação (o `id`/`supplier` alimentam o card de
detalhe). Do subgrupo vêm a identidade/rótulo
(`chart_account_subgroup_id`/`subgroup_code`/`subgroup_description`, base do ranking de contas) e a
folha `type_group`. `ExpenseDetailRow` é o alias público de `ExpenseMonthRow`.

### Cards — layout (GRADE ÚNICA 3×2)

**6 cards numa grade só** (`grid-cols-1 sm:grid-cols-2 gap-2`) — 5 donuts `size="sm"` + `dense` e o
"Ranking de contas". Reorganização de 2026-08-15 (decisão do usuário); antes eram DUAS grades irmãs
(donuts, depois rankings), e um donut só divide a linha com o ranking estando na MESMA grade:

| Linha | Esquerda | Direita |
|---|---|---|
| 1 | Classificação Financeira | Custos de Mercadorias |
| 2 | Despesas Fixas | Custos de Importação |
| 3 | Despesas Variáveis | **Ranking de contas** |

A ordem VISUAL é a ordem do DOM (nenhuma classe `order-*`), então leitor de tela e ordem de
tabulação seguem o que se vê. Travado por teste que fixa as **6** headings `h3` na sequência — um
`.slice(0, 5)` continuaria verde com o ranking em qualquer posição.

🔴 **`sm:grid-cols-2`, não o `lg:` que a grade dos rankings usava.** O donut é o card de largura
CRÍTICA (anel de 124px + legenda com R$ que não quebra); a linha do ranking degrada truncando o
nome. Manter o `lg:` colapsaria os 5 donuts numa coluna só entre 640px e 1024px para proteger 1
card.

🔴 **`dense` TAMBÉM no card de ranking** (a prop já existia no `ChartCard`, default `false`): agora
ele é vizinho dos donuts na mesma grade, e os 2px de diferença de moldura (`p-3` × `p-2.5`)
apareceriam lado a lado.

🔴 **`self-start` SÓ no donut "Despesas Variáveis"** — o único que divide a linha com um card bem
mais alto (o ranking, até 12 linhas sem scroll próprio). No `stretch` (padrão do grid) a moldura
dele esticaria até a altura do ranking, deixando ~150px de BRANCO sob o anel — exatamente a altura
de viewport que a decisão "donuts compactos de propósito" existe para poupar. **Não** subir isso
para `items-start` no container: nas linhas 1 e 2 são dois donuts, e lá o `stretch` é o que mantém
as molduras da mesma altura com legendas de tamanhos diferentes.

⚠️ **A ordem NÃO espelha mais o `line_order` de `analytics.demonstrativo_despesas`** (1 Mercadorias,
2 Importação, 3 Fixas, 4 Variáveis): Fixas passou à frente de Importação a pedido do usuário. Não
"corrigir" de volta achando que é engano.

🔴 **O 5º donut ("Custos de Importação") foi acrescentado em 2026-08-14** — achado do mesmo dia em
que a função SQL `analytics.demonstrativo_despesas` ganhou a linha equivalente (migrations
127/128, ver `CLAUDE.md`): o tipo 9 do catálogo (`TYPE_GROUP_ID_CUSTO_IMPORTACAO`) já existia e
contava certo no TOTAL/KPIs (`isExpenseRow` olha a NATUREZA do grupo, não o Tipo do subgrupo),
mas a partição client-side (`apps/frontend-vite/src/services/supabase.ts`) não o reconhecia —
mesma classe de bug do CASE hardcoded da SQL, só que do lado TypeScript. O aceite foi
deliberadamente CONTIDO: paridade com o que a SQL já mostra (mais um donut nomeado), não um
layout dinâmico de N donuts — essa seria uma decisão de produto maior, não tomada.

Compactos DE PROPÓSITO (decisão do usuário 2026-07-22, revertendo o `size="lg"` de uma iteração
anterior no mesmo dia): poupar altura de viewport, já que o ranking não tem scroll próprio e mostra
até 12 linhas — donut menor = menos scroll até ver a lista inteira. *(A redação original dizia
"rankings ABAIXO"; desde a grade única de 2026-08-15 o ranking está AO LADO do último donut, mas a
razão — não gastar altura — continua valendo, e é ela que sustenta o `self-start` acima.)*

**Diâmetro do anel DINÂMICO, mas ÚNICO entre os 5 donuts** (`diameterPx` em
`BreakdownDonut`/`DonutCard`, prop opcional que SOBREPÕE o token de `size` via inline style —
nenhum outro call site usa). A página calcula `sumSliceValues`/`scaledDonutDiameter` (helpers
locais, não exportados) e usa o MAIOR total (R$) do conjunto (`maxDonutTotal`) para gerar **um único
`donutDiameter`** (`scaledDonutDiameter(maxDonutTotal, maxDonutTotal)`, que por ratio=1 sempre cai
no `DONUT_MAX_PX`=124), reaplicado IGUAL nos cinco.

**Correção da 1ª versão** (escalava CADA donut proporcionalmente ao seu PRÓPRIO total, entre
`DONUT_MIN_PX`=84 e `DONUT_MAX_PX`=124): com totais próximos entre si (ex.: Despesas Fixas R$ 340k
× Custos de Mercadorias R$ 324k) a diferença de diâmetro ficava em ~1px — visualmente incoerente,
nem proporcional de forma perceptível nem igual. `scaledDonutDiameter` continua genérico (aceita
`value` ≠ `maxValue` para usos futuros); a POLÍTICA "um valor só para todos" está no call site, não
na função. Inline style (não classe Tailwind) porque é um número CONTÍNUO computado do dado em
runtime — mesma exceção já adotada no gradiente cônico e nas barras do `RankingList`; o furo
acompanha a razão do preset "sm" (`DYNAMIC_HOLE_RATIO=0.11`). Sem `diameterPx` o componente se
comporta 100% como antes (token `size` fixo — vencimentos inalterado).

**Fonte do valor central SEM negrito** (`font-sans font-normal`, não mais `font-mono
font-semibold` — decisão do usuário 2026-07-22): o escopo é só o número dentro do furo
(`fmtMoneyCompact`); o `font-mono` da legenda (valor por fatia) e do `RankingList` NÃO mudou.

### Donuts — conteúdo

Na ordem do layout: **"Classificação Financeira"** (rótulo do card; Fixa/Variável/Custos de
Mercadorias/**Importação**, `tipoBreakdown` pela descrição do `type_group` do SUBGRUPO — do
catálogo, sem literal), **"Custos de Mercadorias"**, **"Despesas Fixas"**, **"Custos de
Importação"** e **"Despesas Variáveis"** — ver a ressalva sobre o `line_order` em "Cards —
layout" acima.

Os quatro últimos são por GRUPO (`group_description`), particionados pelo Tipo do subgrupo via
`type_group_id` 7/5/9/6:
`custoMercadoriasBreakdown`/`custoImportacaoBreakdown`/`despesaFixaBreakdown`/`despesaVariavelBreakdown`.
Conta com subgrupo não classificado **não entra em nenhum dos quatro** — sem balde residual, por
decisão de produto.

⚠️ **O título do 5º donut é hardcoded SINGULAR ("Custos de Importação"), mas o catálogo tem o
texto no PLURAL** (`financial_type_group.type_group_description = 'Custos de Importações'`,
medido no banco em 2026-08-14). Isso é uma pequena divergência COSMÉTICA, não um bug: a fatia
correspondente dentro do donut "Classificação Financeira" (que lê `tipoBreakdown` **direto do
catálogo**, sem override) mostra o texto real "Custos de Importações", enquanto o TÍTULO do donut
dedicado (string fixa no JSX, mesmo padrão dos outros três) usa o singular — a mesma classe de
acoplamento "hardcode segue o texto do catálogo no dia em que foi escrito" que já valia para
Custos de Mercadorias (ver bullet "Os rótulos de tipo vêm do CATÁLOGO" mais abaixo). O lado SQL
(`analytics.demonstrativo_despesas`, migration 128) tem um mecanismo de override
(`demonstrativo_line_label`) para justamente fixar o singular ali; o frontend não tem
equivalente — se isso incomodar visualmente, o ajuste é renomear a `type_group_description` no
catálogo (afeta os dois lados de uma vez) ou hardcodar um `override` de rótulo no `DonutCard`,
nenhum dos dois feito aqui.

O subtítulo do donut "Classificação Financeira" mostra **mês + KPI ativo** (ex.: `Julho - A
vencer`), via `KPI_FILTER_LABEL`; só o mês quando o filtro é `total`.

### Ranking

**UM ranking por VALOR (R$)** — por **subgrupo de plano de contas** (`subgroupRanking`, card
rotulado "Ranking de contas"), **top 12** (`RANKING_TOP_N`, aproveitando o espaço do gráfico
removido), via os helpers `rankBy` (agrega + desambigua rótulo) e `rankEntry` (monta a entrada /
corta o sentinela).

🔴 **O ranking de CENTROS DE CUSTO foi REMOVIDO em 2026-08-15** (decisão do usuário). Com ele
saíram `costCenterRanking`, o helper `ccKeyOf`, o alvo de drill `'costCenter'` e — porque nada mais
nesta tela os lia — a coluna `cost_center_id` e o embed `cost_center` da leitura.
⚠️ **Dois testes foram PORTADOS para o ranking de contas, não apagados**: o de **homônimos** (única
cobertura do desempate por rótulo repetido do `rankBy`, que segue vivo) e o do **sentinela id 0 com
e sem embed** (mais forte que o caso equivalente que já existia). Os outros dois — ordenação por
valor e `pct` — já tinham equivalente e saíram. Apagar os quatro deixaria regras vivas sem teste,
com a suíte verde: o modo de falha da Regra 2 do `CLAUDE.md`.

`rankBy` continua um helper genérico com um só chamador, de propósito: `pick` é o ponto de extensão
para uma dimensão nova, e é o que mantém a regra de agregação num lugar só.

**Célula da direita = % do total de contas do escopo, não a contagem crua** (pedido do usuário
2026-07-22 — só neste ranking): `rankBy` calcula `pct = count / fMonth.length * 100` para CADA
balde, inclusive os fora do top-12 exibido — o denominador é o total do escopo, não a soma dos 12
visíveis, então as % somam 100% entre TODOS os baldes, não necessariamente entre as linhas em tela.
O valor vai em `SupplierRank.pct` (campo opcional). O `RankingList` troca a célula automaticamente:
**com `pct`** mostra `Math.round(pct)%`; **sem `pct`** (ranking de fornecedores de
`/dashboard_vencimentos`, que não passa o campo) mantém `"N conta(s)"` — nenhuma mudança nesse outro
call site.

**Linhas mais compactas (`dense`, prop opt-in do `RankingList` — só aqui, não no de
fornecedores):** padding vertical e margem antes da barrinha reduzidos a 1px (`py-px`/`mb-px`, era
`py-0.5`/`mb-0.5`) — cabe mais das 12 linhas na mesma altura de card, sem remover informação (nome,
valor, badge, barra e %/contagem continuam todos presentes). **O badge de posição NÃO encolhe**
(`h-5 w-5` nos dois modos): a 1ª versão (`py-0`/`mb-0`, sem padding algum, + badge `h-4 w-4`) foi
revertida para esta intermediária a pedido do usuário (2026-07-22, "ficou muito compactado") — o
padding zerado ganhava pouca altura extra (a linha de texto+barra já domina a altura sobre o badge
nos dois casos) e o resultado ficou apertado demais.

🔴 **A agregação é pela IDENTIDADE (o id da FK), NUNCA pelo texto** (`rankEntry`/`rankBy`):
`financial_chart_of_account_subgroup` não tem UNIQUE em descrição — só a PK (o CRUD valida o
CÓDIGO, e só na aplicação) —, então agregar por texto fundiria dois cadastros homônimos numa linha
somada, **em silêncio**. O texto é só RÓTULO: agrega pelo **SUBGRUPO** do plano
(`chart_account_subgroup_id`) e mostra a descrição dele, com o **código prefixado apenas se dois
ids tiverem o mesmo rótulo**.

🔴 **O sentinela id 0 EXISTE no cadastro com descrição NULL**, logo o embed vem PREENCHIDO —
por isso `rankEntry` corta por `id > 0` **e** descrição não vazia; senão a linha apareceria como um
rótulo técnico (`#0`) em vez de cair no balde "não informado".

### Card de DETALHE (drill-down)

Clicar numa **fatia da legenda** de qualquer donut ou numa **linha** do ranking abre o
**`ExpenseDetailModal`** (modal centralizado `<dialog>`) com um `DataGrid` enxuto
(`getExpenseDetailColumns` — colunas **Fornecedor · Plano de conta · Vencimento · Valor ·
Situação**, Situação por último como badge read-only via `StatusBadge` + `STATUS_NAME_BY_ID`) das
contas daquele agregado, **ordenadas por VENCIMENTO ascendente** (mais próximas primeiro; sem
vencimento vai ao fim — decisão do usuário 2026-07-23, substituiu a ordem por valor desc; sort
estável, empate preserva a ordem original).

**Estratégia EM MEMÓRIA (sem leitura extra por clique):** o read do dashboard passou a trazer `id` +
`supplier`, e `getFinancialDashboardData` retorna **`detailRows`** (= `fMonth`, o MESMO conjunto que
gerou os gráficos); o clique filtra via **`filterExpenseDetailRows(rows, target)`** (puro/testável),
que reproduz EXATAMENTE o balde de cada gráfico → o detalhe é sempre subconjunto consistente do que
a fatia/linha contou, inclusive sob truncagem.

**Identidade do balde:** donuts casam pelo **rótulo** (`topBucketLabels` — a mesma seleção top-N que
o `breakdownBy` usa; a fatia "outros" = complemento do top-N; "não informado" = `pick(r) ?? 'não
informado'`). Os donuts por-grupo usam o alvo genérico **`chart:'grupoTipo'` + `typeGroupId`**
(5/6/7/9 — pré-filtra pelo Tipo do subgrupo antes do grupo; substituiu os antigos cases
`'fixa'`/`'variavel'`). O ranking casa pela **`SupplierRank.key`** (`sg:<id>`/`∅` — NUNCA o `name`,
homônimo/prefixável; `∅` = sentinela id 0 / sem descrição). O prefixo `cc:` e o alvo `'costCenter'`
saíram com o card de centros de custo.

🔴 **O top-N é por VALOR (R$), NUNCA por contagem de linhas** — bug real corrigido em 2026-07-22. O
donut exibe arco/%/ordem por valor, então a SELEÇÃO do top-N precisa usar o MESMO critério; senão um
grupo com POUCAS contas de valor ALTO (ex.: "Serviços Gerais": 2 contas, R$ 20 mil) perde para um
grupo com MUITAS contas de valor BAIXO (ex.: "Despesas com Utilidades": 5 contas, R$ 8 mil) e cai em
"outros" apesar de valer mais. Caso de origem: a conta da PANIFICADORA BELGA (R$ 20.100,80, grupo
"Serviços Gerais" / subgrupo "Copa e Cozinha") aparecia em "outros" do donut "Despesas Fixas" — e a
classificação estava correta, com a FK direta e a FK via subgrupo consistentes (verificado no
banco): não era erro de relacionamento, era só o critério errado.

**Acessibilidade — não regredir:** as fatias (`BreakdownDonut.onSelect`) e as linhas
(`RankingList.onSelect`) só viram `<button>` reais **quando o callback é passado**; os call sites do
`/dashboard_vencimentos` **não passam** e seguem não-interativos (travado por teste; evita o
SonarCloud S1082). `SupplierRank.key` virou **obrigatório** → o ranking de fornecedores do
vencimentos (map inline) grava `sup:<nome>`. O modal segue o padrão `<dialog>` + `showModal()` do
`/consulta` (Esc/foco/backdrop; fallback `el.open = true` no jsdom).

**Robustez (achados de code review — não regredir):**

- O `DataGrid` do modal liga **`enableRowVirtualization`**: um balde grande no escopo "Todas as
  contas" (cap 20.000) montaria milhares de `<tr>` e travaria a aba.
- O total e a ordenação do modal coagem `amount` por **`Number(x) || 0`** — o front NÃO roda Zod e
  `numeric` pode chegar como STRING; espelha o `num()` do serviço, senão o total concatenaria
  strings.
- `openDrill` **não abre com 0 linhas** (guarda contra `bucketKey` inválido) e `load` faz
  **`setDrill(null)`**, fechando o snapshot obsoleto em qualquer recarga (hoje defensivo, pois o
  `<dialog>` modal deixa os controles inertes).
- O case `'grupoTipo'` tem **guarda `typeGroupId == null → []`**: sem ela, `tipoOf(r) === undefined`
  CASARIA linha sem embed de subgrupo (`undefined === undefined`) e o ramo "outros" devolveria as
  não-classificadas. Travado por teste com fixture `subgroup: null`.
- O top-N do donut é a constante única **`DONUT_TOP_N = 6`** (acopla `breakdownBy` +
  `topBucketLabels`) — top-6 categorias + a fatia sintética "outros" (quando houver sobra) = **no
  máximo 7 linhas visíveis** por donut (decisão do usuário 2026-07-22: "outros" CONTA como um dos 7).
- Os rótulos de tipo vêm do CATÁLOGO (id 7 = **"Custos de Mercadorias"**, plural — fixtures e
  comentários alinhados ao texto real do banco). Exceção conhecida desde 2026-08-14: id 9 no
  banco é **"Custos de Importações"** (plural), mas o TÍTULO do donut dedicado é hardcoded
  **"Custos de Importação"** (singular) — ver o aviso em "Donuts — conteúdo" acima. Os testes
  (`financialDashboard.test.ts`, `supabaseDrill.test.ts`) usam o singular na própria fixture do
  `type_group_description`, então **não** reproduzem essa divergência — se um dia ela importar
  (ex.: um teste que compare texto do donut "Classificação Financeira" ao vivo), alinhar a
  fixture ao texto real (plural) primeiro.

**Limitação conhecida (pré-existente):** se um `group_description` REAL for literalmente
"outros"/"não informado" **e** estiver no top-N, o `breakdownBy` emite fatia duplicada e o detalhe
casaria só a real. O donut "Classificação Financeira" é seguro — vem do catálogo.

### Testes

`services/supabaseDrill.test.ts` (identidade do balde; describe "seleção é por VALOR…") ·
`ExpenseDetailModal.test.tsx` (+ `.a11y`) · `RankingList.test.tsx` (pct × contagem, `dense` ×
normal — trava `py-px`, não `py-0`) · `financialDashboard.test.ts` (pct sobre o total do escopo) ·
`DashboardFinanceiro.test.tsx` (integração — % renderizado + classe `py-px` nos dois cards) ·
extensões em `BreakdownDonut`.
