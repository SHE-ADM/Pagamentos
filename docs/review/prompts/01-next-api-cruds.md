# Prompt de correção — Next API (CRUDs)

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem dos achados: `docs/review/RELATORIO-CODE-REVIEW.md` §2. Não altere decisões documentadas.

```xml
<objetivo>
  Corrigir defeitos de contrato REST e validação na Next API (api-backend): delete de grupo do plano de
  contas retornando 500 em vez de 409; users/route.ts vazando e.message em 500; mapeamento de FK (23503)
  faltando em contas; mensagem de obrigatoriedade inconsistente no schema de conta bancária; e o matcher do
  middleware sem âncora de segmento.
</objetivo>

<read_first>
  - apps/api-backend/lib/chart-account-groups.ts (REFERENCING_TABLES, remove, countReferences)
  - apps/api-backend/lib/chart-account-subgroups.ts (padrão mapWriteError 23503 — modelo a seguir)
  - apps/api-backend/lib/financial-accounts.ts:67-75 (padrão mapWriteError — modelo)
  - apps/api-backend/app/api/users/route.ts
  - apps/api-backend/lib/response.ts (failFromError)
  - apps/api-backend/lib/contas.ts (create/update, mapeamento de erro de banco)
  - packages/shared/src/schemas/financial-account.schema.ts
  - apps/api-backend/middleware.ts
  - CLAUDE.md:469-473 (§3 M-2), CLAUDE.md:338-340 (padrão .min(1))
</read_first>

<achados>
  - [MÉDIO] A1-1 — apps/api-backend/lib/chart-account-groups.ts:20 (loop :169-175): REFERENCING_TABLES só
    tem 'financial_chart_of_account_subgroup'; falta 'financial_chart_of_account' (FK direta
    chart_account_group_id, migration 058). Grupo referenciado direto por plano → 23503 → 500 em vez de 409.
  - [MÉDIO] A1-2 — apps/api-backend/app/api/users/route.ts:26: `fail(e.message, 500)` (antipadrão proibido).
  - [BAIXO] A1-3 — apps/api-backend/lib/contas.ts:191-195 e :210-215: sem mapa 23503 → FK vira 422 com
    mensagem crua do Postgres.
  - [BAIXO] A1-4 — packages/shared/src/schemas/financial-account.schema.ts:42-43: bank_id/payment_type_id
    `.min(0, '… é obrigatório')` — 0 passa na validação, mensagem nunca dispara.
  - [BAIXO] A1-5 — apps/api-backend/middleware.ts:19: matcher '/api/((?!health|auth/login).*)' casa por
    prefixo (latente). Cross-ref segurança S1.
</achados>

<mudancas_exigidas>
  1. A1-1: em chart-account-groups.ts, incluir 'financial_chart_of_account' em REFERENCING_TABLES (a coluna
     de FK chart_account_group_id já é o REF_COLUMN, countReferences funciona sem outra mudança). Confirmar
     que remove() devolve 409 (in-use) quando qualquer das duas tabelas referencia o grupo.
  2. A1-2: trocar o catch final de users/route.ts por `return failFromError(e, 'users');` e remover o import
     de UserServiceError se ficar sem uso.
  3. A1-3: adicionar em contas.ts um mapWriteError espelhando financial-accounts.ts (23505→409, 23503→422
     com mensagem curada: "Fornecedor/centro/plano/situação informado não existe"). Aplicar no create e no
     update.
  4. A1-4: decidir a semântica — se bank_id/payment_type_id são obrigatórios, usar `.min(1, '… é obrigatório')`
     (como status_id no mesmo arquivo); se opcionais (0 = não informado), remover o texto "é obrigatório" e
     manter `.min(0)`. Alinhar o form (FinancialAccountForm) à decisão (normalização NaN→0 já existe).
  5. A1-5: ancorar o matcher por fim de segmento, ex.: `'/api/(?!health$|auth/login$).*'` (validar que
     /api/health e /api/auth/login seguem públicos e todo o resto exige Bearer). Coordenar com o prompt de
     segurança S1 (mesma linha).
</mudancas_exigidas>

<restricoes>
  - NÃO reintroduzir `fail(e.message, 500)` em nenhum handler (§3 M-2).
  - NÃO transformar o "código único" app-level em UNIQUE de banco — a race é documentada e aceita.
  - NÃO mexer no soft vs hard delete nem em "contas sem DELETE" — escopo documentado.
  - Preservar o dual-mode dos lookups (sem page = lookup intocado) e o sentinela id 0.
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - npm run prune
  - Teste manual: DELETE de um grupo referenciado só por plano de contas (sem subgrupo) → 409; PATCH de conta
    com status_id inexistente → 422 curado; POST /api/users com env ausente → 500 genérico (sem e.message).
</validacao>

<criterio_de_aceite>
  Gate verde (lint/typecheck/test/prune). Delete de grupo em uso retorna 409 "Grupo em uso" (não 500).
  users/route.ts não vaza detalhe interno. contas mapeia 23503→422 curado. Mensagem de obrigatoriedade do
  schema coerente com o comportamento. Matcher do middleware casa rota exata.
</criterio_de_aceite>
```
