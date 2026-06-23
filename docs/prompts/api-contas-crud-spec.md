# Template de prompt — CRUD de contas (`financial_account_control`) + UI

> Template alinhado ao schema REAL da tabela de contas a pagar (`financial-account-control.schema.ts`),
> reaproveitando o CRUD de fornecedor (`lib/suppliers.ts` + `app/api/suppliers/**` + `SuppliersPage.tsx`).
> Cobre o backend (Next API) e os requisitos de UI: página de inclusão rápida, edição em `/consulta`,
> react-select para fornecedor e selects só-de-enum para tipo de documento/pagamento. Ver também
> `docs/prompts/api-supplier-crud-spec.md`.

```xml
<context>
  Monorepo: C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos
  Backend alvo: apps/api-backend (Next.js 16, :3000, TS) — camada de dados/CRUD.
  Frontend alvo: apps/frontend-vite (React 19/Vite, :5173) — app interno.
  Pattern backend: Route Handlers (app/api/**) + lib/ (Repository → Service → Route).
  Envelope: { success, data?, error?, meta? } via lib/response.ts (ok/fail).
  Auth: middleware.ts protege /api/* (Bearer via requireAuth); requireAuth() também no handler
        (defesa em profundidade + teste de 401 a nível de rota).
  DB: Supabase + @supabase/supabase-js — service_role em lib/supabase-admin.ts (escrita ignora RLS).
  O FRONTEND JÁ consome a Next API via proxy `/data-api` → :3000 (ver services/suppliers.ts).
  Schemas Zod 4: packages/shared/src/schemas/** — fonte única de tipos.
  REGRA DE PRESERVAÇÃO (CLAUDE.md "Limpeza / reset de dados"): financial_account_control é a
    tabela PRINCIPAL de contas a pagar — NUNCA hard-delete. "Remoção" = status 'cancelado'.

  >> REUSE: o CRUD de FORNECEDOR recém-criado é o template exato. Espelhe:
     - lib/suppliers.ts (Repository+Service+SupplierServiceError) e app/api/suppliers/** (rotas)
     - services/suppliers.ts (cliente Next API com token Supabase) e pages/SuppliersPage.tsx (página)
     Reaproveite a estrutura; só troque a entidade para "conta" (financial_account_control).
</context>

<read_first>
  - apps/api-backend/lib/response.ts / lib/auth.ts / lib/supabase-admin.ts / vitest.config.ts
  - apps/api-backend/lib/suppliers.ts + app/api/suppliers/route.ts + app/api/suppliers/[sk]/route.ts (+ testes) — TEMPLATE do CRUD
  - apps/api-backend/lib/auth.test.ts — padrão de mock do @supabase/supabase-js
  - packages/shared/src/schemas/financial-account-control.schema.ts — JÁ tem financialAccountControlSchema,
    financialAccountControlInputSchema, financialAccountControlCreateSchema, supplierEmbeddedSchema e os enums
    DOCUMENT_TYPES / PAYMENT_METHODS / ACCOUNT_STATUSES. REUSAR, não redefinir.
  - supabase/migrations/018 (criação), 034 (fusão de status), 035 (dimensão status + status_id),
    033/036 (grants de coluna p/ authenticated: has_invoice/has_bank_slip e status) — contexto de RLS/trigger.
  - apps/frontend-vite/src/services/supabase.ts — getFinancialAccountControl, setFinancialAccountStatus,
    setFinancialAccountFlag, findSupplierIdsByTerm (reaproveitar p/ leitura/busca)
  - apps/frontend-vite/src/services/suppliers.ts — cliente Next API (criar o equivalente p/ contas)
  - apps/frontend-vite/src/pages/Consulta.tsx + hooks/useGridColumns.ts (getConsultaColumns) — onde entra o botão "editar"
  - apps/frontend-vite/src/components/atoms/StatusSelectCell.tsx — dropdown inline de status existente
  - apps/frontend-vite/src/pages/SuppliersPage.tsx + components/organisms/SupplierForm.tsx — TEMPLATE de página + form
  - apps/frontend-vite/src/components/Layout.tsx — item de sidebar "Cadastro de contas" (hoje <span> "breve")
  - apps/api-backend/middleware.ts — matcher /api/* (a rota nova já fica protegida)
</read_first>

<financial_account_control_schema>
  Schema REAL (ver financial-account-control.schema.ts — confirmar no Dashboard se necessário):

  CHAVE/IDENTIDADE
    id            BIGINT  PK (gerado) — usar nas URLs (/api/contas/:id). NÃO é sk_*.
    sk_supplier   BIGINT  NOT NULL  FK → supplier(sk_supplier). Fornecedor é OBRIGATÓRIO.

  CLASSIFICAÇÃO (enums do schema compartilhado — entrada OBRIGATÓRIA pré-definida)
    document_type   ∈ DOCUMENT_TYPES (boleto, pix, das, fatura, nfe, container, conta de luz, …)
    payment_method  ∈ PAYMENT_METHODS (boleto, pix, ted, cartão, …)
    extraction_source ∈ (email_body, pdf_text, pdf_vision, falha)  — na criação manual: NÃO expor

  DOCUMENTO / FINANCEIRO
    invoice_number, competence_date(YYYY-MM), issue_date, due_date  (datas ISO)
    amount NUMERIC(15,2) — na CRIAÇÃO manual é OBRIGATÓRIO e > 0 (financialAccountControlCreateSchema)
    currency('BRL'), barcode, description, nosso_numero
    discount/other_deductions/fine_interest/other_additions/amount_charged (default 0)

  SITUAÇÃO (NÃO enviar no create; trigger cuida)
    status ∈ ACCOUNT_STATUSES (default 'pendente'); a trigger fn_set_status_from_due_date grava
      'a vencer'/'vencido' a partir de due_date quando o status está em aberto. status_id é resolvido
      pela trigger a partir de status — NÃO aceitar status_id no body.

  CURADORIA / PAGADOR / AUDITORIA
    has_invoice/has_bank_slip (bool, default false), company_id (auto pela trigger), payer_cnpj, payer_name,
    sender_email, subject, email_body_excerpt, processing_notes, extracted_at,
    created_at/updated_at (EXISTEM; updated_at via trigger) — NÃO aceitar no body.

  NÃO aceitar no body (gerados/derivados): id, status_id, company_id, created_at, updated_at, currency(default).
  Fornecedor para exibição vem do JOIN: select '*,supplier(trade_name,legal_name,cnpj,cpf)'.
  RLS: SELECT TO authenticated; escrita TO service_role (CRUD via Next API). Exceções de coluna p/
  authenticated já existem (has_invoice/has_bank_slip migration 033; status migration 036).
</financial_account_control_schema>

<task>
  1) Backend: CRUD de contas em apps/api-backend (Next API), espelhando o CRUD de fornecedor.
  2) Frontend: página de INCLUSÃO RÁPIDA de contas + EDIÇÃO da conta a partir de /consulta.
  Escrita via service_role na Next API. Reaproveitar schemas de @sheild/shared. NÃO criar migration nova.
</task>

<delete_policy>
  SEM hard-delete e SEM botão de exclusão na UI (decisão do usuário + regra de preservação).
  "Remover" uma conta = PATCH status='cancelado' (valor já existente em ACCOUNT_STATUSES; /consulta
  já oculta 'cancelado' por padrão). NÃO criar coluna deleted_at nem rota DELETE física.
</delete_policy>

<backend_endpoints>
  Recurso: /api/contas (envelope ok/fail; requireAuth no início; escrita service_role).
  GET  /api/contas            — page(1)/limit(20,max100)/search; JOIN supplier(...); count=exact → meta.total
                                search: por fornecedor (resolver sk_supplier via supplier) + invoice_number/subject/sender_email
                                por padrão status != 'cancelado'
  GET  /api/contas/:id        — por id → 200 { data } | 404
  POST /api/contas            — body = financialAccountControlCreateSchema (sk_supplier obrigatório, amount>0,
                                document_type/payment_method dos enums). 201 | 422(Zod) | 409(UNIQUE 23505)
  PATCH /api/contas/:id       — partial (financialAccountControlInputSchema.partial()); permite status='cancelado'.
                                200 | 404 | 422
  (sem DELETE — ver <delete_policy>)
  lib/contas.ts: ContaRepository + ContaService + ContaServiceError (espelhar lib/suppliers.ts).
</backend_endpoints>

<frontend_ui>
  A) PÁGINA DE INCLUSÃO RÁPIDA "Cadastro de contas"
     - Nova rota lazy (/contas) em App.tsx; promover o item "Cadastro de contas" do sidebar
       (Layout.tsx) de <span "breve"> para <NavLink>, REMOVENDO o badge "breve".
     - Form enxuto (organism, react-hook-form + zodResolver(financialAccountControlCreateSchema)),
       reusando services/contas.ts (cliente Next API novo, espelha services/suppliers.ts).
     - FORNECEDOR via REACT-SELECT (search assíncrono): busca fornecedores existentes (GET /api/suppliers?search=)
       e PERMITE INCLUIR novo fornecedor inline (creatable → POST /api/suppliers, usa o sk_supplier retornado).
       (react-select é dependência NOVA — `npm i react-select`; AsyncCreatableSelect estilizado com classNames Tailwind.)
     - document_type e payment_method: SELECTS de APENAS CONSULTA — usuário OBRIGADO a escolher um valor
       PRÉ-DEFINIDO dos enums (DOCUMENT_TYPES / PAYMENT_METHODS de @sheild/shared). Sem texto livre/criação.
     - status NÃO aparece no form de criação (default 'pendente'; trigger ajusta por due_date).
  B) EDIÇÃO A PARTIR DE /consulta
     - Botão "editar conta" (no painel de detalhe ou coluna de ação) que abre o mesmo form em modo edição
       (PATCH /api/contas/:id). Mesmas regras (react-select; enums). SEM botão de exclusão.
  Acessibilidade (WCAG AA) + Atomic Design + Tailwind; todo componente novo com teste (Vitest) e a11y (jest-axe).
</frontend_ui>

<types>
  Reusar de @sheild/shared: financialAccountControlSchema (leitura), financialAccountControlInputSchema
  (entrada; .partial() para o PATCH) e financialAccountControlCreateSchema (POST; já exige amount>0).
  NÃO redefinir. Tipo de leitura inclui created_at/updated_at e o recurso embutido supplier.
</types>

<test_cases>
  Backend (lib/contas.test.ts + rotas, mock de @supabase/supabase-js como em lib/auth.test.ts):
  - Repository: findAll (paginado+total, com/sem search), findById (achado/null), create, update.
  - Zod: POST sem sk_supplier → erro; amount<=0 → erro; document_type fora do enum → erro; PATCH {} → ok.
  - Rotas: GET sem auth → 401; GET :id inexistente → 404; POST inválido → 422; PATCH cancelar → 200.
  Frontend: ContaForm (render + validação + submit) + a11y; página de cadastro (render + abre form) + a11y;
  services/contas (envelope/token/erro); ação de edição em /consulta.
</test_cases>

<constraints>
  - Envelope ok()/fail(); requireAuth() no início de cada handler.
  - amount sempre NUMERIC(15,2); document_type/payment_method SEMPRE de enum (sem valor livre).
  - id/sk_supplier: number (BIGINT). Nunca expor service_role; nunca logar token.
  - 409 = violação UNIQUE (23505) mapeada p/ mensagem leiga pt-BR.
  - Sem NestJS/Express/Prisma/Drizzle; sem hard-delete; sem migration nova.
  - Branch a partir de Features (não main); npm run lint/typecheck/test/prune com 0 erros nos workspaces tocados.
  - Exports órfãos → // ts-prune-ignore-next.
</constraints>

<validation_commands>
  cd "C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos"
  npm run typecheck && npm run lint && npm run test && npm run prune
  # E2E manual: dev:api (:3000) + dev:vite (:5173); criar conta na página nova; editar via /consulta.
</validation_commands>
```

## Por que este template diverge do original (substituição cega supplier→financial_account_control)

| Original (errado) | Correto |
|---|---|
| PK `sk_financial_account_control` + trigger `mirror_id` | PK é **`id`** (BIGINT); fornecedor é a FK **`sk_supplier`** |
| Campos `legal_name/trade_name/cnpj/cpf/email2-4` | Isso é **fornecedor**; conta tem `amount`, `due_date`, `document_type`, `payment_method`, `status`, `sk_supplier`… |
| "não tem created_at/updated_at" | A conta **tem** `created_at`/`updated_at` (com trigger) |
| `chk_..._has_identifier` / migrations 042/011/028/029 renomeadas | Constraints/migrations são de **supplier**; as da conta são 018/034/035/033/036 |
| Soft delete via `deleted_at` + 409 "fornecedor em uso" | Conta usa **status `cancelado`** (sem `deleted_at`, sem botão de exclusão) |
| Schemas a "criar" | Já existem em `financial-account-control.schema.ts` — **reusar** |
