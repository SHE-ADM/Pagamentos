# Prompt de correção — Frontend (grid, forms, requisições, React Compiler)

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md` §3.
> Escopo: `apps/frontend-vite`. Reduzir requisições desnecessárias, remover duplicação e memoização manual redundante.

```xml
<objetivo>
  Eliminar desperdício de requisições e dívida de manutenção no frontend sem mudar comportamento visível:
  (1) colapsar o N+1 de getEmailStats; (2) paralelizar getDashboardData; (3) extrair os formatters duplicados;
  (4) remover useMemo manuais redundantes com o React Compiler (com teste). Manter o gate verde.
</objetivo>

<read_first>
  - CLAUDE.md (seções DataGrid, "Frontend — rotas e serviços", React Compiler)
  - apps/frontend-vite/src/services/supabase.ts  (getEmailStats:168, getFinancialStats:493, getDashboardData:598-606, getProcessingErrorStats:431 como referência de contagem por status)
  - apps/frontend-vite/src/pages/Emails.tsx       (load + getInvoiceNumbersByMessageIds:136-144)
  - apps/frontend-vite/src/pages/Consulta.tsx     (formatters:40-56, useMemo colunas:349-352)
  - apps/frontend-vite/src/hooks/useGridColumns.ts (formatters duplicados:47-71, fmtDateTime:74)
  - apps/frontend-vite/src/components/organisms/DataGrid.tsx (useMemo:322-389, loadMore:636-639)
  - apps/frontend-vite/vite.config.ts (React Compiler transform ativo:18)
</read_first>

<achados>
  - MÉDIO  getEmailStats dispara 8 requests por refresh — services/supabase.ts:168-189 (1 total + 6 por status, x cada load/poll).
  - MÉDIO  getDashboardData com awaits sequenciais independentes — services/supabase.ts:598,606.
  - MÉDIO  KPIs com limit:1000/2000 para contar no cliente (subnotifica ao escalar) — services/supabase.ts:493,168.
  - MÉDIO  Formatters duplicados entre Consulta.tsx:40-56 e useGridColumns.ts:47-71 (+ fmtDateTime vs Emails.tsx:18-27) — risco de drift.
  - MÉDIO  useMemo manuais redundantes com o compiler — Consulta.tsx:349, Emails.tsx:322, DataGrid.tsx:322-389.
  - BAIXO  Emails refaz o lote de invoice por message_id a cada [rows] — Emails.tsx:136-144 (sem cache por id).
  - BAIXO  loadMore por índice de item virtual (inclui second/detail) — DataGrid.tsx:636-639 (guarda já cobre duplo-fire).
</achados>

<mudancas_exigidas>
  1. getEmailStats: substituir as 7 requisições por 1 `select=status` (limit alto/cabeçalho count) e contar por status
     no cliente — espelhar o padrão de getProcessingErrorStats (supabase.ts:431). Manter a mesma forma de retorno.
  2. getDashboardData: trocar os dois `await` sequenciais por `Promise.all([monthRows, yearRows])`.
  3. KPIs por contagem: onde for "contar", usar `Prefer: count=exact` + Content-Range (já usado nas listagens) em vez de
     puxar limit:1000/2000 — getFinancialStats e getEmailStats. NÃO mudar os números exibidos.
  4. Formatters: extrair fmtDate/fmtMoney/fmtCnpj/fmtCostCenter/fmtChartAccount/fmtDateTime para um único módulo em
     src/lib (ex.: src/lib/format.ts) e importar em Consulta.tsx, useGridColumns.ts e Emails.tsx. Remover as cópias.
  5. useMemo redundantes: remover os useMemo manuais que o compiler memoiza — Consulta.tsx:349, Emails.tsx:322.
     Em DataGrid.tsx, AVALIAR caso a caso: os memos que alimentam useReactTable (lib com bail-out do compiler) podem ser
     defensivos — só remover os que comprovadamente não dependem do TanStack, sempre com teste verde. Documentar no PR
     quais foram mantidos e por quê.
  6. (BAIXO, opcional) Emails: cachear invoice por message_id já visto para evitar refazer o lote inteiro a cada refresh.
</mudancas_exigidas>

<restricoes>
  - NÃO remover `void load()` dos effects de fetch-on-change nem os eslint-disable justificados (CLAUDE.md).
  - NÃO mexer no debounce form-vs-applied, na virtualização spacer-row, no auto-heal do scrollRect, nem no `__select__`
    fora das prefs — estão corretos.
  - NÃO introduzir useCallback/useMemo/React.memo NOVOS (compiler ativo).
  - Falsos positivos: prefillNonce do ContaForm (necessário), gridId/STORAGE_VERSION (corretos), loadMore-index (robusto).
</restricoes>

<validacao>
  - npm run lint
  - npm run typecheck
  - npm test
  - npm run prune
  - NÃO rodar npm run test:e2e neste ambiente.
</validacao>

<criterio_de_aceite>
  - Gate verde.
  - /emails faz 1 request de stats (não 8); Dashboard carrega month+year em paralelo.
  - Formatters existem em um único lugar (src/lib); sem cópias em Consulta/useGridColumns/Emails.
  - useMemo manuais removidos onde seguro, sem regressão de render (testes do grid/forms verdes).
  - Nenhuma mudança visual nos KPIs/colunas.
</criterio_de_aceite>
```
