# Prompt de correção — Next API (CRUDs)

> Rodar na raiz do monorepo `pagamentos`, branch `Features`. Base: `docs/review/RELATORIO-CODE-REVIEW.md` §2.
> Aplica correções de contrato/Zod/lookup na camada `apps/api-backend`. NÃO mexer em produção fora do escopo.

```xml
<objetivo>
  Fechar os achados de contrato e escala da Next API sem regredir os CRUDs já corretos:
  (1) impedir que o lançamento manual de conta nasça em estado fechado; (2) corrigir o
  cap silencioso de 100 linhas nos lookups dual-mode de banks/groups/subgroups;
  (3) tornar o filtro de busca robusto a termo malformado (sem virar 500).
  Manter o gate verde (lint + typecheck + test + prune).
</objetivo>

<read_first>
  - CLAUDE.md (seções "CRUD de contas", "CRUDs dos demais cadastros contábeis", dual-mode)
  - packages/shared/src/schemas/financial-account-control.schema.ts
  - apps/api-backend/lib/contas.ts  (e app/api/contas/route.ts, app/api/contas/[id]/route.ts + *.test.ts)
  - apps/api-backend/lib/banks.ts             (+ app/api/banks/route.ts + *.test.ts)
  - apps/api-backend/lib/chart-account-groups.ts      (+ app/api/chart-account-groups/route.ts + *.test.ts)
  - apps/api-backend/lib/chart-account-subgroups.ts   (+ app/api/chart-account-subgroups/route.ts + *.test.ts)
  - apps/api-backend/lib/lookups.ts  (referência: MAX_LIMIT=1000 que NÃO sofre o cap)
  - apps/api-backend/lib/contas.ts (sanitizeTerm) + lib/suppliers.ts, lib/cost-centers.ts (mesma string or())
</read_first>

<achados>
  - MÉDIO  status definível no POST /api/contas — financial-account-control.schema.ts:238 (financialAccountControlCreateSchema) + lib/contas.ts:174.
            Um POST { sk_supplier, amount, status:'pago' } cria conta já fechada, furando o ciclo pendente/trigger.
  - MÉDIO  lookup cap de 100 — lib/banks.ts:104, lib/chart-account-groups.ts:101, lib/chart-account-subgroups.ts:116.
            A rota de lookup pede limit:1000 mas o service clampa MAX_LIMIT=100 → <select> trunca silenciosamente.
  - MÉDIO  500 em filtro de busca malformado — lib/contas.ts:79/100, lib/suppliers.ts:81, lib/cost-centers.ts:73 (string or() do PostgREST).
            sanitizeTerm já remove % , ( ) (não é injeção), mas token tipo-operador remanescente pode gerar filtro inválido → 500.
</achados>

<mudancas_exigidas>
  1. Schema de criação de conta:
     - Omitir `status` (e confirmar que `status_id` já é omitido) do `financialAccountControlCreateSchema`,
       de forma que o lançamento manual sempre nasça `pendente` (a trigger fn_set_status_from_due_date assume
       'a vencer'/'vencido'). NÃO alterar o schema base nem o de UPDATE (a edição de situação no grid/modal
       continua válida pelo PATCH com grant de coluna `status`).
     - Atualizar/expandir os testes co-locados para provar: POST com `status` no corpo → o campo é ignorado e a
       conta nasce `pendente` (ou 422 se preferirem rejeição explícita — decidir e documentar no PR).
  2. Cap de lookup:
     - Para o caminho de LOOKUP (sem `page`) de banks/groups/subgroups, devolver a lista completa para o <select>
       (alinhar o teto ao padrão de lib/lookups.ts: MAX_LIMIT=1000, OU introduzir um modo lookup que ignore o
       clamp de 100 do CRUD). NÃO mexer no caminho CRUD (`?page`) nem no clamp de 100 da paginação do CRUD.
     - Teste: lookup retorna > 100 itens quando o cadastro tem > 100 linhas (mockar o repo).
  3. Filtro de busca robusto:
     - Endurecer `sanitizeTerm` (ou o ponto de montagem da string or()) para que um termo residual não gere
       filtro PostgREST inválido — preferir resultado vazio limpo a 500. NÃO introduzir SQL cru; manter PostgREST.
     - Teste: termo "exótico" (ex.: contém `.` / operador-like) retorna lista vazia/normal, nunca 500.
</mudancas_exigidas>

<restricoes>
  - NÃO alterar dual-mode já correto (cost-centers, chart-accounts) nem a cascata centro→plano (lib/lookups.ts).
  - NÃO transformar soft-delete em hard nem vice-versa; os deletes por recurso estão corretos (CLAUDE.md).
  - NÃO expor service_role em caminho público; login/me seguem usando o cliente anon.
  - Falsos positivos (não "corrigir"): Zod sem .strict() que descarta chaves derivadas (aceitável);
    bank_id = max+1 (corrida aceita, baixíssima concorrência); 409-antes-de-404 no update de supplier (inalcançável).
</restricoes>

<validacao>
  - npm run lint
  - npm run typecheck
  - npm test
  - npm run prune
  - (Python intocado, mas confirmar) py -3 -m pytest tests/ -q
  - NÃO rodar npm run test:e2e neste ambiente.
</validacao>

<criterio_de_aceite>
  - Gate verde (0 erro / 0 warning).
  - POST /api/contas não cria conta em estado fechado por payload do cliente.
  - Lookups de banks/groups/subgroups retornam a lista completa para o <select>.
  - Busca com termo malformado não produz 500.
  - Nenhum CRUD previamente OK regrediu (testes co-locados continuam verdes).
</criterio_de_aceite>
```
