# Code Review — KPIs e filtros de `/consulta` (2026-08-08)

## Resumo

**Alvo:** KPIs e filtros de `/consulta` (relato do usuário: "Total de registros" não muda com o período)
**Modo:** light (sem passo de ataque, sem verificação adversarial)
**Escopo:** `pages/Consulta.tsx` (cards, portão de filtros) · `services/supabase.ts`
(`applyFinancialFilters`, `getFinancialStats`, `getFinancialAccountTotalValue`, `getFinancialAccountCount`)
**Régua:** `CLAUDE.md` § "/consulta", § "Roadmap · Onda 3 (paginação)" · comentários do próprio código
**Verificação:** consultas SQL no banco de produção + sonda HTTP contra o PostgREST (leitura apenas)

O relato está certo, mas por um motivo diferente do suposto. **A parte "Todas e 2026 dão o mesmo
valor" NÃO é defeito** — é o dado: as **742** contas não-canceladas têm vencimento em 2026
(medido: `ano_2026 = 742 = nao_cancelado`), então filtrar o ano 2026 é de fato equivalente a não
filtrar. O defeito real é outro e está no primeiro card: **a contagem é global enquanto o valor ao
lado é filtrado**. E, ao investigar, apareceu um segundo problema mais grave, que ainda não dá
sintoma: os KPIs vão truncar silenciosamente em ~12 dias.

---

## Achados

### 🔴 Bloqueantes

- **[apps/frontend-vite/src/pages/Consulta.tsx:942]** O card "Total de registros" mistura duas
  populações: contagem **global**, valor **filtrado**.
  **Falha:** com "Ago/2026" a tela mostra `R$ 3.766.725,46 / 742 conta(s)`. Medido no banco: agosto
  de 2026 tem **211** contas somando exatamente **R$ 3.766.725,46** — o valor está certo, a
  contagem não. Os 742 são o total global não-cancelado (784 − 42 canceladas), que é o que
  `getFinancialStats()` devolve. O usuário lê "742 contas somam R$ 3,7 mi" e a média por conta sai
  ~3,5× menor que a real.
  **Evidência:** `value: stats.totalRecords ?? 0` (global) na linha 942 × `amount: filteredValue ??
  stats.totalValue` (filtrado) na 944. SQL: `nao_cancelado = 742` · `ago_2026 = 211 contas /
  R$ 3.766.725,46` · `valor_todas = R$ 11.323.335,00` (= o que a tela mostra em "Todas").
  **Correção:** usar o `filteredCount` que **já existe** — `Consulta.tsx:354`, alimentado por
  `getFinancialAccountCount(applied)` e já exibido no **rodapé da mesma página** (linha 1650). Hoje
  a página mostra dois números diferentes sob o mesmo nome.
  **Regra:** `CLAUDE.md` — *"alcança o grid **e** os cards 'Valor total'/'Total de registros' (que
  recebem os mesmos filtros)"*; e o comentário de `getFinancialAccountCount`
  (`supabase.ts:760-764`): *"alimenta o 'Total de registros' de /consulta"*. A intenção estava
  escrita nos dois lugares; só não foi ligada.

- **[apps/frontend-vite/src/services/supabase.ts:891 e :751]** Os KPIs truncam no teto de 1.000 do
  PostgREST **sem erro** — e o `limit: 10000` do "Valor total" é ignorado pelo servidor.
  **Falha:** `getFinancialStats` busca as linhas (`limit: 1000`) e conta/soma **no cliente**
  (`totalRecords: all.length`). Passando de 1.000 contas não-canceladas, os **cinco** cards passam a
  reportar menos do que existe, com HTTP 200 e nenhum sinal. `getFinancialAccountTotalValue` pede
  `limit: 10000`, o que dá falsa sensação de folga: o servidor corta em 1.000 do mesmo jeito.
  **Evidência:** sonda HTTP nesta instalação, contra `email_control` (1.303 linhas):
  `limit=1000 → 1000` · `limit=5000 → 1000` · `limit=10000 → 1000`, **sempre HTTP 200**.
  Situação atual: **742** não-canceladas; ritmo medido de criação **~22 contas/dia** (220 em 10
  dias) → o teto é atingido em **~12 dias**.
  **Correção:** contagem por `count=exact` + `Content-Range` (é o que `getFinancialAccountCount` já
  faz corretamente, sem trafegar linhas) e somas por agregação no servidor ou paginação explícita.
  **Regra:** `CLAUDE.md` § Onda 3 — *"CONSULTA REST CUJO RESULTADO VIRA DADO GRAVADO — OU DECIDE
  APAGAR — PRECISA PAGINAR. O Supabase corta a resposta no 'Max rows' (1.000) e devolve HTTP 200:
  sem erro, sem exceção, sem sinal."* A lição foi registrada para os scripts Python; o frontend
  ficou com o mesmo padrão não corrigido.

