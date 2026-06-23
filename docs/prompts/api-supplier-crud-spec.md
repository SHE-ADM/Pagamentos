# Template de prompt — CRUD de `supplier` (apps/api-backend)

> Template de spec de entidade CRUD alinhado à arquitetura real do projeto Pagamentos
> (Repository → Service → Route via @supabase/supabase-js, soft delete, schema verificado nos
> migrants). Use como ponto de partida ao pedir o CRUD de `supplier`. Ver também
> `docs/prompts/api-users-auth-spec.md` (template de auth/usuários).

```xml
<context>
  Monorepo: C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos
  Target app: apps/api-backend (Next.js 16, porta 3000, TypeScript 6)
  Pattern: Route Handlers (app/api/**) + lib/ helpers (Repository → Service → Route)
  Envelope: { success, data?, error?, meta? } via lib/response.ts (ok/fail)
  Auth: middleware.ts JÁ protege /api/* (Bearer via requireAuth). Chamar requireAuth() também
        no handler é defesa em profundidade (e necessário para o teste de 401 a nível de rota).
  DB: Supabase + @supabase/supabase-js — service_role em lib/supabase-admin.ts (escrita ignora RLS)
  Schemas Zod 4: packages/shared/src/schemas/** (entidade de domínio → schema vai aqui)
  Testes: Vitest (environment node, mock de @supabase/supabase-js — ver lib/auth.test.ts)
  Convenções REST: CLAUDE.md §3
  REGRA DE PRESERVAÇÃO (CLAUDE.md "Limpeza / reset de dados" + memória cleanup-preserve-supplier):
    supplier é tabela de CADASTRO com curadoria manual (email/email2/email3/email4) — NUNCA
    truncar nem hard-delete em massa. A busca por fornecedor em /consulta resolve sk_supplier aqui.
</context>

<read_first>
  Ler ANTES de gerar código:
  - apps/api-backend/lib/response.ts / lib/auth.ts / lib/supabase-admin.ts / vitest.config.ts
  - apps/api-backend/app/api/emails/read/route.ts e route.test.ts — padrão de rota + teste
  - apps/api-backend/lib/auth.test.ts — padrão de mock do @supabase/supabase-js
  - packages/shared/src/schemas/financial-account-control.schema.ts — JÁ tem supplierEmbeddedSchema
    (trade_name/legal_name/cnpj/cpf) — reusar/estender em vez de redefinir
  - supabase/migrations/042_supplier_sk_surrogate_key.sql  — PK sk_supplier + trigger trg_supplier_mirror_id
  - supabase/migrations/011_supplier_identifier_constraint.sql — chk_supplier_has_identifier
  - supabase/migrations/028_supplier_multi_email_match.sql / 029_supplier_email_search.sql — emails + índices trgm
  - apps/frontend-vite/src/services/supabase.ts — findSupplierIdsByTerm (lógica de busca já existente)
</read_first>

<supplier_schema>
  Estado real da tabela supplier (introspecção 2026-06-23 + migrations — CONFIRMAR no Dashboard
  antes de assumir colunas de auditoria):

  CAMPO         TIPO        CONSTRAINTS
  sk_supplier   BIGINT      PK (surrogate, DEFAULT via sequence) — usar em TODAS as URLs
  supplier_id   BIGINT      NOT NULL UNIQUE (chave de negócio) — NÃO aceitar no body;
                            o trigger trg_supplier_mirror_id preenche = sk_supplier no INSERT
  legal_name    TEXT        nome jurídico
  trade_name    TEXT        nome fantasia
  cnpj          CHAR(14)    UNIQUE quando não nulo (14 dígitos, sem máscara)
  cpf           CHAR(11)    UNIQUE quando não nulo (11 dígitos, sem máscara)
  email/2/3/4   TEXT        e-mails (índices GIN trigram — migration 029)

  ATENÇÃO: supplier NÃO possui created_at, updated_at nem deleted_at (não aparecem em nenhuma
  migration de supplier; a introspecção do CLAUDE.md não os lista). NÃO incluir no tipo de leitura
  sem antes confirmar via information_schema/Dashboard.

  CONSTRAINT DE NEGÓCIO (011): chk_supplier_has_identifier — ao menos um de cnpj/cpf/legal_name/trade_name.
  RLS: policy só de SELECT para authenticated; escrita só via service_role (getSupabaseAdmin).
  FK REVERSA: financial_account_control.sk_supplier → supplier(sk_supplier) — nunca cascade delete.
</supplier_schema>

<task>
  Implementar CRUD de supplier em apps/api-backend (Repository → Service → Route), escrita via
  service_role. Não criar migration para a tabela (já existe) — EXCETO a decisão de DELETE abaixo.
</task>

<delete_policy>
  O template genérico pedia "soft delete" mas mandava hard-delete físico — contraditório e proibido:
  Sheild exige soft delete (deleted_at, never hard delete) e supplier é PRESERVADO por regra.
  Como supplier ainda não tem deleted_at, escolher UMA opção (recomendada: A):

  A) (recomendada) Criar migration 045_supplier_soft_delete.sql adicionando
     deleted_at TIMESTAMPTZ NULL; DELETE /api/suppliers/:sk faz UPDATE deleted_at = now();
     GET (lista e por sk) filtram deleted_at IS NULL. Antes de marcar, se houver contas em
     financial_account_control.sk_supplier → 409 (fornecedor em uso).
  B) (sem migration) NÃO expor DELETE — retornar 405/Not Implemented — e tratar baixa de
     fornecedor como curadoria manual. Hard-delete físico fica proibido em qualquer caso.
</delete_policy>

<endpoints>
  Todos exigem auth (requireAuth no início do handler). Escrita usa service_role.

  GET /api/suppliers
    query: page (default 1), limit (default 20, max 100), search (texto livre)
    search: ilike em legal_name/trade_name/cnpj/cpf/email/email2/email3/email4 (índices trgm)
    paginação: .range((page-1)*limit, page*limit-1) + count=exact para meta.total
    200: { success, data: Supplier[], meta: { total, page, limit } }

  GET /api/suppliers/:sk          — por sk_supplier  → 200 { data: Supplier } | 404
  POST /api/suppliers
    body: { legal_name?, trade_name?, cnpj?, cpf?, email?, email2?, email3?, email4? }
    validação Zod: ao menos um de legal_name/trade_name/cnpj/cpf (espelha 011);
                   cnpj/cpf — strip de máscara (\D → '') e exigir 14/11 dígitos resultantes
    NÃO aceitar sk_supplier/supplier_id no body (gerados pelo banco/trigger)
    201: { data: Supplier } · 409 (violação UNIQUE 23505 de cnpj/cpf) · 422 (Zod)
  PATCH /api/suppliers/:sk        — partial update (mesmos campos, todos opcionais)
    200 | 404 | 409 (cnpj/cpf de outro registro)
  DELETE /api/suppliers/:sk       — conforme <delete_policy> escolhida (A: soft + 409 se em uso)
</endpoints>

<types>
  Definir supplierSchema + Supplier em packages/shared/src/schemas/supplier.schema.ts
  (reaproveitar supplierEmbeddedSchema já existente). Tipo de leitura SEM created_at/updated_at
  até confirmação. supplierCreateSchema / supplierUpdateSchema (partial) para input.
  cnpj/cpf: string de dígitos (não number); sk_supplier/supplier_id: number (BIGINT).
</types>

<test_cases>
  suppliers.test.ts (mock de @supabase/supabase-js):
  - Repository: findAll (paginado+total), findAll com search, findBySk (achado/null),
    create, update, delete (bloqueia quando há contas vinculadas: count > 0 → 409)
  - Zod: POST sem identificador → erro; cnpj com máscara → strip e aceita; comprimento errado
    pós-strip → erro; PATCH sem body → aceita
  - Rotas (mock do SupplierService): GET sem auth → 401; GET :sk inexistente → 404;
    POST inválido → 422; POST cnpj duplicado → 409; DELETE com contas vinculadas → 409
</test_cases>

<constraints>
  - Envelope via ok()/fail(); requireAuth() no início de cada handler (retornar se não-null)
  - cnpj/cpf SEMPRE persistidos e retornados sem máscara (só dígitos)
  - sk_supplier: BIGINT → number (não string); nunca expor service_role; nunca logar token
  - 409 = violação UNIQUE do Postgres (code 23505) mapeada para mensagem leiga pt-BR
  - Sem NestJS/Express/Prisma/Drizzle — só Next Route Handlers + @supabase/supabase-js
  - Branch Features (não main); npm run lint/typecheck/test/prune com 0 erros
  - Exports órfãos → // ts-prune-ignore-next
</constraints>

<validation_commands>
  cd "C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos"
  npm run typecheck --workspace=apps/api-backend
  npm run lint --workspace=apps/api-backend
  npm run test --workspace=apps/api-backend
  npm run prune --workspace=apps/api-backend
</validation_commands>
```

## Por que este template diverge do template genérico

| Removido/alterado | Motivo |
|---|---|
| "Soft delete" + hard-delete físico (contraditório) | Hard delete viola "never hard delete" e a regra de preservação de `supplier`. Reescrito como `<delete_policy>`: soft via migration 045 (`deleted_at`) **ou** não expor DELETE. |
| `created_at`/`updated_at` "assumidos" | **Não existem** em `supplier` (confirmado nos migrants + introspecção). Removidos do tipo de leitura. |
| `supplier_id`/`sk_supplier` no body | Gerados pelo banco + trigger `trg_supplier_mirror_id` — não entram no POST. |
| Schema só em `lib/` | Entidade de domínio → schema em `packages/shared`; reusar `supplierEmbeddedSchema` e `findSupplierIdsByTerm`. |
| Auth só no handler | `middleware.ts` já protege `/api/*`; `requireAuth` no handler é defesa em profundidade. |