### 🟡 Recomendados

- **[apps/frontend-vite/src/pages/Consulta.tsx:974]** O card "A vencer em 7 dias" **conta** uma
  coisa e **filtra** outra ao ser clicado.
  **Falha:** o número vem de `status_id = 'a vencer'` **E** vencimento na janela de 7 dias
  (`supabase.ts:900`); o clique aplica só o intervalo de datas (`next7DaysRange()`), e como
  `BASE_FILTERS.statusId = undefined` o grid volta com **qualquer** situação não-cancelada. Clicar
  num card que diz 68 traz 69 linhas. A divergência cresce com a operação normal — é exatamente a
  contagem de contas **já pagas** cujo vencimento cai na janela.
  **Evidência:** SQL — `status_id=3` na janela = **68** (o que o card mostra); `status_id<>9` na
  janela = **69**; já pagas na janela = **1**.
  **Correção:** o override do clique também fixar `statusId: STATUS_ID_A_VENCER`.

- **[apps/frontend-vite/src/services/supabase.ts:895 e pages/Consulta.tsx:84]** Os KPIs de data
  usam **UTC**; o resto da página usa data **local**.
  **Falha:** `getFinancialStats` (`today.toISOString()`) e `next7DaysRange()` derivam "hoje" em UTC,
  enquanto `initialFilters()` usa `getMonth()/getFullYear()` (local) e o projeto já estabeleceu
  `todayISO()` (local) como base correta em `lib/format.ts`, com o motivo escrito lá. Em UTC−3, das
  21:00 à meia-noite o "hoje" já é o dia seguinte: a janela de 7 dias passa a excluir o que vence
  hoje e a incluir um dia a mais, e o KPI diverge do grid.
  **Correção:** derivar as duas de `todayISO()`, a fonte única que já existe.
  **Regra:** `CLAUDE.md` § `lib/format.ts` — *"`todayISO` … pela data **LOCAL**, não UTC: à noite o
  UTC já está no dia seguinte e a data 'voltaria um dia'"*.

### 🔵 Opcionais

- [pages/Consulta.tsx:938] O array `cards` é remontado a cada render com 5 literais que só diferem
  em ícone/rótulo/tom/filtro — candidato natural ao mesmo padrão de tabela que
  `components/dashboard/KpiRow.tsx` já usa nos dois dashboards.

---

## Estrutura dos filtros — avaliação

`applyFinancialFilters` está **sólida** e é a parte mais bem defendida deste caminho. Confirmei, sem
achar defeito: os dois ramos de data mutuamente exclusivos com colunas independentes (`rangeCol` ×
`periodCol`); o `!inner` promovido só quando há filtro de classificação; o `eq.` sem aspas; o
`status_id` explícito sobrepondo o `neq.cancelado`; e o repasse do objeto inteiro de filtros (em vez
de remontar um literal campo a campo), que é o que impede um filtro novo de ser descartado em
silêncio. Os comentários explicam o **porquê** e citam a medição — é o padrão que o resto do
projeto deveria seguir.

**A assimetria não está no filtro, está no consumo:** três consultas recebem os filtros (grid, valor
total, contagem) e uma quarta — `getFinancialStats` — não recebe nenhum, por design. O card 1 tem um
pé em cada, e é isso que produz o sintoma relatado.

---

## Não coberto

- **Decisão de produto pendente** (ver abaixo): se os cards 2–5 devem passar a seguir o filtro. Ela
  muda qual é a correção certa do card 1, por isso nenhuma alteração de código foi aplicada neste
  review.
- **Não medi o custo** de fazer `getFinancialStats` aceitar filtros (5 agregados por consulta) —
  seria necessário antes de escolher a opção B.
- **Testes de KPI:** não há caso cobrindo a coerência "número do card × filtro que ele aplica"; os
  achados 🔴 B1 e 🟡 R1 sobreviveriam a toda a suíte atual.
- **Sonda HTTP** feita com a `service_role` (a `anon` devolve 0 por RLS `TO authenticated`); é
  leitura apenas, de `id`, e o teto de 1.000 é do PostgREST, independente do papel.

---

## Correções aplicadas

**Decisão do dono do produto:** os **5 cards passam a seguir o filtro**. Isso torna
`getFinancialStats` filtrado — e, como ele precisava ser reescrito de qualquer forma, o
truncamento silencioso foi resolvido no mesmo movimento.

| # | Achado | Desfecho | Observação |
|---|---|---|---|
| B1 | Card "Total de registros": contagem global sob valor filtrado | ✅ corrigido | `Consulta.tsx` — contagem e valor saem da MESMA consulta (`stats`); o rodapé passou a ler a mesma fonte, então a página deixa de exibir dois números sob o mesmo nome |
| B2 | Teto de 1.000 truncando os KPIs em silêncio (~12 dias de prazo) | ✅ corrigido | `getFinancialStats` pagina (`limit`+`offset` com `order=id.asc`) e levanta se não convergir em 200 páginas. `limit: 10000` era ignorado pelo servidor |
| R1 | "A vencer em 7 dias" contava um predicado e filtrava outro (68 × 69) | ✅ corrigido | `next7DaysRange()` passou a fixar `statusId: STATUS_ID_A_VENCER` |
| R2 | KPIs em UTC × resto da página em local | ✅ corrigido | `isoDaysFromToday()` em `lib/format.ts` (fonte única, `todayISO` virou `isoDaysFromToday(0)`); consumido pelo serviço e pelo card |
| — | Opcional: tabela para os 5 cards, no molde do `KpiRow` | ⏸️ adiado | Opcionais não entram na correção automática |

**Simplificação que veio junto:** `getFinancialAccountTotalValue` e `getFinancialAccountCount`
foram **removidas** — com `getFinancialStats(filters)` devolvendo contagem e soma já filtradas,
elas produziriam os mesmos números por mais duas consultas a cada apply. Era exatamente dessa
divisão que nascia o defeito. Resultado líquido: **uma requisição a menos** por mudança de filtro,
e uma fonte só para números que precisam concordar.

**Verificação end-to-end** — requisição HTTP idêntica à que o app passará a emitir, comparada com
SQL no mesmo instante:

| | SQL | REST do app |
|---|---|---|
| Ago/2026 | 214 contas · R$ 3.810.733,46 | 214 contas · R$ 3.810.733,46 |
| A vencer em 7 dias | 71 | 71 |

⚠️ Os números desta seção são **maiores** que os do diagnóstico acima (211 / R$ 3.766.725,46 / 68)
porque o banco mudou durante a sessão: **784 → 787 contas**, 3 criadas às 16:21 UTC. As duas
consultas foram então re-medidas **no mesmo instante** para provar equivalência — a divergência era
do relógio, não do código. Toda contagem citada neste documento é um retrato, não uma constante.

**Gates:** `frontend-vite 847 (+7)` · `pytest 1146` · `lint 0/0` (monorepo) · `typecheck` limpo ·
`ts-prune 0 órfãos`
**Baseline:** `frontend-vite 840` · `pytest 1146` · `lint 0/0`

**Validação por mutante** (isolados, revertidos com confirmação): remover a paginação de
`getFinancialStats` → vermelho; card voltar à contagem global → vermelho; clique de 7 dias sem
`statusId` → vermelho.

**Achado do próprio fix, corrigido em 2ª rodada:** a guarda de resposta obsoleta foi escrita
primeiro como um `useRef` de geração (padrão do `requestSeq` do grid) e **quebrou o lint** com
`react-hooks/refs` — o ref era lido dentro de `refreshStats`, que entra na cadeia
`handleStatusChange → getConsultaColumns` montada no render. É a mesma armadilha que o `CLAUDE.md`
já registra para o `pendingApply` ("é estado, não ref"). Refeita como flag `cancelled` no efeito.

**Nada foi commitado.**
