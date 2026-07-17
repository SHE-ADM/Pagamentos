# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este projeto

`pagamentos` é um **pipeline financeiro de contas a pagar**, não um app CRUD comum.
O fluxo central (entrada) é: e-mail (IMAP) → download de PDF → extração via Claude API →
gravação no Supabase → consulta/exportação pela interface web.

Há também um **segundo pipeline (saída): cobrança de títulos vencidos** — lê o Firebird e
**envia e-mails de cobrança por SMTP (Locaweb)**, com logs próprios. Ver "Pipeline de cobrança
de vencidos (skill `cobranca-vencidos`)".

E um **terceiro pipeline (infra): backup diário do Supabase** (skill `backup-supabase`) —
`pg_dump` do banco + download do bucket `attachments`, agendado às 02:00. Ver "Pipeline de
backup do Supabase (skill `backup-supabase`)".

E um **quarto pipeline (reconciliação): baixa automática de contas pagas** (skill
`baixa-automatica`) — marca como `pago` as contas com NF + Boleto confirmados e vencimento
vencido, agendado às 06:00. Ver "Pipeline de baixa automática (skill `baixa-automatica`)".

> **Arquitetura: monorepo Sheild com backend híbrido.** Desde a reestruturação de
> 2026-06-09, o projeto adota o monorepo `apps/* + packages/shared` (npm workspaces),
> mas o backend é **híbrido** — pontos onde ainda diverge do padrão genérico:
> - **Pipeline Python permanece** (`server/` Flask + `skills/`): IMAP, extração de PDF
>   (Claude Vision via base64 + pdfplumber). Não há equivalente TS viável; é o coração
>   do sistema e não foi reescrito.
> - **`apps/api-backend`** (Next.js 16 + TypeScript, porta 3000) é a camada nova de
>   dados/CRUD. Aciona o pipeline Python via **ponte HTTP** (`lib/python-bridge.ts` →
>   Flask), não por subprocess.
> - **`apps/frontend-vite`** (React 19 + Vite 8, porta 5173) é o app interno, agora
>   **100% TypeScript** (`.tsx/.ts`), **sem shadcn/ui**. Continua lendo o Supabase via
>   **REST direto com `fetch`** (`src/services/supabase.ts`); só a sessão de auth usa o
>   SDK oficial (`src/lib/supabaseClient.ts`).
> - **`apps/portal-next`** (Next.js 16 + Tailwind v4, porta 3002) é o portal público
>   (scaffold).
> - **`packages/shared`** (`@sheild/shared`) — schemas Zod, fonte de verdade de tipos
>   entre frontends e API.
>
> **Stack atualizado (upgrade do stack — 5 fases + React Compiler transform, 2026-06-18):** Vite **8** (Rolldown) · Vitest **4** ·
> React **19** (unificado em todo o monorepo) · TypeScript **6** · ESLint **10** no
> frontend-vite (apps Next em ESLint **9** — carve-out, ver `eslint10-next-carveout` na
> memória) · **React Compiler** ativo — regras (`eslint-plugin-react-hooks@7`) **e transform
> de build** (`@rolldown/plugin-babel` + `reactCompilerPreset`) · Tailwind
> **v4 CSS-first** (`@theme`/`@utility` em `src/index.css`; **não há mais `tailwind.config.ts`**) ·
> Zod **4** (+ `@hookform/resolvers@5`, `react-hook-form@7.79`) · `tailwind-merge@3` ·
> `lucide-react@1`.
>
> Não aplique os templates Sheild Canvas nem shadcn aqui. O **fluxo de autenticação em
> 3 etapas** e a **regra de não-autorregistro** (`auth-specs.md`) foram seguidos,
> adaptados para `.tsx` com Tailwind. Mantenha o estilo existente do restante do projeto.
>
> **Desvio justificado:** migrations ficam em `supabase/migrations/` (não
> `server/db/migrations/`) — preserva a convenção numérica 001+ e o fluxo manual de
> aplicação no SQL Editor.

---

## Regras mandatórias

Estas regras se aplicam a **todo** código novo ou alterado neste projeto, sem exceção.

### 1 — Atomic Design + Tailwind (frontend)

- Todo componente de UI pertence a uma camada: `atoms/`, `molecules/` ou `organisms/`.
  - **Atom**: elemento sem filhos de domínio (input, botão, badge, texto expansível).
  - **Molecule**: composição de atoms (fileira de logos, mensagem inline, header de auth).
  - **Organism**: componente com estado e lógica de negócio (formulário completo, tabela paginada).
- Estilo **exclusivamente via classes Tailwind** — `style={{}}` inline é proibido quando
  existir token ou classe equivalente no Tailwind.
- **Tokens de cor**: usar `loginGreen-*` nas telas de auth e `status-*`
  (feedback, badges e banners — ver guia abaixo) no restante do app. Nunca use hex
  hardcoded **nem cores default do Tailwind** (`red-*`, `amber-*`, `emerald-*`, `blue-*`,
  `teal-*`…) para estados semânticos — o token semântico é a fonte de verdade única
  (paleta no bloco `@theme` de `src/index.css` — Tailwind v4 CSS-first).
- **Tokens de tamanho**: usar os tokens Tailwind mais próximos em vez de valores
  arbitrários (ex.: `text-sm` em vez de `text-[15px]`). Valores sem token equivalente
  (ex.: `object-[center_25%]`) são aceitos como exceção justificada.
- **Tailwind JIT**: usar strings estáticas completas em ternários —
  `${focused ? 'bg-loginGreen-fieldFocus' : 'bg-loginGreen-field'}` é correto.
  Nunca concatenar partes de nome de classe (`bg-loginGreen-${variavel}`) — o JIT
  não gera CSS para nomes computados.
- Preferir modificadores `hover:`, `disabled:`, `placeholder:`, `focus:` a handlers JS.
- **CVA para variantes**: componente com variação visual (variante, estado booleano)
  centraliza as classes em `cva()` (`class-variance-authority`) e aplica com o helper
  `cn()` (`src/lib/cn.ts` — `clsx` + `tailwind-merge`): `cn(badgeVariants({ variant }), className)`.
  Cada valor de variante continua sendo uma **string literal completa** (compatível com o
  JIT). Componentes-referência: `StatusBadge` (mapa em `statusBadge.variants.ts`),
  `Alert` (banner de página — error/success/warning/info), `InlineMessage`, `AuthInput`,
  `FilledTextField`, `AccentPillButton`, `GradientPillButton` e `DataGrid` (tema
  `default`/`silver` + estados de linha/cabeçalho em `dataGrid.variants.ts`).
  Mantenha as definições `cva` que não são componentes em arquivo separado (`*.variants.ts`)
  para não disparar `react-refresh/only-export-components`. A exceção aceita é um `cva`
  **local e não exportado** dentro do próprio componente (ex.: `navLink` em `Layout.tsx`),
  que não dispara a regra de Fast Refresh.

### 2 — Todo componente tem teste

- **Todo componente novo ou alterado de forma relevante deve ter ao menos um teste**
  cobrindo renderização e a interação principal (ex.: submit, expand/collapse, validação).
- **Suíte configurada (Vitest):** `apps/frontend-vite` (jsdom + Testing Library) e
  `apps/api-backend` (env node). Rode `npm test` na raiz (roda todos os workspaces) ou
  `npm run test --workspace=apps/<app>`. No `api-backend`, o `vitest.config.ts` resolve o
  alias `@` (espelhando `@/*`→`./*` do tsconfig) e coleta testes em `lib/**` **e** `app/**`
  (`*.test.ts`) — rotas têm teste co-locado (ex.: `app/api/emails/read/route.test.ts`
  cobre 422/200/502 mockando `triggerReader`).
- **Suíte Python (pytest):** `py -3 -m pytest tests/` (ex.: `test_link_extraction.py`,
  `test_email_body_extraction.py`, `test_body_amount.py`, `test_extract_pdf.py`). Cobre o
  pipeline de extração; rodar após mexer em `read_emails.py`/`extract_pdf.py` ou nos
  scripts de reprocessamento. Não é incluída no `npm test`.
- Referência de granularidade: `frontend-vite/src/components/StatusBadge.test.tsx`,
  `ExpandableText.test.tsx`, `organisms/LoginForm.test.tsx`.
- **`apps/portal-next`**: testado via **server rendering** (`react-dom/server`
  `renderToStaticMarkup`) em vez de jsdom + `@testing-library/react` (`app/page.test.tsx`).
  O React agora é **unificado em 19** em todo o monorepo (Fase 2 do upgrade), então o
  antigo conflito "duas versões do React" não existe mais; o `vitest.config.ts` ainda usa
  `resolve.dedupe: ['react','react-dom']` (defensivo). O `frontend-vite` também aplica esse
  dedupe no `vite.config.ts` — há `react@18` só como transitivo eventual, então o dedupe
  garante uma única cópia no bundle/teste. (Follow-up: com o React unificado, o portal pode
  voltar a usar jsdom + Testing Library — ainda não feito.)

### 3 — REST no backend

Duas camadas, dois envelopes — **não misturar**:

| Camada | Onde | Envelope |
|---|---|---|
| Flask (Python) | `server/app.py` | `{"ok": bool, ...}` — legado, manter |
| Next API (TS) | `apps/api-backend/app/api/**/route.ts` | `{ success, data?, error?, meta? }` (`lib/response.ts`) |

Regras comuns a toda rota nova:

| Decisão | Regra |
|---|---|
| URL | Substantivo no plural (`/api/contas`, `/api/contas/:id`) |
| Verbos | `GET` leitura · `POST` criação/ação · `PUT`/`PATCH` atualização · `DELETE` remoção |
| Status codes | `200`/`201` sucesso · `400`/`422` validação · `401`/`403` auth · `404` não encontrado · `5xx` servidor |
| Sessão | Stateless — autenticação via `Authorization: Bearer <token>` no header |

Rotas novas de CRUD/dados vão na **Next API** (envelope `{ success, ... }`, Repository →
Service → Route, conforme `monorepo-crud-spec.md`). A exceção aceita: a leitura de e-mails
(`POST /api/emails/read` síncrono · `POST /api/emails/read/start` assíncrono ·
`GET /api/emails/progress`) usa POST + corpo de parâmetros porque é uma **ação de disparo**,
não um recurso CRUD.

**CRUD de fornecedores (`apps/api-backend/lib/suppliers.ts` + `app/api/suppliers/**`):** primeiro
CRUD completo da Next API (Repository → Service → Route, escrita via `getSupabaseAdmin`).
`GET /api/suppliers` (paginado `page`/`limit`≤100 + `search` por nome/CNPJ/CPF/4 e-mails via
`ilike`, índices trgm da migration 029) · `GET/PATCH/DELETE /api/suppliers/:sk` (por
`sk_supplier`) · `POST /api/suppliers`. Validação Zod em `@sheild/shared`
(`supplierCreateSchema`/`supplierUpdateSchema` — CNPJ/CPF com strip de máscara; ao menos um
identificador, espelhando `chk_supplier_has_identifier`; **classificação default
`cost_center_id`/`chart_account_id`** editável — `int().min(0)`, `0` = "não informado"). O form
(`SupplierForm`) traz **Centro de custo** e **Plano de contas** em CASCATA (`CostCenterSelect`/
`ChartAccountSelect`); o payload sempre envia os dois ids (`0` quando vazio, cobrindo limpar na
edição), e `SuppliersPage.openEdit` busca o fornecedor completo (`getSupplier`, com embeds) para
rotular os selects. `DELETE` é **soft delete**
(`deleted_at`, migration 045) e **bloqueia com 409** quando há contas vinculadas
(`financial_account_control.sk_supplier`) — fornecedor é PRESERVADO, nunca hard delete.
`sk_supplier`/`supplier_id` nunca entram no corpo (gerados pelo banco + trigger
`trg_supplier_mirror_id`). Status: `201` criação · `409` UNIQUE (23505) de CNPJ/CPF · `404` ·
`422` Zod · `400` sk inválido. **Ordenação `?sort=name`** (opcional): ordena por `trade_name` asc —
usado pelo **lookup de fornecedor** do modal de contas (`SupplierSelect`, ordem alfabética global);
**sem `sort`** o padrão é `sk_supplier` desc (página `/fornecedores`). Spec/template em
`docs/prompts/api-supplier-crud-spec.md`. **`/fornecedores` (`SuppliersPage`):** a edição abre
**apenas pelo botão de lápis** (coluna "Ações") — `onRowClick` do grid é no-op; clicar na linha
não abre o modal. **Colunas do grid** (`getSupplierColumns`): Razão social · Nome fantasia ·
**CNPJ / CPF** (uma única coluna — CNPJ se houver, senão CPF; helper `supplierDoc`) · E-mail ·
**Centro de custo** · **Plano de contas** (classificação default, `código — descrição`; id 0 →
"—") · Ações. Para exibir as descrições da classificação, o `findAll` da lista
(`GET /api/suppliers`) passou a trazer os **embeds** `cost_center`/`chart_account`
(`SELECT_WITH_CLASSIFICATION`) — antes só o `GET /:sk` os trazia. As duas colunas de classificação
são **ordenáveis server-side pela FK própria** (`sort=cost_center_id`/`chart_account_id`, no
allowlist `SORTABLE_COLUMNS`); CNPJ/CPF ordena por `cnpj`.

**CRUD de contas (`apps/api-backend/lib/contas.ts` + `app/api/contas/**`):** CRUD da tabela
principal `financial_account_control` (PK = **`id`**, não `sk_*`; fornecedor pela FK obrigatória
`sk_supplier`). `GET /api/contas` (paginado + `search` por fornecedor/nº doc/assunto/remetente,
JOIN `supplier`, exclui `cancelado` por padrão) · `GET/PATCH/DELETE /api/contas/:id` · `POST /api/contas`.
**Remoção PADRÃO = `PATCH { status_id: <id do cancelado = 9> }`** (preservação). **`DELETE` = HARD
DELETE físico, restrito ao GRUPO ADMINISTRADOR** (`requireAdminGroup` → **403** fora do grupo;
`contaService.remove` → `contaRepository.hardDelete`) — exceção deliberada à preservação (pedido do
usuário). **Verificado no banco (não regredir):** a ÚNICA FK que referencia `financial_account_control`
é `financial_account_attachment.account_id` **ON DELETE CASCADE** (as linhas de anexo caem junto) — não
há FK RESTRICT/NO ACTION, e **não há trigger de DELETE** (os 4 triggers são só INSERT/UPDATE), então o
delete é limpo e completo. Os objetos no bucket viram órfãos (limpos por `purge_orphan_attachments`).
Status: `404` (inexistente) · `409` (FK RESTRICT — defensivo, hoje inalcançável) · `500` NÃO vaza
detalhe (`ContaServiceError(msg,500)` → `failFromError` genérico + log). **`canSeeConta` é
DELIBERADAMENTE omitido** (diferente de GET/PATCH): o propósito é o Administrador excluir QUALQUER conta
— aplicar `canSeeConta` acoplaria a exclusão à visibilidade e BLOQUEARIA um admin restrito; o gate de
grupo é o modelo correto (admin vê tudo é a invariante single-org). UI: botão **"Excluir conta"** no
painel de detalhe de `/consulta`, só para o grupo Administrador (`isAdminGroup` do `AuthContext`), com
**confirmação inline** (irreversível); remove a linha + ajusta `total`/cards ("Valor total"/"Total de
registros" só descontam quando a conta NÃO era cancelada — esses cards excluem cancelado) + `refreshStats`.
O gate de UI é cosmético — a autorização é imposta no servidor. Testes: `lib/contas.test.ts`
(`remove` 404/409/500), `app/api/contas/[id]/route.test.ts` (DELETE 403/400/200/404),
`Consulta.test.tsx` (botão só p/ admin + fluxo de confirmação → `deleteConta`).
Validação Zod em `@sheild/shared` — `financialAccountControlCreateSchema` (criação manual exige
`sk_supplier` + `amount`>0; demais campos opcionais, o banco aplica DEFAULT/NULL; **`status_id` é
OMITIDO do create** — a conta nasce no DEFAULT 3 do banco (`a vencer`) e a trigger recalcula
`a vencer`/`vencido` por vencimento, então o cliente NÃO cria conta já em estado fechado) e
`financialAccountControlUpdateSchema` (partial — aceita `status_id`; a baixa/cancelamento é feita
depois via PATCH). `status_id`/`sk_company`/`created_at`/`updated_at` são derivados (trigger) ou
controlados — só `status_id` entra no corpo de PATCH (situação), nunca no de criação. Status: `201` · `409` (23505) · `404` · `422` ·
`400` id inválido. Frontend: **página `/contas`** (lançamento rápido — `pages/ContasNovaPage.tsx`
com o card centralizado `mx-auto` + `organisms/ContaForm.tsx`) e **edição da conta em `/consulta`
pelo botão "Editar conta" do painel de detalhe** (abre o modal `ContaForm` → `PATCH /api/contas/:id`).
A antiga coluna **"Ações"** do grid (botão lápis por linha) foi **REMOVIDA** — o grid não tem mais
coluna de ação; clicar na linha abre o detalhe e a edição parte de lá. Fornecedor via
**react-select** (`molecules/SupplierSelect.tsx` — `AsyncCreatableSelect`: busca + cria fornecedor
inline via `POST /api/suppliers`); **tipo de documento e tipo de pagamento** são `<select>` de enum
(valores pré-definidos, obrigatórios, **ordenados alfabeticamente** — `DOCUMENT_TYPE_OPTIONS`/
`PAYMENT_METHOD_OPTIONS` em `ContaForm`). **Classificação contábil** via dois lookups react-select —
**Centro de custo** (`molecules/CostCenterSelect.tsx`) e **Plano de contas**
(`molecules/ChartAccountSelect.tsx`), em CASCATA: ver "Lookups de classificação contábil (cascata)".
**Empresa pagadora (`sk_company`) é ESCOLHIDA no form** (`LabeledSelect` "Empresa", logo após o
Fornecedor): 1=OTIMOTEX / 2=LEBIANCO, opções via `GET /api/companies` (`companyService` em
`lib/lookups.ts`, molde do `statusService`; cliente `listCompanies` em `services/lookups.ts`).
**Create nasce no default OTIMOTEX** (`SK_COMPANY_DEFAULT`); edição mostra a empresa da conta.
No **lançamento em série** a empresa **PERMANECE** (o `resetSupplier` não a toca — igual aos
selects de classificação). Falha no lookup **não trava** o lançamento (fallback OTIMOTEX).
`sk_company` **é independente do fornecedor** — pode haver conta da LEBIANCO cujo fornecedor é a
OTIMOTEX. Ordem dos campos do form: **Fornecedor → Empresa → Descrição → Centro de custo → Plano de contas →
(Tipo de documento + Tipo de pagamento) → (Nº documento + Emissão) → (Valor + Vencimento) →
Código de barras → Informações adicionais** (os 3 pares na mesma linha; código de barras isolado;
**Informações adicionais** por último — `<textarea>` de texto livre, coluna
`financial_account_control.additional_info` TEXT nullable, migration 064). Esse texto é escrito
pelo usuário e **aparece no card de detalhe de `/consulta`** (bloco "Informações adicionais",
`whitespace-pre-wrap`) **E como um rodapé SEMPRE-visível abaixo das células do registro** no grid
(prop `renderRowFooter` do `DataGrid` — ver "Grid compartilhado"), destacado em fonte
`font-jakarta` itálica + texto `text-slate-600` sobre fundo `bg-status-warning-bg` (amarelo pastel);
só os registros com `additional_info` ganham o rodapé. É distinto de `processing_notes`
(auditoria/pipeline, exibido como "Observações") e nunca é tocado pela extração. Na
**inclusão** (modo `create`), **Emissão e Vencimento já vêm com a data de hoje** (`todayISO()`,
data local — `toFormValues` só preenche quando não há `defaultValues`; edição mantém os valores
da conta). **Lançamento EM SÉRIE (só `/contas`, modo `create`):** após **Lançar conta**, a página
**NÃO remonta** o form — mantém todos os campos, **limpa apenas o Fornecedor e o refoca** (handle
`ContaFormHandle.resetSupplier`, chamado por `ContasNovaPage` no sucesso e na falha parcial de
anexo). O `SupplierSelect` é remontado por `key` (o react-select não espelha `value`) com
`autoFocus`; os selects de **classificação (centro/plano) PERMANECEM** — só são re-semeados quando o
usuário escolhe um novo fornecedor (não regredir — ver [[conta-form-classification-selects]]). A
fila de anexos é descartada (já subiu). O modal de edição de `/consulta` **não** usa esse handle
(fluxo próprio). O **`ContaForm`** (inclusão/edição) **não** tem botão de exclusão; o **hard delete**
existe só no **painel de detalhe de `/consulta`** e só para o **grupo Administrador** (ver "CRUD de
contas" / "Hard delete dos cadastros"). Cliente Next API em `services/contas.ts` (proxy `/data-api`;
`deleteConta` faz o `DELETE`). Spec/template em `docs/prompts/api-contas-crud-spec.md`.

**Anexos de conta (N por conta — `financial_account_attachment`, migration 079):** o usuário anexa
**vários** arquivos (PDF/imagem) ao **incluir e ao editar** uma conta, no **mesmo bucket
`attachments`** do pipeline. A tabela é o **PADRÃO ÚNICO** das duas origens — `origin='pipeline'`
(documento que veio do e-mail, espelha `source_file` via backfill + registro no reader) e
`origin='manual'` (upload do usuário) —, então o painel lista todos igual. Antes, conta lançada à mão
era **permanentemente sem anexo**: `source_file` é uma coluna só e é bloqueada no CRUD manual (S3-2).

- **Upload em 2 passos, bytes FORA da Next API** (`lib/conta-attachments.ts`): `POST
  /api/contas/:id/attachments/upload-url` valida e devolve `{storage_key, signed_url, token}` →
  o **browser** envia direto ao Storage (`uploadToSignedUrl`) → `POST /api/contas/:id/attachments`
  registra a linha. Motivo: a Vercel corta o corpo de uma function em ~4,5 MB (foto de celular passa
  disso) e assim **não** é preciso dar INSERT em `storage.objects` ao papel `authenticated` — quem
  escreve segue sendo só o `service_role`, via a URL que ele emite. **Limite: 10 MB/arquivo**
  (`ATTACHMENT_MAX_BYTES`); mimes = `ATTACHMENT_MIME_TYPES` (espelha `_UPLOAD_CONTENT_TYPES` do reader).
- **A chave é gerada no SERVIDOR** — `manual/{account_id}/{YYYYMMDDTHHMMSSZ}_{rand8}_{nome}.{ext}`
  (`buildStorageKey`). O prefixo `manual/` torna a colisão com o pipeline **impossível por
  construção**: o `safe_filename` do reader remove a barra (`[^\w\s-]`), então **nenhuma chave do
  pipeline contém `/`**. A extensão vem do **mime validado**, não do nome do cliente; o `rand8` evita
  colisão de mesmo nome/conta/segundo (o reader resolve isso pelo disco, que aqui não existe).
  `safeFileName` espelha o `safe_filename` do Python (saídas conferidas contra ele no teste).
  **Se o cliente escolhesse a chave**, pediria autorização para o objeto do pipeline e o
  sobrescreveria — daí a chave ser do servidor + `createSignedUploadUrl` sem `upsert`.
- **Guards do register (a segurança do fluxo — não regredir):** a URL assinada **não valida
  conteúdo**, então (1) `isOwnManualKey` exige o **FORMATO INTEIRO** da chave gerada pelo servidor
  (422); (2) o objeto tem de existir (`storage.info()` → 422, mata a linha-fantasma); (3) **grava o
  `size`/`mimetype` REAIS do `info()`**, não os declarados — fora do limite/allowlist → 422 **+
  `storage.remove()`** do objeto (ainda não vinculado a conta nenhuma, então limpá-lo não fere a
  preservação). `info()` devolve **camelCase** (`contentType`/`size`) — o storage-js camelizA no
  runtime (`recursiveToCamel`).
- **PATH TRAVERSAL — por que o guard valida o FORMATO e não só o prefixo (não afrouxar):** o
  Supabase Storage **NORMALIZA o `..`** (verificado contra o bucket real: `info()` resolve,
  `createSignedUrl` assina e o download devolve HTTP 200 com os bytes). Um guard
  `key.startsWith('manual/{id}/')` aceitaria `manual/7/../../ester_HYOSUNG.pdf` (→ objeto do
  PIPELINE, na raiz) e `manual/7/../8/x.pdf` (→ anexo de OUTRA conta): o usuário registraria na
  conta dele um objeto alheio **sem subir nada** e o veria pela UI — furando a visibilidade por
  dono (076) e criando uma linha `origin='manual'` (removível!) para um documento de auditoria.
  Por isso `isOwnManualKey` casa a regex do formato completo (`ts_rand8_nome.ext`, extensão na
  allowlist), montada a partir das MESMAS constantes de `buildStorageKey`. Travado em
  `lib/conta-attachments.test.ts` (7 chaves forjadas + a chave real).
- **Erro de escrita passa por `mapWriteError` (§3 M-2 — não regredir):** default **500**, não 422.
  `failFromError` ECOA a mensagem de qualquer status < 500, então um erro inesperado do Postgres
  em 422 vazaria nome de tabela/constraint (cenário real: `file_name` só com espaços furava o
  `min(1)` do Zod e batia no CHECK `btrim(...)` → `23514`). Curados: `23505`→409, `23503`→404.
  O schema também tem `.trim()` antes do `.min(1)`, para o nome vazio morrer na validação.
- **Remoção = SOFT DELETE** (`deleted_at`/`deleted_by`) — o **objeto FICA no bucket** (política de
  preservação + policy RESTRICTIVE da 073). Anexo `origin='pipeline'` é **irremovível** (trilha de
  auditoria → **403**); anexo manual: só o **autor** ou o **grupo Administrador** (`isInAdminGroup`
  de `lib/auth.ts` — variante booleana de `requireAdminGroup`, pois o autor também pode).
- **Filtro de `deleted_at` EXPLÍCITO no repository (o bug mais provável desta feature):** a policy
  esconde o removido do papel `authenticated`, mas a Next API usa **service_role, que ignora a RLS**.
  Sem `.is('attachments.deleted_at', null)`, o PATCH devolveria anexos removidos e eles
  **reapareceriam no grid** (que mescla a resposta in-place, sem refetch). O filtro é de **recurso
  embutido** do PostgREST (não `!inner`): tira o anexo de dentro da conta sem descartar contas —
  conta sem anexo vem com `attachments: []`. Vale no retorno de INSERT/UPDATE (verificado contra o
  banco real). O `SELECT_WITH_EMBEDS` do frontend **não** filtra (lê como `authenticated`).
- **Modo CREATE: os arquivos sobem só DEPOIS do `POST /api/contas` devolver o id** — a fila fica em
  memória no `ContaForm` (prop `onSubmit(data, pendingFiles)`) e o **pai** faz o flush. A alternativa
  (staging + `move`) exigiria coletor de órfãos e uma exceção à preservação. **O modo EDIT usa o
  mesmo caminho** (subir ao escolher deixaria órfão se o modal fosse cancelado). Trade-off assumido:
  upload que falha deixa a conta sem aquele anexo → `Alert variant="warning"` **nomeando os
  arquivos** (dizer só "erro" faria o usuário relançar a conta e duplicá-la).
- **`onSubmit` DEVOLVE a fila que resta (não regredir — duplicava anexo):** o retorno de
  `onSubmit(data, files)` é `File[] | void` = os arquivos que **permanecem** na fila (`undefined`
  esvazia; **lançar** preserva tudo). Sem isso, na falha parcial — em que o modal de `/consulta`
  **fica aberto** e o form **não remonta** — um 2º submit reenviava a fila INTEIRA e **duplicava o
  que já subiu** (cada upload gera `storage_key` nova, então o UNIQUE não deduplica), e o próprio
  aviso "tente novamente" levava a isso. Hoje: `Consulta.handleEditSubmit` devolve só os que
  falharam **e** faz `setEditing(merged)` (senão a lista do modal não mostraria os recém-salvos);
  `ContasNovaPage` devolve `files` quando a CONTA falha (o erro é engolido lá, não sobe ao form).
- **Frontend:** `atoms/FileInputButton` (input file real + `sr-only` → teclado/leitor de tela de
  graça) · `molecules/AttachmentPicker` (fila controlada, valida mime/tamanho/duplicata no cliente —
  conveniência; quem manda é o backend) · `molecules/AttachmentList` (apresentacional pura, serve
  fila e salvos) · `organisms/ContaAttachments` (lista/viewer/remoção). **Assimetria deliberada:**
  adicionar é rascunho (efetiva no submit); **remover é imediato**, com confirmação. O
  `AttachmentViewer` ganhou a prop opcional **`title`** (nome amigável — sem ela o cabeçalho mostraria
  a chave crua `manual/512/2026…_Boleto.pdf`); segue recebendo a **chave crua** em `sourceFile`.
  Serviço em `services/contaAttachments.ts` (**não** usa o `call()` de `contas.ts`, que fixa
  `Content-Type: application/json`); `uploadContaAttachments` é **sequencial** (progresso honesto
  "2/3", falha isolada) e **NÃO lança** — devolve `{saved, failed}`.
- **Contenção do clique — nos BOTÕES, nunca num wrapper (não regredir):** no painel de detalhe de
  `/consulta` a lista e o viewer ficam **dentro do `<tr>`**, cujo `onClick` alterna a linha — sem
  conter, abrir/fechar/baixar um anexo **fecharia o próprio painel**. Quem chama `stopPropagation`
  são os botões/links do `AttachmentList`, da confirmação de remoção e do `AttachmentViewer`
  (Fechar/Baixar/Nova aba) — todos interativos, como já faziam os botões do detalhe. **Duas saídas
  que NÃO servem:** (a) `<div onClick={stopPropagation}>` em volta — handler em elemento
  não-interativo, reprovado pelo **SonarCloud** (S1082, quality gate); pôr um `onKeyDown` ao lado só
  para calar a regra seria código morto (o `<tr>` do DataGrid só tem `onClick`, e Enter/Espaço num
  `<button>` já gera um `click`, que é contido); (b) **`createPortal` para o body NÃO resolve** — o
  React propaga o evento pela árvore de **COMPONENTES**, não pela do DOM, então o clique alcança o
  `<tr>` mesmo com o `<dialog>` fora dele (verificado em teste; o `showModal` põe o dialog no top
  layer só VISUALMENTE). Os testes travam o COMPORTAMENTO ("o clique não alcança o ancestral"), não
  o mecanismo.
- **Fallback `legacySourceFile` (não regredir):** o registro no reader é **não-fatal**, então uma
  conta pode ter `source_file` e nenhuma linha. Sem o fallback o anexo do e-mail sumiria da tela —
  regressão contra o antigo botão "Ver anexo", que o painel de detalhe de `/consulta` substituiu pela
  lista (`ContaAttachments` com `canRemove={false}` — a remoção é pelo modal de edição). A condição é
  **"não há anexo de ORIGEM PIPELINE"**, não "não há anexo nenhum": com `rows.length === 0` o boleto
  do e-mail sumia assim que o usuário anexasse **um** arquivo manual — a mesma regressão, reintroduzida
  pela porta dos fundos. O item legado entra ANTES dos demais na lista.
- **Pipeline (`read_emails.py`):** `register_financial` passou a devolver **`int | None`** (o id da
  conta) em vez de bool — via `Prefer: return=representation` + `select=id`; os call sites
  `if ctrl.register_financial(...)` seguem válidos (id é truthy, None falsy). O vínculo é feito no
  **Passo 2**, após a conta existir (`register_attachment`, idempotente por
  `on_conflict=account_id,storage_key` + `ignore-duplicates`, **não-fatal**) — no Passo 1 não há id, e
  a conta pode nem ser criada. Registra **sempre que a conta é criada**, mesmo se o upload falhou (a
  tabela espelha o `source_file`); `storage_key == file_name` (nome flat). O anexo herda o **dono** da
  conta via `ctrl.resolve_user(sender_email)` — **NÃO** use `payload.get("created_by")`:
  `register_financial` resolve o dono numa **cópia local** do payload, então o dict do call site nunca
  o recebe e todo anexo cairia no sentinela, divergindo do backfill (que gravou o dono real).
  `resolve_user` é **cacheado por e-mail** na instância (a mesma caixa repete o remetente; a falha
  NÃO é cacheada). **Deploy: copiar só `read_emails.py`** (o `extract_pdf.py` não muda; sem `.env`; a
  079 já rodou na base compartilhada).

**CRUD de centros de custo (`apps/api-backend/lib/cost-centers.ts` + `app/api/cost-centers/**`):** CRUD
do cadastro `financial_cost_center` (grupo **Tabelas** da sidebar, página **`/tabelas/centros-de-custo`**
→ `pages/CostCentersPage.tsx`). PK `cost_center_id` é **SMALLINT IDENTITY ALWAYS** (gerada pelo banco,
nunca no corpo); o **id 0 é o sentinela "não informado"** — preservado, nunca listado/editado/excluído.
`GET /api/cost-centers` é **dois consumos do mesmo recurso, discriminados por `page`**: **sem `page`** =
lookup legado da classificação contábil (lista completa p/ o react-select, `lib/lookups.ts`, INTOCADO);
**com `page`** = listagem paginada + busca por código/descrição do CRUD (`lib/cost-centers.ts`, exclui o
sentinela). `POST /api/cost-centers` cria · `GET/PATCH/DELETE /api/cost-centers/:id`. Validação Zod em
`@sheild/shared` (`costCenterCreateSchema` exige **código + descrição**; `costCenterUpdateSchema` parcial,
ao menos um campo). **Código único** validado na aplicação (case-insensitive — não há UNIQUE no banco) →
**409**. **`DELETE` é HARD DELETE** (a tabela não tem `deleted_at`), **bloqueado com 409** quando o centro
está referenciado por `financial_account_control`, `financial_chart_of_account` ou `supplier` (as 3 FKs);
o sentinela id 0 também é bloqueado. Status: `201` criação · `409` (código duplicado / em uso) · `404` ·
`422` Zod · `400` id inválido. A rota/lib `DELETE` é exposta na UI **apenas ao grupo Administrador**
(gate por `user_profile.group_id = 1` — ver "Hard delete dos cadastros"). Frontend:
`services/costCenters.ts` (proxy `/data-api`), `organisms/CostCenterForm.tsx` (código +
descrição), grid via `getCostCenterColumns` (ação **editar** por linha + **excluir** só para o grupo
Administrador). O botão de exclusão usa estilo inline (`bg-status-error-fg`) —
não há utilitário `btn-danger`.

**Grid COMPLEMENTAR — plano de contas do centro selecionado (mestre-detalhe):** `/tabelas/centros-de-custo`
é a única página de cadastro que é **mestre-detalhe**. **Clicar numa linha do centro SELECIONA** o centro
(alterna: clicar de novo/noutro desmarca) e carrega, **abaixo** da grade mestre, um **segundo `DataGrid`**
(`gridId="tabela-centros-de-custo-plano"`, isolado) com o **plano de contas LANÇÁVEL** (`is_postable=true`)
vinculado àquele centro — colunas **Código · Descrição · Grupo · Sub Grupo** (read-only, sem ações;
factory `getCostCenterChartAccountColumns` em `useGridColumns`). Ao selecionar um centro, o card do plano
**rola para a viewport** (`detailRef.scrollIntoView`, `scroll-mt-4`) — não abre no rodapé da página. A
**edição do centro continua abrindo SÓ pelo lápis** (a seleção pela linha não abre o modal — não conflita
com a regra "editar só pelo lápis").
Sem seleção, o grid mostra "Selecione um centro de custo para ver o plano de contas" e **não** consulta a
API; com centro sem planos lançáveis, "Nenhum plano de contas vinculado a este centro". **Abre ordenado
por Código ascendente** por padrão (estado inicial `detailSort = { col: 'account_code', dir: 'asc' }`;
envia `sort=account_code&order=asc`). Ordenação server-side (Código/Descrição + Grupo/Sub Grupo pela
descrição do embed via `alias(coluna)`) e paginação própria (evita truncar acima de `MAX_LIMIT=100`). **Backend (aditivo, retrocompatível):** o CRUD paginado
de plano de contas (`lib/chart-accounts.ts` + `app/api/chart-accounts` ramo COM `page`) ganhou os filtros
`cost_center_id` (inteiro > 0) e `postable=true` — antes só o **lookup** da cascata (sem `page`) filtrava
por centro, mas devolvia só código/descrição (sem embeds grupo/subgrupo); o ramo de lookup ficou
**INTOCADO**. Cliente: `listChartAccountsByCostCenter(costCenterId, params)` em `services/chartAccounts.ts`
(reusa o CRUD paginado, envelope com `meta` + embeds).

**CRUDs dos demais cadastros contábeis (grupo Tabelas) — Bancos, Contas, Plano de contas, Grupos,
Sub grupos:** mesmo padrão do CRUD de centros de custo (Repository → Service `service_role` → Route
dual-mode; código único na aplicação; **sem migrations**). **O HARD DELETE é exposto na UI apenas ao
grupo Administrador** — ver "Hard delete dos cadastros (grupo Administrador)". Um componente genérico
**`organisms/CrudTablePage.tsx`** (`<T, TInput>`: lista
paginada + busca debounce + modais criar/editar + confirmação de exclusão) é a base das 5 páginas
finas; o form de cada um vai por **render prop**. A busca usa a molécula **`SearchInput`** (lupa +
botão limpar/X que aparece só com texto e devolve o foco ao input) — compartilhada com
`CostCentersPage` e `SuppliersPage`. A célula "Ações" do grid renderiza o lápis (editar) e, **para o
grupo Administrador**, a lixeira (excluir) — `editCell`/`actionsCell` em `useGridColumns`.
Lookups nos forms via **`atoms/LabeledSelect.tsx`** (`<select>` rotulado, associação `htmlFor`/`id`).
Cliente HTTP compartilhado em **`services/dataApi.ts`** (`dataApiCall`/`dataApiListPaged`/`dataApiDelete`).

**Hard delete dos cadastros (grupo Administrador):** o botão de exclusão dos **6 cadastros do grupo
Tabelas** aparece **apenas para usuários do grupo Administrador** (`user_profile.group_id = 1`,
migration 065) e a exclusão é **HARD DELETE** (físico, bloqueado com **409** por FK quando o registro
está em uso; o sentinela id 0 também é bloqueado). **Duas camadas:** (1) **gate de UI** — `AuthContext`
carrega `groupId`/`isAdminGroup` lendo `user_profile` do próprio usuário (RLS da 065 permite só o
próprio perfil); `CrudTablePage` e `CostCentersPage` só oferecem a lixeira + o modal de confirmação
quando `isAdminGroup`; (2) **trava real (backend)** — as 6 rotas `DELETE` (`app/api/{banks,
financial-accounts,chart-accounts,chart-account-groups,chart-account-subgroups,cost-centers}/[id]`)
usam **`requireAdminGroup`** (`lib/auth.ts`), que resolve o `group_id` do usuário via `service_role` e
devolve **403** fora do grupo. O gate de UI é só cosmético — a autorização é imposta no servidor.
**Distinto de `requireAdmin`** (papel `app_metadata.role='admin'`), que segue restrito a
`POST /api/users` (criar usuário): os dois convivem — papel `role` para gestão de usuários, **grupo**
para o hard delete. Constante `ADMIN_GROUP_ID = 1` espelhada no backend (`lib/auth.ts`) e no frontend
(`AuthContext.tsx`). **Escopo:** os 6 cadastros de Tabelas **e** o hard delete de conta em `/consulta`
(`DELETE /api/contas/:id` — ver "CRUD de contas"); `/fornecedores` segue **soft delete**. A remoção
PADRÃO de conta continua sendo `PATCH status_id=<cancelado>` — o hard delete é a exceção do grupo
Administrador (pedido do usuário).
Testes: `lib/auth.test.ts` (`requireAdminGroup`: 401/403/500 + grupo 1 segue), `AuthContext.test.tsx`
(gate por grupo), `CrudTablePage.test.tsx` (lixeira só p/ o grupo Administrador) + os 6 `route.test.ts`
(mock de `requireAdminGroup`).

**Grids dos cadastros = padrão do `/consulta` (gestão de colunas):** todos os grids de cadastro —
os **6 do grupo Tabelas** (`CrudTablePage` + a página autônoma `CostCentersPage`) **e** `/fornecedores`
(`SuppliersPage`) — ligam o mesmo conjunto do grid de `/consulta`: `enableColumnManagement` (toolbar:
mostrar/ocultar, **fixar**, **reordenar por arraste**, **redimensionar**, restaurar layout),
`defaultDensity="compact"`, `maxBodyHeight` (`70vh` → **cabeçalho fixo**) e `gridId` próprio
(preferências de layout persistidas em `localStorage` por tabela — ids `tabela-bancos`,
`tabela-contas`, `tabela-plano-de-contas`, `tabela-grupos-plano-de-contas`,
`tabela-subgrupos-plano-de-contas`, `tabela-centros-de-custo`, `tabela-centros-de-custo-plano`
(grid complementar do plano de contas — ver "Grid COMPLEMENTAR"), `fornecedores`). No `CrudTablePage` o
`gridId` é prop obrigatória, passada por cada página fina. **Não** ligam `enableSelection` (sem ação
em lote nesses cadastros) nem `enableRowVirtualization`/scroll infinito (a paginação é por botões
Anterior/Próxima) — decisão de escopo: o grid é o **mesmo componente** e a mesma experiência de
colunas/densidade, sem os recursos específicos do `/consulta` (volume + ações em massa).

**Ordenação SERVER-SIDE nos grids de cadastro (clique no cabeçalho):** o clique cicla
**asc→desc→nenhum** (`handleSort` idêntico ao do `/consulta`; reseta para a 1ª página) e a ordenação
é sempre **server-side** — `sort`/`order` viajam na query (`?sort=<col>&order=asc|desc`) até a Next
API. **Por que server-side:** os cadastros são paginados (20/página), então ordenar só a página
carregada seria incorreto. Wiring: `CrudTablePage` (5 cadastros) + `CostCentersPage`/`SuppliersPage`
(autônomas) mantêm o estado `{col,dir}` e o repassam à função `list`; o cliente HTTP
(`services/dataApi.ts` `dataApiListPaged` + as cópias de `costCenters.ts`/`suppliers.ts`) anexa
`sort`/`order` à query. No backend, cada `service.list`/`findAll` recebe `sort`/`order` e aplica
`.order(col)` **validando a coluna contra um allowlist por recurso** (`SORTABLE_COLUMNS`) via o helper
**`lib/sort.ts`** (`resolveSort` + `parseSortParams`); coluna fora do allowlist → ordem **default** do
recurso (defesa contra coluna inválida/injeção). As rotas só **encaminham** `...parseSortParams(sp)`
(verbatim) — o allowlist é responsabilidade do service. **Colunas de embed/JOIN são ordenáveis pela
descrição via a sintaxe do PostgREST `alias(coluna)`** (o `sortKey` usa o MESMO alias do `select`),
ordenando as linhas-pai pela coluna do recurso embutido (to-one) — assim a ordem casa o texto exibido.
Padrão herdado do `/consulta` (`sortKey:'supplier(trade_name)'`, `'cost_center(cost_center_description)'`,
`'chart_account(account_description)'`). Em `/tabelas/plano-de-contas` as 3 colunas de classificação
usam o mesmo: Centro de custo→`'cost_center(cost_center_description)'`, Grupo→`'group(group_description)'`,
Sub Grupo→`'subgroup(subgroup_description)'`. O valor do `sortKey` (literal, incluindo a forma
`alias(coluna)`) entra no `SORTABLE_COLUMNS` do service (allowlist — defesa contra coluna arbitrária);
quando o `select` NÃO inclui o alias, a coluna fica sem `sortKey` (ex.: `bank` em `/tabelas/contas`). Em
`suppliers`, o `sort` aceita também o alias legado **`name`** (lookup do modal de contas → `trade_name`
asc); colunas reais do grid usam `sort=<coluna>&order=`. Testes: `lib/sort.test.ts` (helper) e
`app/api/suppliers/route.test.ts` (encaminhamento).

| Cadastro | Sidebar / rota | Backend (`lib` + `app/api`) | Particularidades |
|---|---|---|---|
| `financial_bank` | **Bancos** `/tabelas/bancos` | `banks.ts` + `banks/**` | PK `bank_id` **NÃO identity** → `create` grava `max+1`. `bank_code` CHAR(3). Delete bloqueado se referenciado por `financial_account` |
| `financial_account` | **Contas bancárias** `/tabelas/contas` | `financial-accounts.ts` + `financial-accounts/**` | Contas bancárias/caixa (distinto de `/contas`=lançamentos). **Sem sentinela, sem FK reversa** → delete livre. `status_id`→**FK `status`** (migration 053; lookup `GET /api/statuses`; default 30="ativo"); `payment_type_id` **input numérico** (sem tabela de domínio); banco via lookup; saldo `NUMERIC` |
| `financial_chart_of_account` | **Plano de contas** `/tabelas/plano-de-contas` | `chart-accounts.ts` + estende `chart-accounts/**` | **GET dual-mode preserva a CASCATA** (sem `page` = lookup por centro, só postáveis — `lib/lookups`; com `page` = CRUD — `lib/chart-accounts`). FKs opcionais centro/**grupo** (`chart_account_group_id` — FK direta, migration 058)/subgrupo (0="não informado"); `account_level`/`is_postable`. **Grid** (ordem): Código · Descrição · Centro de custo · Grupo · Sub Grupo (Nível e Lançável saíram do grid — seguem no form). **Todas as 5 colunas são ordenáveis** (server-side; as 3 de classificação pela descrição do embed via `alias(coluna)`). Delete bloqueado por `financial_account_control`/`supplier` |
| `financial_chart_of_account_group` | **Grupos** `/tabelas/grupos-plano-de-contas` | `chart-account-groups.ts` + `chart-account-groups/**` | `group_type` CHAR(1) opcional. Delete bloqueado se referenciado por subgrupo |
| `financial_chart_of_account_subgroup` | **Sub grupos** `/tabelas/subgrupos-plano-de-contas` | `chart-account-subgroups.ts` + `chart-account-subgroups/**` | FK `chart_account_group_id` **obrigatória** (NOT NULL; 23503→422). Delete bloqueado se referenciado por plano de contas |

**Hierarquia:** grupo → subgrupo (`chart_account_group_id`) → plano de contas (`chart_account_subgroup_id`
+ `cost_center_id`). O plano de contas tem **também uma FK DIRETA ao grupo** (`chart_account_group_id`,
migration 058 — coexiste com a ligação indireta via subgrupo; embed `group` na grade/form, editável no
CRUD); banco → conta (`bank_id`). **Rotas dual-mode** (Bancos/Grupos/Sub grupos): com `page`
= CRUD paginado; sem `page` = lookup (lista completa p/ os `<select>`). **`MAX_LIMIT = 1000`** nesses
três services (igual a `lib/lookups.ts`) para o lookup não truncar o `<select>`; a paginação do CRUD
usa `DEFAULT_LIMIT`. **`GET /api/statuses`** (read-only,
`statusService` em `lib/lookups.ts`) alimenta o lookup de situação do form de Contas. Lookups no frontend:
`services/lookups.ts` (`listBanks`/`listChartAccountGroups`/`listChartAccountSubgroups`/`listStatuses` +
`listCostCenters`/`listChartAccounts`). Schemas Zod em `@sheild/shared` (`bank`/`financial-account`/
`chart-account`/`chart-account-group`/`chart-account-subgroup`). **Selects obrigatórios vazios** chegam
como `NaN` (`valueAsNumber`) e são **normalizados para 0** nos forms antes do `safeParse` (0 dispara o
`.min(1)` com a mensagem amigável). **Pendência conhecida:** `payment_type_id` é input numérico cru
(não há tabela de domínio no banco) — melhoria futura.

**Lookups de classificação contábil (cascata Centro de custo → Plano de contas):** cadastros
pré-existentes `financial_cost_center` (agora também gerenciado pelo **CRUD de centros de custo** acima)
e `financial_chart_of_account` (agora também gerenciado pelo **CRUD de Plano de contas** acima; o lookup
da cascata segue intocado — `GET /api/chart-accounts` sem `page`; este com FK
`cost_center_id`). Backend: `apps/api-backend/lib/lookups.ts` (`costCenterService`/`chartAccountService`,
service_role) + rotas `GET /api/cost-centers` e `GET /api/chart-accounts`. Cliente: `services/lookups.ts`
(`listCostCenters`/`listChartAccounts`). **Regra de cascata:** o plano de contas só lista os planos
**do centro selecionado** (`chartAccountService.list({ costCenterId })` filtra `cost_center_id`;
**sem centro → `[]` sem consultar o banco**, e `ChartAccountSelect` fica **desabilitado**). No
`ContaForm`, trocar o centro **zera o plano** (`handleCostCenterChange`) e o `ChartAccountSelect`
**remonta via `key={costCenterId}`** (reset visual sem `setState`-in-effect). Os planos só listam
`is_postable=true`, ordenados por `account_description`; os centros, por `cost_center_description`
(descartando o placeholder id 0). Os selects exibem **só a descrição** (fallback código → `#id`).

**Classificação default do fornecedor — sync bidirecional (migration 052):** `supplier` tem
`cost_center_id`/`chart_account_id` (SMALLINT NOT NULL DEFAULT 0, sentinela 0 = "não informado"),
e a classificação flui nos **dois sentidos**:
- **Default na criação (supplier → conta).** Ao incluir conta, a nova `financial_account_control`
  herda a classificação do fornecedor quando `> 0`. (a) **Modal create** (`ContaForm`): um efeito
  **só no modo `create`** chama `getSupplier(sk)` (`services/suppliers.ts` → `GET /api/suppliers/:sk`,
  que traz `cost_center_id`/`chart_account_id` + embeds) e semeia os selects de Centro de custo /
  Plano de contas (com rótulos); trocar o fornecedor **re-semeia** e o usuário pode alterar. Como
  `CostCenterSelect`/`ChartAccountSelect` inicializam `selected` uma vez (não sincronizam `value`),
  o pré-preenchimento entra na `key` deles via um **`prefillNonce`** que força o remonte. Edição
  **não** pré-preenche (usa a classificação da própria conta). (b) **Extração de e-mail**:
  `SupabaseControl.supplier_defaults(sk)` (`read_emails.py`) lê os defaults e `_finalize_supplier`
  os injeta no payload quando `> 0` (cobre PDF e corpo; `0`/ausente → o `DEFAULT 0` do banco assume,
  nunca enviamos `None`).
- **Write-back na gravação pelo modal (conta → supplier).** `contaService.create`/`update`
  (`lib/contas.ts`), **após** o write, gravam a classificação de volta no fornecedor via
  `setSupplierClassification(sk, cc, ca)` (`lib/suppliers.ts`, caminho dedicado fora do
  `supplierUpdateSchema`) **apenas quando `cost_center_id > 0` E `chart_account_id > 0`** — vale na
  **criação E na edição** pelo modal. **Best-effort**: falha no write-back loga (`console.error`) e
  **não** derruba a resposta da conta. A **extração Python não passa por esse service** → não faz
  write-back (só lê). Schema: `supplierSchema` (leitura) expõe `cost_center_id`/`chart_account_id`
  + embeds opcionais `cost_center`/`chart_account`; `findBySk` faz o JOIN.
- **Edição direta pelo CRUD de fornecedores (`/fornecedores`).** `cost_center_id`/`chart_account_id`
  **agora entram em `editableFields`** (POST/PATCH públicos de fornecedor) — o form de fornecedor
  (`SupplierForm`) traz os lookups **Centro de custo** e **Plano de contas** em CASCATA (mesmos
  `CostCenterSelect`/`ChartAccountSelect` do `ContaForm`; trocar o centro zera/recarrega o plano). O
  payload **sempre** envia os dois ids (`0` quando não informado), cobrindo definir **e LIMPAR** no
  modo edição (omitir não zeraria a coluna num PATCH parcial). Na edição, `SuppliersPage.openEdit`
  busca o fornecedor completo (`getSupplier` → `GET /suppliers/:sk`, com embeds) para rotular os
  selects; a lista (`GET /suppliers`) traz só os ids. O write-back do modal de contas
  (`setSupplierClassification`) **permanece** como caminho paralelo (grava só quando ambos `> 0`).
- **EXCEÇÃO — fornecedor de FUNCIONÁRIO NÃO carrega classificação default (migration 070 — não
  regredir):** quando o `trade_name` do fornecedor contém "funcionário"/"Funcionário" (sem acento/
  caixa, via `normalize_search LIKE '%funcionario%'`), `supplier.cost_center_id`/`chart_account_id`
  são **mantidos em 0** — a classificação de despesa de funcionário (reembolso/adiantamento) varia
  por conta, então um default no cadastro não faz sentido. Enforcement por **trigger**
  `trg_supplier_no_funcionario_classification` (BEFORE INSERT/UPDATE em `supplier`, força cc/plano=0)
  — fonte ÚNICA que cobre TODOS os caminhos de escrita: write-back do modal (`setSupplierClassification`),
  write-back da extração (`update_supplier_classification`), edição pelo CRUD (`/fornecedores`) e UPDATE
  direto (todos viram no-op para funcionário). A classificação por **conta**
  (`financial_account_control`) NÃO é afetada — só o default do fornecedor. Backfill único zerou os
  fornecedores de funcionário já classificados (ex.: "Josefa/Edvaldo/Tania (Funcionário)").

**Contato do fornecedor — telefone / WhatsApp / chave PIX (migration 082):** `supplier` tem
`phone_ddd1`/`phone1`/`phone_ddd2`/`phone2` (char(2)/varchar(9)), `whatsapp1`/`whatsapp2`
(varchar(11)) e `pix_key1`/`pix_key2` (varchar(77)) — **2 "slots" por tipo**, todos nullable,
escrita só por `service_role`. Dois caminhos de preenchimento:
- **Edição de fornecedores (`/fornecedores`, `SupplierForm`):** campos de texto simples;
  telefone/WhatsApp gravam só dígitos (strip de máscara no Zod, como cnpj/cpf), `pix_key` aceita
  e-mail/UUID. Entram em `editableFields` de `@sheild/shared` → fluem para create/update sem
  mudança no repositório (o `SELECT '*'` já os devolve).
- **Extração de e-mail (`read_emails.py`):** `parse_supplier_contacts(text, exclude_pix)` detecta
  do CORPO/assunto/descrição (decisão: NÃO toca no prompt do PDF) — chave PIX **só com rótulo
  "pix" por perto** (janela de 80 chars, `finditer` que pula candidato excluído; anti-falso-
  positivo), telefone por formato `(DD) NNNNN-NNNN`/rótulo (**DDD default 11** quando ausente) e
  WhatsApp por rótulo (**precede** o slot de telefone via `exclude_digits`). `apply_contact_writeback`
  roda após `apply_forced_classification` nos dois choke points (PDF `:3562`, corpo `:3723`),
  **não** toca no payload da conta, e chama `SupabaseControl.update_supplier_contact` — **lógica de
  2 slots** (espelha o trigger `_add_supplier_email`: preenche o slot 1; o 2 só quando o 1 tem
  OUTRO valor; no-op se já presente ou ambos cheios). Best-effort (falha loga, não derruba a
  conta); **pula OTIMOTEX (sk=1)**. O **CNPJ do pagador** (`payer_cnpj` + `company_cnpj()`) é
  **excluído** das chaves PIX — o bloco do pagador vem no corpo reencaminhado e pode ficar perto de
  "pix". WhatsApp É auto-detectado (além de editável no form). Testes:
  `tests/test_supplier_contacts.py` (parser + slots + guards).
- **Backfill retroativo:** `scripts/backfill_supplier_contacts.py` (`--dry-run`) varre todas as
  contas, agrupa por `sk_supplier` e grava com a mesma lógica de slot (idempotente; exclui o
  `company_cnpj()`). **Aplicado em 2026-07-16** (31 fornecedores; re-run reporta 0 mudanças).
- **Deploy:** copiar só `read_emails.py` (o `extract_pdf.py` NÃO muda — detecção é só do corpo); a
  migration 082 já vale para dev+prod (mesma Supabase). Validar: `py -3 -c "import sys;
  sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R;
  print(hasattr(R,'parse_supplier_contacts'), hasattr(R.SupabaseControl,'update_supplier_contact'))"`.

**Usuários / autenticação (`apps/api-backend/lib/users.ts` + `app/api/users|auth/**`):** sobre
o **Supabase Auth** — sem tabela própria, sem JWT customizado, sem bcrypt (regras de
`auth-specs.md`). `POST /api/users` cria usuário (**admin-only**, via `auth.admin.createUser`
com `email_confirm: true`; **SEM AUTO-REGISTRO** — exige `requireAdmin` (`lib/auth.ts`:
papel lido de `app_metadata.role === 'admin'`, campo controlado pelo servidor/Admin API;
**não basta estar logado** → `403` se não-admin; correção da auditoria de segurança §1 A-1)
além do middleware) → `201`
`{ id, name, email }`; `POST /api/auth/login` é **público** (exceção no matcher:
`/api/((?!health|auth/login).*)`) e devolve `{ access_token, expires_in }` via
`signInWithPassword`; `GET /api/users/me` usa `getAuthenticatedUser` (`lib/auth.ts`) → perfil.
Schema `createUserSchema` em `@sheild/shared` (reusa `loginSchema`). Nunca expõe `password_hash`.
Spec/template em `docs/prompts/api-users-auth-spec.md`.

**Auth das rotas Next (`apps/api-backend/middleware.ts` + `lib/auth.ts`):** o middleware
protege `/api/*` (matcher `/api/((?!health|auth/login).*)` — `/api/health` e `/api/auth/login`
ficam públicos) exigindo
`Authorization: Bearer <token>`. O token é validado contra o Supabase Auth (`auth.getUser`)
com a **chave anon** (`SUPABASE_ANON_KEY`, nunca a service_role); sem token/ inválido →
`401`, falha de validação → `500` (envelope `fail`). A lógica fica em `lib/auth.ts`
(`requireAuth`/`requireAdmin`/`requireAdminGroup`/`getBearerToken`, testável). `/api/emails/read` também chama
`requireAuth` no handler (defesa em profundidade, não só o middleware). Isso **não**
intercepta o caminho atual do frontend (leitura de e-mails fala com o Flask direto); cobre a
API de dados Next p/ a fase do portal.

**Modelo de papéis (decisão de design — ferramenta single-org):** **toda sessão autenticada
é confiável para operar o app** — qualquer usuário logado faz **criação/edição** (fornecedores,
contas, cadastros das Tabelas) e **consultas/dashboards**. As rotas de criação/edição usam só
`requireAuth` (sessão válida), **não** papel. **Duas exceções restritas:** (1) `POST /api/users`
(criar usuário) exige `requireAdmin` — papel lido de `app_metadata.role === 'admin'` (campo
controlado pelo servidor/Admin API; ver §1 A-1 da auditoria de segurança); (2) o **hard delete dos
6 cadastros do grupo Tabelas** exige `requireAdminGroup` — pertencer ao **grupo Administrador**
(`user_profile.group_id = 1`, migration 065; ver "Hard delete dos cadastros"). Fora dessas duas, não
há segregação de papéis no CRUD — se um projeto precisar de mais, abrir tarefa dedicada (RBAC
completo desenhado em `docs/design/permissoes-por-grupo.md`).

> **Recorte importante — "confiável" NÃO é "vê e edita tudo" (não confundir).** O modelo acima é
> sobre **papel/função**: nenhum CRUD é reservado a um cargo. Já a **visibilidade por LINHA** é uma
> dimensão à parte e ATIVA: o grupo com `user_group.sees_only_own_accounts` (hoje só o **Comercial**)
> só **vê** — e portanto só **edita** — as contas em que é dono, os e-mails/erros de que é remetente
> e os anexos correspondentes. A regra é imposta no BANCO (RLS 076/078/079/**080** no Storage e
> **081** no UPDATE) e na Next API (`canSeeConta`), não na tela. Os demais grupos (Financeiro,
> Diretor, Administrador…) veem e editam livremente a conta de qualquer usuário, anexos inclusos —
> como o modelo single-org prevê. Ver "Visibilidade de contas por dono".
**Cadastro de operadores:** crie no **Supabase Dashboard** (Authentication → Users → Add user,
com "Auto Confirm User"); operador comum **não** precisa de papel/`app_metadata` — só o usuário
que for criar outros via API precisa de `app_metadata.role: "admin"`. RLS (migrations 056/057)
não afeta o app: o CRUD escreve via Next API com **`service_role`** (ignora RLS); só a curadoria
inline (`has_invoice`/`has_bank_slip`/`status_id` em `financial_account_control`, `reviewed_at` em
`email_control`) é escrita direto pelo papel `authenticated`, via grants por coluna preservados.

**Grupos de usuário — permissões por grupo (FUNDAÇÃO + VÍNCULO aplicados; RESTO do RBAC DESENHADO,
não implementado):** existe a base para, no futuro, segregar acesso/visualização por grupo (o "abrir
tarefa dedicada" citado acima). **Aplicado (migration 063):** catálogo `public.user_group`
(`group_id` IDENTITY ALWAYS PK, `group_name` VARCHAR(30) DEFAULT ''; **id 0 = sentinela "não
informado"**; RLS read `authenticated`/write `service_role`) + backfill `app_metadata.group_id=0`
nos usuários existentes. **`user_group` é editado EXCLUSIVAMENTE via Supabase** (SQL Editor/
Dashboard) — **sem CRUD no app** (o frontend só lê o catálogo); preservar em limpezas de dados.
**Aplicado (migration 065) — vínculo usuário→grupo por FK real:** `public.user_profile`
(`user_id` PK → `auth.users(id)` ON DELETE CASCADE; `group_id` SMALLINT NOT NULL DEFAULT 0 →
`user_group`; RLS SELECT restrita a `auth.uid() = user_id`, write `service_role`) + trigger
`handle_new_user` (AFTER INSERT ON `auth.users`, SECURITY DEFINER → cria perfil com group_id=0) +
backfill dos usuários atuais. **`user_profile` é a FONTE DE VERDADE** do vínculo (supersede o claim
`app_metadata.group_id` da 063, que **não** é sincronizado — reconciliar no enforcement futuro).
Atribuição é feita **via Supabase** (`UPDATE public.user_profile SET group_id=… WHERE user_id=…`;
sem tela de admin). Classificações atuais: `ricardo@sheild.com.br`=1 (Administrador),
`barbara@otimotex.com.br`=7 (Financeiro), demais=0. **Preservar `user_profile` em limpezas.** O nº
064 do repo já era `additional_info` → o user_profile virou **065** (roadmap renumerado 066–068).
**Resto do RBAC — desenhado, ainda NÃO implementado** (blueprint em
[docs/design/permissoes-por-grupo.md](docs/design/permissoes-por-grupo.md)): permissões via
`permission(resource,action)` + `group_permission` (cobre tela/menu **e** CRUD); visibilidade por
linha via `group_company`/`group_cost_center`/`group_chart_account` (empresa + centro de custo +
plano de contas). **Semântica RLS:** dimensão sem linhas = vê tudo (restrição opt-in), dimensões com
AND, bypass `service_role`/`app_metadata.role='admin'`. Enforcement por camada: `view`=menu
(frontend esconde + guarda rota) · CRUD=Next API `requirePermission` (escrita é `service_role`, RLS
não pega) · linha=RLS em `financial_account_control`. Roadmap restante: migrations 066–068 + helpers
`belongsToGroup`/`requirePermission` em `lib/auth.ts` + menu no `Layout.tsx`. Ler o blueprint antes
de implementar.

**Vínculo usuário → EMPRESA: NÃO EXISTE — implementado e REVERTIDO em 2026-07-17 (não reimplementar
sem pedido explícito):** chegou a existir uma migration `084_create_user_company.sql` (tabela N:N
`user_company` — `user_id` + `sk_company`, RLS, REVOKE, extensão do `handle_new_user` e backfill),
mais `getUserCompanies()` em `lib/auth.ts` e `skCompanies` no `AuthContext`. **Tudo foi desfeito a
pedido do usuário** ("não vou mais trabalhar com identificação de company nos usuários"): a tabela
foi dropada, o `handle_new_user` restaurado à versão da 065 e o código/doc revertidos — verificado
sem resíduo (0 objetos `user_company` no catálogo; nenhuma referência no repo). (O nº 084 foi
liberado e **já reutilizado** pela regra LEBIANCO — próxima = 085.) **Não "ajude" recriando isso.**
Se o tema voltar: o blueprint aprovado
(`docs/design/permissoes-por-grupo.md`) roteia empresa **pelo GRUPO** (`group_company`; decisão
travada 1 = "o único vínculo direto do usuário é o grupo") — a tentativa revertida divergia dele ao
vincular por usuário. Hoje o único vínculo do usuário é `user_profile.group_id`.

**Visibilidade de contas por DONO, por grupo (Etapa 1 APLICADA — migration 076):** primeira
dimensão de visibilidade por linha efetivamente em produção (independente do blueprint acima, que é
por empresa/centro/plano). Cada `financial_account_control` tem **`created_by`** (UUID → `auth.users`,
NOT NULL DEFAULT sentinela `teste@otimotex.com.br` `fe8d268d-…`, FK `ON DELETE SET DEFAULT`) = o DONO.
**Preenchimento (server-side, nunca do corpo do cliente):** UI nova conta → Next API carimba o
usuário logado (`getAuthenticatedUser(req).id`, `contaService.create(raw, userId)` em `lib/contas.ts`;
POST usa `getAuthenticatedUser`, não `requireAuth`); extração → `SupabaseControl.resolve_user(sender_email)`
(RPC `resolve_user_for_account`, sentinela quando não casa) injetado no `register_financial`; fallback
= DEFAULT da coluna. **Restrição por grupo (opt-in):** flag `user_group.sees_only_own_accounts` (só
**Comercial=6** ligada; **Financeiro=7** e demais = false → veem tudo). **Enforcement por RLS SELECT**
de `financial_account_control`: `USING (NOT public.auth_group_sees_only_own() OR created_by = auth.uid())`
— cobre `/consulta` (grid + busca) e `/dashboard`, que leem via `authenticated`; `service_role`
(Next API/Python) mantém bypass. **Estendido a `/emails` e `/erros` (migration 078):** as policies
SELECT de `email_control` e `email_processing_errors` usam a MESMA flag/helper, porém casando o
REMETENTE com o e-mail do logado — `USING (NOT public.auth_group_sees_only_own() OR
lower(sender_email) = lower(auth.email()))`. Diferença intencional de chave: `/consulta` casa por
`created_by` (UUID resolvido, com sentinela); `/emails` e `/erros` casam o TEXTO `sender_email`
diretamente com `auth.email()`. Linhas com `sender_email` NULL ficam ocultas para usuários restritos
(hoje não há nenhuma). A policy de UPDATE de `email_control` (grant só de `reviewed_at`) não mudou.
**Re-varredura ao criar usuários (operacional):** o backfill do
`created_by` é ponto-no-tempo — contas históricas de um usuário criado DEPOIS ficam no sentinela até
uma re-varredura. Ao cadastrar usuário novo, rodar (via Supabase MCP/SQL Editor) para re-atribuir só
as divergentes (idempotente; preserva `updated_by`/`status_changed_by`):
`UPDATE financial_account_control f SET created_by = public.resolve_user_for_account(f.sender_email)
WHERE f.created_by IS DISTINCT FROM public.resolve_user_for_account(f.sender_email);`
(aplicado em 2026-07-10: 40 contas movidas do sentinela p/ estela/rose/bruna após esses usuários
surgirem; estado final 0 divergências).

**Auditoria de autor (Etapa 2 APLICADA — migration 077):** além do `created_by` (dono), a conta
registra **`updated_by`** (último editor) e **`status_changed_by`/`status_changed_at`** (quem/quando
mudou a situação) — todos UUID → `auth.users`, NOT NULL DEFAULT sentinela. Carimbo pela trigger
**`trg_fac_authorship`** (`fn_stamp_account_authorship`, SECURITY DEFINER): no INSERT `updated_by`/
`status_changed_by` := `created_by`; no UPDATE `updated_by` := `coalesce(auth.uid(), NEW.updated_by,
OLD)` e, quando `status_id` MUDA, `status_changed_by`/`_at` idem. **Cobre os 3 caminhos:** curadoria
REST direta (`authenticated` → `auth.uid()`); Next API PATCH (`contaService.update(raw, userId)` +
`getAuthenticatedUser` no handler → `updated_by` explícito, service_role sem `auth.uid()`); Python
(insert herda `created_by`). O trigger roda **antes** de `trg_fe_status_vencimento` (nome `trg_fac_*`
< `trg_fe_*`), então vê o `status_id` do humano, não o recálculo automático por vencimento.
**Exibição:** o card de detalhe de `/consulta` mostra **Criado por / Última edição por / Situação
alterada por** (e-mail resolvido pela view **`public.app_user`** via `getAppUsers()` — diretório
id→e-mail, grant de **SELECT** para `authenticated`, usuários internos; a ESCRITA foi revogada na
081 — a view rodava como owner e era auto-atualizável, então o grant default virava escrita em
`auth.users`: ver "ESCALADA DE PRIVILÉGIO pela view `app_user`"). `created_by`/`updated_by`/
`status_changed_by`/`status_changed_at` estão no schema de LEITURA de `@sheild/shared` (nunca no
input — carimbados pelo servidor/trigger). **"Última edição por" e "Situação alterada por" são
OMITIDOS quando o autor é o SENTINELA** (`teste@otimotex.com.br` / UUID `fe8d268d-…`, o DEFAULT de
`updated_by`/`status_changed_by`) — não representam uma edição de um usuário real (`isSentinelAuthor`
em `Consulta.tsx`, checa por UUID e por e-mail resolvido). "Criado por" permanece sempre.

**Visibilidade do STORAGE por dono (migration 080 — não regredir):** a regra "grupo restrito só vê
as contas em que é dono" vale **também para o bucket** (decisão do usuário, 2026-07-15). A policy da
021 era `USING (bucket_id = 'attachments')` — sem filtro de dono; ela nasceu antes da visibilidade
por grupo, e a 076/079 restringiram conta/anexo mas o bucket ficou aberto. **Verificado com o papel
`authenticated` real:** ester (Comercial) via 36 contas / 26 anexos pela tela e **565 objetos** no
Storage — e a chave é obtível (`GET /api/contas/:id` devolve `source_file`; `/attachments` devolve
`storage_key`; ambas via service_role, que ignora a RLS). A 080 libera o objeto só quando existe
uma linha **visível para o próprio usuário** — `EXISTS` em `financial_account_attachment.storage_key`
**OU** em `financial_account_control.source_file`. As subconsultas são avaliadas como `authenticated`,
então a RLS da 076/079 se aplica DENTRO delas: a policy **herda a regra sem duplicar o predicado de
dono** (visível no `EXPLAIN`: o filtro `auth_group_sees_only_own() OR created_by = …` aparece dentro
do SubPlan). Resultado: Comercial 565→**20** objetos (**0** de contas alheias), Financeiro 565→**233**
(nenhum a menos); `service_role` inalterado.
- **Os DOIS `EXISTS` são necessários:** o de `source_file` cobre o anexo do e-mail cuja linha não
  existe (o registro no reader é NÃO-FATAL) — é o fallback `legacySourceFile` da UI. Sem ele, esse
  anexo pararia de abrir.
- **332 dos 565 objetos ficam invisíveis pela API** (não casam nenhuma linha: PDF que subiu no Passo
  1 e cuja conta nunca foi criada — CT-e ignorado, extração falhou, não-pagável). Já eram
  inalcançáveis pela UI, e o pipeline (`service_role`) segue enxergando para reprocessar.
- **Índice `ix_fac_source_file`** (parcial, `WHERE source_file IS NOT NULL`): a policy roda a CADA
  download; sem ele o `EXISTS` viraria seq scan em `financial_account_control`. O lado do anexo usa
  o `ix_faa_storage_key` da 079. Medido: ~3,7 ms com os dois índices em uso.

**`canSeeConta` — a Next API respeita a visibilidade por dono (`lib/auth.ts` — não regredir):** a
Next API lê/escreve com **service_role, que IGNORA a RLS**, então um usuário de grupo restrito que
forçasse um id alheio recebia (e editava) a conta de outro, embora a tela e o Storage (080) já a
escondessem. `canSeeConta(req, id)` faz a checagem com o **token do próprio usuário** (chave anon +
`setHeader('Authorization')` na query) — a regra fica ONDE já está, na policy da 076, em vez de
reimplementada em TS (2ª fonte de verdade fadada a divergir); quando o blueprint trouxer novas
dimensões (empresa/centro/plano), o guard as herda de graça. Aplicado em **`GET`/`PATCH`
/api/contas/:id** e nas **3 rotas de anexo** (`GET`/`POST` attachments, `POST` upload-url, `DELETE`
attachments/:attId). Responde **404, não 403** — 403 revelaria que a conta existe. Regra: **quem não
pode VER não pode EDITAR**. O `upload-url` sem o guard entregaria uma credencial de ESCRITA no
Storage para a conta de outro.

**Escrita direta por `authenticated` — RLS alinhada à visibilidade (migration 081 — não regredir):**
o frontend escreve DIRETO no PostgREST (sem passar pela Next API, logo sem `canSeeConta`) em dois
pontos: a curadoria inline de `/consulta` (`has_invoice`/`has_bank_slip`/`status_id`) e o "revisado"
de `/emails` (`reviewed_at`). Aí quem manda é a RLS — e as duas policies de UPDATE eram
**`USING (true)`**: um usuário de grupo restrito alterava a curadoria de QUALQUER conta por um PATCH
forjado por id (verificado: ester conseguia marcar NF nas 407 contas; agora **0** alheias). A 081
troca o predicado pelo **mesmo do SELECT** (076 em `financial_account_control`; 078 —
`lower(sender_email) = lower(auth.email())` — em `email_control`), com `WITH CHECK` idêntico.
- **A curadoria por CLIQUE continua funcionando** (requisito do usuário): o predicado é o mesmo do
  SELECT, então o usuário edita exatamente as linhas que a tela mostra. Verificado: ester marca
  NF/BOL/situação nas **36** contas dela e em **0** alheias; barbara (Financeiro, irrestrita) segue
  editando as **412**. `/emails`: 31 próprios × 0 alheios.
- **Os GRANTs por coluna (030/033/068) são intocados** e continuam sendo o que limita o QUE é
  gravável (`has_invoice`/`has_bank_slip`/`status_id`; `reviewed_at`). Um `REVOKE UPDATE` nessas
  duas tabelas os derrubaria e quebraria a curadoria — por isso a 081 revoga só `INSERT, DELETE`
  ali (e é por isso que a 057 não as tocou).

**ESCALADA DE PRIVILÉGIO pela view `app_user` — FECHADA (migration 081; a mais grave até aqui):**
a view da 077 (`SELECT id, email FROM auth.users`) tem `security_invoker = false` — roda como o
OWNER e ignora a RLS de `auth.users`, o que é **necessário** para o `/consulta` resolver o e-mail do
autor. O problema era o outro lado: view simples é **auto-atualizável** (`is_updatable = YES`) e o
Supabase concede grants DEFAULT de escrita ao papel. Verificado com o papel `authenticated` real —
ester (Comercial, o grupo MAIS restrito) rodou
`UPDATE public.app_user SET email='invadido@…' WHERE email='ricardo@sheild.com.br'` e alterou **1
linha em `auth.users`**: qualquer usuário logado podia trocar o e-mail de qualquer outro (inclusive
do Administrador) e tomar a conta via "esqueci minha senha". O `DELETE` só não passou por uma FK
acidental (`status_changed_by`) — usuário sem contas seria apagável. Fix: `REVOKE INSERT, UPDATE,
DELETE ON public.app_user FROM authenticated, anon` (a view é read-only por natureza; o
`security_invoker=false` PERMANECE, senão o autor some da tela — `auth.users` não tem policy para
`authenticated`). Verificado: `42501 permission denied for view app_user`, e a leitura segue (12
usuários). **Lição:** toda VIEW nova sobre `auth.*`/dado sensível precisa de REVOKE explícito de
escrita — o default do Supabase é permissivo e a RLS da tabela-base NÃO protege uma view
`security_invoker = false`.

**Escala futura (fora das Etapas 1–2):** `auth_is_admin()` (bypass por papel) e as dimensões de
visibilidade do blueprint (`docs/design/permissoes-por-grupo.md`: empresa/centro/plano).

**Erros 5xx não vazam detalhe interno (segurança §3 M-2):** os route handlers de CRUD usam
`failFromError(e, '<tag>')` (`lib/response.ts`) — erro com `status` 4xx ecoa a mensagem
curada; 5xx (ou sem status) vira `'Erro interno ao processar a solicitação'` e o detalhe
(mensagem crua de Postgres/PostgREST) vai só para o **log do servidor** (`console.error`).
Não reintroduzir `fail(e.message, 500)` nos handlers.

### 4 — Conventional Commits (todo o projeto)

**Todos** os commits — frontend, backend, scripts, infra — seguem o formato:

```
tipo(escopo): mensagem em português ou inglês
```

| Tipo | Quando usar |
|---|---|
| `feat` | nova funcionalidade |
| `fix` | correção de bug |
| `test` | adição/correção de testes |
| `docs` | documentação (incluindo CLAUDE.md) |
| `chore` | manutenção, deps, configs |
| `refactor` | refatoração sem mudança de comportamento |

Escopo = área afetada: `login`, `email-reader`, `consulta`, `scheduler`, `migrations`, etc.

**Nomenclatura de Pull Request:** se o usuário informar o nome do PR, usar exatamente esse.
**Quando o usuário NÃO informar o nome (ou disser "pr seu nome"), o Claude escolhe** um
título descritivo do escopo (não genérico, não a numeração `#N`) e abre o PR direto — **não
perguntar**. PRs seguem de `Features` → `main` (ver "GIT STRATEGY" do workspace).

### 5 — Lint limpo e análise estática

> **O `npm run lint` verde NÃO garante o PR verde:** o ESLint local e o **SonarCloud** do CI têm
> conjuntos de regras DIFERENTES, e o Sonar **reprova o merge** (quality gate). Ex. real: o
> `<div onClick={…}>` do PR #129 passou no lint e foi barrado pelo Sonar (S1082).
> Ver "SonarCloud no CI" abaixo.

- **`npm run lint` na raiz deve passar com 0 erros e 0 warnings** em todos os workspaces
  (cobre `frontend-vite`, `api-backend`, `portal-next` **e `packages/shared`** — cada um com
  seu `eslint.config.mjs`). O `packages/shared` usa flat config type-aware **sem React**
  (`@eslint/js` + `typescript-eslint` `recommendedTypeChecked`, `globals.node`, glob `**/*.ts`
  para o próprio `eslint.config.mjs` ficar fora do lint type-aware) — binários resolvidos por
  hoist. O shared **não** tem `prune` (ver nota do ts-prune abaixo).
- **Versões de ESLint divergem por workspace (intencional):** `frontend-vite` usa **ESLint 10**
  (+ `typescript-eslint@8.61`); os apps Next ficam em **ESLint 9** porque o
  `eslint-config-next` depende de um `eslint-plugin-react` que quebra no ESLint 10 (`getFilename`
  removido). Carve-out documentado em `eslint10-next-carveout` (memória) — subir quando o
  upstream suportar ESLint 10.
- **Regras do React Compiler ativas** (`eslint-plugin-react-hooks@7` `recommended`): pureza de
  render, `set-state-in-effect`, etc. Disables justificados (`// eslint-disable-next-line
  react-hooks/...`) onde o effect é a ferramenta correta — `void load()` (fetch-on-change em
  `Consulta`/`Emails`/`Erros`), reconcile de prefs (`useGridPreferences`) e `incompatible-library`
  do `@tanstack/react-table` (`DataGrid`). Padrões corrigidos de verdade: sincronizar prop no
  render (não em effect) e não chamar funções impuras (`Date.now`) no escopo de render.
- **Transform de build do React Compiler HABILITADO** (`vite.config.ts`): memoiza
  componentes/hooks automaticamente. No `@vitejs/plugin-react@6` (oxc/Rolldown) entra via
  `@rolldown/plugin-babel` + `reactCompilerPreset()` (peers: `@rolldown/plugin-babel`,
  `@babel/core`, `babel-plugin-react-compiler@1`, `@types/babel__core`) — **não** pelo antigo
  `babel` option do plugin. Alvo React 19 (runtime embutido `react/compiler-runtime`); o
  compiler faz "bail out" seguro em código incompatível (ex.: `useReactTable` no `DataGrid`).
  Confirma-se no bundle pela presença de `useMemoCache`.
- **`frontend-vite`** usa flat config type-aware (`typescript-eslint` + `react-hooks` +
  `react-refresh`). Ajustes deliberados, **manter**: `no-misused-promises` com
  `checksVoidReturn: { attributes: false }` (handlers async em `onClick`/`onSubmit` são
  idiomáticos); regras `no-unsafe-*` desligadas só em `*.test.tsx` (mocks tipados `any`).
  Promessas fire-and-forget (`load()` em `useEffect`) levam `void` explícito.
- **`tsconfigRootDir`**: todo `eslint.config.mjs` ancora `parserOptions.tsconfigRootDir:
  import.meta.dirname` — não remover, é o que evita o erro "No tsconfigRootDir was set" no
  editor. Nos apps Next, **não** habilitar `projectService: true` (quebra o parsing dos
  `*.config.mjs`); apenas `tsconfigRootDir`.
- **`.vscode/settings.json` (não remover)**: o monorepo só tem flat config **por-app**
  (sem `eslint.config` na raiz). Sem `eslint.workingDirectories: [{ "mode": "auto" }]` a
  extensão ESLint roda com cwd na raiz, não acha config e acusa "couldn't find an
  eslint.config file" / "No tsconfigRootDir was set" nos componentes. O `mode: auto` faz a
  extensão rodar com cwd em cada app.
- **ts-prune (dead code / exports órfãos)**: `npm run prune` na raiz roda nos **3 apps**
  e **deve reportar 0**. `ts-prune` está declarado só em `frontend-vite` (resolvido por
  hoist nos apps Next). Os apps Next ignoram os defaults do framework via
  `--ignore "next.config|...|app.*(page|layout|route)"`. **`packages/shared` deliberadamente
  NÃO tem `prune`**: sendo um pacote de barrel (biblioteca pura cuja API é consumida
  cross-package via `@sheild/shared`), o ts-prune isolado reportaria **toda** export pública
  como órfã (falso positivo). A cobertura de uso real vem do `prune` dos apps consumidores;
  no shared fica só `lint` + `typecheck`. Export público intencional **sem
  consumidor** (scaffolding da camada CRUD ou contrato de tipo consumido por inferência —
  `getSupabaseAdmin`, `ApiResponse`/`ApiResponseMeta`, `ReaderSummary`/`TriggerReaderOptions`)
  leva `// ts-prune-ignore-next` na linha acima, documentando a intenção. Não deixar export
  morto de verdade: removê-lo (foi assim que saíram o hook `useGridColumns` e os
  `scripts/_check_*.py`).
- **Python — `vulture`** (`py -3 -m vulture server/ skills/ scripts/ --min-confidence 60`):
  caça funções/variáveis mortas. Rotas Flask decoradas (`@app.get`/`@app.post`) aparecem
  como "unused function" — **falsos positivos**, ignorar.
- **SonarLint** (engine da IDE, sem CLI): manter o código livre dos achados recorrentes —
  condições positivas em vez de negadas com `else` (S7735: `v == null ? '—' : …`), par
  `[x, setX]` no `useState` (S6754), sem ternário/template literal aninhado no JSX (S3358/
  S4624 — extrair para uma const antes do `return`), sem import não usado (S1128), sem
  seletor booleano que escolhe a ação dentro do método (S2301 — preferir uma única ação
  com valor por ternário, ex.: `setItem(key, on ? '1' : '0')` em vez de `if/else` com
  `setItem`/`removeItem`), e sem texto solto logo após um elemento inline em JSX (S6772 —
  envolver o texto em `<span>`, ex.: `<input … /><span>Lembrar-me</span>`).
  Também recorrentes: props de componente React como `Readonly<…>` (S6759 —
  `{ children }: Readonly<{ children: ReactNode }>`); função com complexidade cognitiva
  >15 (S3776 — extrair helpers, ex.: o laço de `reprocess_link_emails.py` virou
  `_process_row`/`_first_pdf`/`_store_pdf`); `logging.exception()` em vez de `logging.error()`
  dentro de `except` (S8572); e f-string sem campo de substituição (S3457 — usar string
  normal). Mais um recorrente, achado no PR #129: **handler de clique em elemento
  NÃO-INTERATIVO** (S1082 — `<div onClick={…}>`, `<dialog onClick={…}>`); a saída é pôr o
  handler no `<button>`/`<a>`, não adicionar um `onKeyDown` inútil ao lado (ver "Contenção do
  clique" em "Anexos de conta").
- **SonarCloud no CI — BARRA o PR (não é só a IDE):** além do SonarLint local, o repositório tem
  a integração **SonarCloud** (projeto `SHE-ADM_email-financeiro`), que roda a cada PR e **reprova
  o merge** pelo quality gate — o `npm run lint` local passa e o PR fica vermelho assim mesmo. A
  condição que mais morde é **`new_reliability_rating > 1`**: UM único BUG no código novo (mesmo
  MINOR) já reprova. Não há workflow em `.github/workflows/` (é o app do GitHub); consulte o
  motivo pela API pública, sem token:
  ```bash
  node -e "fetch('https://sonarcloud.io/api/qualitygates/project_status?projectKey=SHE-ADM_email-financeiro&pullRequest=<N>').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.projectStatus,null,1)))"
  node -e "fetch('https://sonarcloud.io/api/issues/search?componentKeys=SHE-ADM_email-financeiro&pullRequest=<N>&types=BUG&resolved=false').then(r=>r.json()).then(j=>j.issues.forEach(i=>console.log(i.component,i.line,i.message)))"
  ```
  (o `curl` do Git Bash falha no TLS do sonarcloud.io — use `node -e` com `fetch`.) Antes de
  concluir que é ruído, confira se PRs anteriores passavam (`gh pr view <N> --json
  statusCheckRollup`): se passavam, o achado é seu.

### 6 — Acessibilidade (WCAG 2.1 AA)

Alvo: **WCAG 2.1 Nível AA** em todas as telas. Regras práticas:

- **Todo controle de formulário tem nome acessível + `id`/`name`.** Inputs/selects de filtro
  recebem `aria-label` (nome para leitores de tela e para o axe) **e** `id`/`name` (resolve
  o alerta de autofill do Chrome). Campos com label visível usam `<label htmlFor>` ligado a
  um `id` — ver `FilledTextField`/`AuthInput`, que geram `id` via `useId` e associam o erro
  por `aria-invalid` + `aria-describedby`. Botão só-ícone leva `aria-label` (ex.: olho de
  senha).
- **Contraste**: pares texto/fundo cumprem AA — texto normal ≥4.5:1, texto grande/ícone de
  UI ≥3:1. Ao criar ou alterar um token de cor, **validar o ratio** (controles desabilitados
  são isentos pela 1.4.3). Em **superfícies escuras** (sidebar `bg-sidebar`) o texto deve ser
  **claro**: `slate-300/400`, não `slate-500/600` (estes invertem e reprovam). `text-white`
  sobre `bg-brand` sólido reprova (3,4:1) — usar `bg-brand-dark` quando houver texto branco.
- **Testes a11y automatizados (jest-axe, AA)**: matcher em `tests/setup.ts`
  (`expect.extend(toHaveNoViolations)`); runner configurado em `tests/axe.ts` (tags
  `wcag2a/2aa/21a/21aa`). Todo componente/página relevante ganha um `*.a11y.test.tsx` com
  `expect(await axe(container)).toHaveNoViolations()`. Páginas com serviços mockam os
  serviços (ver `pages/Consulta.a11y.test.tsx`, `pages/Emails.a11y.test.tsx`).
- **Contraste é travado por teste** em **dois guardas** que compensam o axe em **jsdom** não
  avaliar `color-contrast` (regra desligada em `tests/axe.ts`):
  - `tests/contrast.a11y.test.ts` — pares dos **tokens do projeto** (`loginGreen-*`, `status-*`),
    lendo os `--color-*` do bloco `@theme` em `src/index.css` (fonte de verdade v4 CSS-first;
    parse via regex) e falhando abaixo do mínimo AA.
  - `tests/contrast-usage.a11y.test.ts` — pares das **cores default do Tailwind em uso** como
    texto/ícone (`gray/slate/zinc/amber/orange…`) sobre seus fundos reais. Mantém um array
    `COMPLIANT` (asserção dura, não regride) e um padrão de **ratchet** documentado: uma nova
    cor de baixo contraste vai para um `KNOWN_VIOLATIONS` verificado com `it.fails` (suíte segue
    verde, dívida visível) e, ao corrigir, sobe para `COMPLIANT`. Texto AA ≥4.5:1 · ícone/UI ≥3:1;
    ao introduzir cor default escura, **subir o tom** (ex.: `*-400`→`*-500`/`amber-600`) em vez de
    relaxar o threshold.
- **Camada de acessibilidade em NAVEGADOR REAL** (Playwright + `@axe-core/playwright`) — cobre o
  que o jsdom não vê: contraste sob render efetivo, ordem de foco e autofill. Config em
  `playwright.config.ts`, specs em `e2e/*.a11y.e2e.ts` (`public-auth` = login/forgot/reset sem
  login; `protected` = `/consulta`/`/emails`/`/erros`/**`/dashboard`** atrás de `A11Y_TEST_EMAIL`/
  `A11Y_TEST_PASSWORD`, pulado sem credencial — o Dashboard entrou no scan pelo achado A3-8),
  helper `e2e/axe.ts` (tags AA). O reporter do `axe.ts` emite, por nó, o **`failureSummary`**
  (para color-contrast: `foreground`/`background`/`ratio`/esperado) **+ o HTML do elemento**, além
  do seletor — a falha fica depurável só pelo **log do CI** (essencial, já que o navegador não
  roda no sandbox do agente). Scripts `test:e2e`/`test:e2e:headed`. Os
  specs **não** rodam no `npm test` (runner separado, fora do `tsconfig`/ESLint — `e2e/` está nos
  `ignores`). Ver `e2e/README.md`. O **workflow `.github/workflows/a11y.yml`** roda a camada a cada
  PR/push na `Features` (runner `ubuntu-latest`, Chromium provisionado), com os 4 secrets cadastrados
  (`VITE_SUPABASE_URL`/`ANON_KEY` + `A11Y_TEST_EMAIL`/`PASSWORD`, este último um usuário de teste
  só-leitura no Supabase). **Não rodar `npm run test:e2e` no sandbox do
  agente** — o renderer do Chromium crasha ao montar a SPA completa (limite de recursos do ambiente,
  não do código); validar na máquina do usuário ou no CI. A camada já **pegou e corrigiu 45 violações
  de contraste** nas páginas protegidas (sidebar/cabeçalhos/grid/toolbar) que os guardas por token e o
  jsdom não viam — ver "Guia de cores — grid de dados".
- **Achados de a11y do navegador corrigidos em 2026-07-08 (não regredir):** a suíte esteve
  **vermelha ~5 dias** por causas que só o axe em navegador via:
  - **Sidebar transbordava sobre o `<main>` branco.** O `<nav>` era `flex-1` **sem overflow**; com
    todos os itens (19 links + 5 grupos) o conteúdo excedia o viewport e os últimos itens + o rodapé
    (avatar/e-mail) caíam sobre o fundo BRANCO do `<main>`, onde `text-slate-400` dá 2,57:1.
    Fix (`Layout.tsx`): `nav` = **`flex-1 min-h-0 overflow-y-auto`** — rola DENTRO da sidebar escura
    (`bg-sidebar`, ~7:1). **Não** remover o `min-h-0`/`overflow-y-auto`.
  - **Corpo do Dashboard = região rolável sem acesso por teclado** (`scrollable-region-focusable`,
    WCAG 2.1.1). Ao conter a sidebar, o layout de altura passou a constringir o corpo, que agora ROLA
    de fato; diferente de `/consulta`/`/emails` (grids com botões/checkboxes focáveis DENTRO da
    região), o Dashboard só tem cards/gráficos não-focáveis. Fix (`Dashboard.tsx`): o container
    `overflow-y-auto` ganhou **`tabIndex={0}` + `role="region"` + `aria-label`**.
  - **Contraste do Dashboard sobre fundo claro:** legenda do donut `text-slate-400`→**`slate-600`**
    (2,57:1 sobre card branco) e a linha "vence …" da lista de prioridades `text-slate-500`→
    **`slate-600`** (4,35:1 sobre `bg-status-error-bg` #fef2f2 nas linhas críticas). Regra geral em
    fundo CLARO: secundário mínimo `slate-600` quando puder cair sobre tinta (não `slate-400/500`).

---

## Padrão de execução e robustez técnica

**Fonte completa: [docs/padrao-execucao.md](docs/padrao-execucao.md)** — ler antes de reportar
qualquer rotina como concluída. Não afirmar "está tudo ok" sem ter executado a verificação.

Resumo dos gates (detalhe no doc): **aceite** — nulos/vazios/edge cases explícitos, controle
transacional (commit/rollback, sem recurso vazado), exceção com log/rastreabilidade (nunca
`except`/`catch` vazio), validação de contratos (Zod é fonte única), e checagem de regressão
(`npm test`/`pytest`). **Padrões por stack** — Python, TS/React 19/Next 16, PostgreSQL/Supabase,
Firebird 5 (`fdb`), DW/ETL idempotente e PowerShell. **Fechamento** — autorrevisão adversarial
("o que quebra isto?") + escopo reforçado em alto risco (migrations, transação, ETL, concorrência,
deploy manual — nunca `deploy-prod.ps1` sem pedido).

---

## Autenticação (Supabase Auth)

O acesso às rotas internas (`/emails`, `/consulta`, `/erros`) exige login.

- **Sem auto-cadastro**: usuários criados apenas pelo admin no Supabase Dashboard
  (`Authentication → Users → Add user`, com "Auto Confirm User" marcado).
  `supabase.auth.signUp()` nunca é chamado pelo frontend.
- **Alterar o e-mail de um usuário — use a Admin API, NUNCA `UPDATE` em `auth.users`
  (não regredir):** o e-mail vive em **dois lugares** (`auth.users.email` e
  `auth.identities.identity_data->>'email'`); um `UPDATE` via SQL atualiza só o primeiro e
  deixa a identidade inconsistente. O caminho correto é
  `PUT /auth/v1/admin/users/:id` (ou `auth.admin.updateUserById`) com
  `{ email, email_confirm: true }` — o `email_confirm` pula a confirmação por link, exigida
  de outra forma pelo "Secure email change" (ON neste projeto). **Preservado
  automaticamente:** o `id` (UUID) não muda, então senha, `app_metadata.password_changed`,
  grupo (`user_profile.group_id`) e a autoria das contas (`created_by`/`updated_by`/
  `status_changed_by`) sobrevivem intactos. **O que EXIGE atenção** são as duas regras que
  casam por **TEXTO** do e-mail, não por UUID: (1) a RLS de `/emails` e `/erros`
  (migration 078) compara `lower(sender_email) = lower(auth.email())` — um usuário de grupo
  com `sees_only_own_accounts` (hoje só **Comercial**) **perde de vista** os e-mails enviados
  do endereço antigo; (2) `resolve_user_for_account(sender_email)` deixa de casar o endereço
  antigo, então contas históricas seguem apontando para o dono já resolvido (o `created_by`
  é UUID, não muda), mas convém rodar a **re-varredura** descrita em "Visibilidade de contas
  por dono" se houver linhas com o endereço antigo. Antes de trocar, meça o impacto:
  `SELECT count(*) FROM email_control WHERE lower(sender_email) = '<e-mail antigo>'` (idem
  `email_processing_errors` e `financial_account_control`). O usuário passa a **logar com o
  e-mail novo, com a mesma senha**; peça logout/login para a sessão refletir a mudança.
  Aplicado em 2026-07-17: `lucas@otimotex.com.br` → `lucas@lebianco.com.br` (grupo Diretor,
  sem `sees_only_own_accounts` e com 0 linhas casando o endereço antigo → impacto nulo).
- **Quatro telas** (`apps/frontend-vite/src/pages/auth/`): `LoginPage` → `signInWithPassword`,
  `ForgotPasswordPage` → `resetPasswordForEmail`, `ResetPasswordPage` → `updateUser`,
  `ChangePasswordPage` → `updateUser` (troca obrigatória no 1º acesso).
- **Troca de senha OBRIGATÓRIA no 1º acesso (`/auth/change-password`):** o usuário criado
  pelo admin entra com uma senha temporária e é forçado a definir a sua própria antes de
  acessar qualquer rota. Mecânica por **marca POSITIVA** `password_changed` em **`app_metadata`**
  (`PASSWORD_CHANGED_META_KEY` + helper `mustChangePassword` em `@sheild/shared`): a marca só
  é gravada quando o próprio usuário troca a senha; **ausência da marca = senha ainda é a
  temporária → força a troca**. Cobre QUALQUER caminho de criação (Dashboard **ou**
  `POST /api/users`), pois usuário novo nunca tem a marca. `ProtectedRoute` redireciona para
  `/auth/change-password` enquanto a marca faltar (lê `user.app_metadata`); `ChangePasswordForm`
  faz `updateUser({ password })` e, em seguida, **`POST /api/users/me/password-changed`**
  (`requireAuth` → `userService.markPasswordChanged` via Admin API) + `refreshSession()` —
  sem deslogar, segue para `/consulta` (o `TOKEN_REFRESHED` atualiza o `AuthContext`). É a
  diferença para o `ResetPasswordForm` (fluxo "esqueci a senha": vem de link de e-mail e
  **desloga** ao final).
  **`app_metadata` é SERVER-CONTROLLED (não regredir — achado S1-1):** só é gravável via Admin
  API/`service_role`, então o usuário não consegue forjar a marca e pular a troca. **Nunca**
  voltar a marcar/ler em `user_metadata`, que é client-writable — era exatamente o furo que
  tornava a "troca obrigatória" cosmética.
  **Usuários existentes** (anteriores à correção) foram marcados via **backfill** em
  `auth.users.raw_app_meta_data` (`password_changed: true`) — só usuários NOVOS são forçados;
  quem ficou com a marca antiga em `raw_user_meta_data` é forçado a trocar uma vez.
  **Criar usuário pelo Dashboard:** Authentication → Users → Add user + "Auto Confirm User";
  NÃO definir `password_changed` no metadata (a ausência é justamente o que força a troca).
- Estado de sessão: `AuthContext`/`useAuth` (`apps/frontend-vite/src/contexts/AuthContext.tsx`),
  via `supabase.auth.getSession()` + `onAuthStateChange`. Ao restaurar, primeiro aplica o
  early-out de inatividade (`isIdleExpired`, ver abaixo); se não expirou, valida a sessão no
  servidor com `getUser()`: 401/403 → desloga; falha de rede → mantém otimisticamente.
- **Persistência da sessão (storage híbrido — "Lembrar-me")**: `supabaseClient.ts` usa
  `storage: hybridAuthStorage` (`src/lib/authStorage.ts`), que roteia o token pelo checkbox
  "Lembrar-me" via flag `pag:remember` no localStorage (`'1'`/`'0'`): **marcado →
  `localStorage`** (sobrevive ao fechar o navegador), **desmarcado → `sessionStorage`**
  (reabrir sempre exige login). `LoginForm` chama `setRememberPreference(remember)` antes do
  `signIn`; o checkbox **inicializa refletindo a última preferência salva**
  (`getRememberPreference` no `useState`) — desmarcado na primeira vez e, uma vez marcado,
  permanece marcado nas próximas sessões até o usuário desmarcar. Refresh (F5) na mesma aba
  mantém em ambos os casos.
- **Logout por inatividade (teto de 30 min, vale em ambos os modos)**: `useIdleLogout`
  (`src/hooks/`) desloga após `VITE_SESSION_IDLE_MINUTES` sem atividade (padrão 30 min).
  Marcador de atividade em `localStorage` (`pag:last-activity`, compartilhado entre abas);
  reiniciado no `SIGNED_IN`, limpo no `SIGNED_OUT`. O helper `isIdleExpired(timeoutMs)`
  (exportado do mesmo hook) é usado no `AuthContext.init()` para deslogar já na reabertura
  quando o período ocioso herdado expirou — assim "Lembrar-me" mantém a sessão por **no
  máximo 30 min** entre reaberturas, sem flash de conteúdo protegido.
- **Suspensão durante processamento**: `suspendIdleLogout()`/`resumeIdleLogout()`
  (contador no `useIdleLogout`) pausam o teto de inatividade enquanto a leitura de
  e-mails roda (`Emails.handleRead` suspende no início e retoma no `finally`, ambos os
  modos). Evita logout no meio de um processamento longo; `resume` reinicia a janela.
- Rotas protegidas: `ProtectedRoute.tsx` redireciona para `/auth/login` sem sessão.
- RLS: migration `015` trocou policies de leitura de `TO anon` para `TO authenticated` —
  `services/supabase.ts` envia `access_token` no header `Authorization` (além do `apikey`).

## Arquitetura e fluxo de dados

Monorepo (npm workspaces): `apps/frontend-vite` (SPA interno, React 19/Vite 8/TS 6, :5173),
`apps/api-backend` (Next 16/TS, camada de dados, :3000), `apps/portal-next` (portal
público, Next 16, :3002), `packages/shared` (Zod) + camada Python (`server/`, `skills/`).

```
IMAP (Locaweb SSL)                  apps/frontend-vite (React+Vite TS, :5173)
      │                                        │
      │                          ┌─────────────┼────────────────────────────┐
      │                          │ /emails     │ /consulta      /erros       │
      │                          │ email_control  financial_account_control  errors   │
      │                          │   fetch direto Supabase REST              │
      │                          │   (apikey: anon + Authorization: token)   │
      │                          └─────────────┼────────────────────────────┘
      │                                        │ POST /read/start + GET /progress (poll)
      │                                        ▼  (proxy /api → Flask :8000)
read_emails.run_reader() ◄───────── server/app.py (Flask, porta 8000)
      │                                        ▲
      │ por e-mail:                            │ ponte HTTP (lib/python-bridge.ts)
      │  1. deduplica via email_control.message_id (UNIQUE) — pula já vistos
      │  2. SEM keyword no assunto → registra como 'ignorado' (sem baixar/extrair)
      │  3. COM keyword → salva PDF em data/pdfs_inbox/  apps/api-backend (:3000)
      │  4. in-process → extract_pdf.extract_to_csv (Claude API: pdf_text ou pdf_vision)
      │  5. UPSERT em email_control  +  fallback CSV em data/csv_output/
      ▼
Supabase (PostgreSQL)  ── financial_account_control (dados extraídos)
                       ├─ email_control     (controle/dedup)
                       ├─ email_processing_errors (log de falhas)
                       └─ supplier          (fornecedores — auto-criados + curadoria; preservado)
```

> **Topologia de portas (dev):** o frontend (`:5173`) chama o Flask (`:8000`) **direto**
> via proxy `/api` para a leitura de e-mails. A Next API (`:3000`) é camada de dados
> independente (CRUD futuro) e expõe a mesma ponte ao Flask; não intercepta o caminho
> atual do frontend.
>
> **Ponte com timeout (`lib/python-bridge.ts`, S3-1 — não regredir):** `triggerReader`/
> `probePythonHealth` passam `AbortSignal.timeout(...)` no `fetch` ao Flask — um Flask travado
> (IMAP pendurado) **não** pendura o handler Next junto. Teto de **300s** na leitura
> (`PYTHON_BRIDGE_TIMEOUT_MS`, a leitura síncrona real leva minutos) e **5s** no health; o timeout
> vira `PythonBridgeError(504)` (indisponível segue `502`). Teste em `lib/python-bridge.test.ts`.

## Comandos

> **Specs/templates de prompts (`docs/prompts/`)** — fonte dos prompts copy-paste para o
> Claude Code (padrão prompt-first). CRUDs/auth: `api-supplier-crud-spec.md`,
> `api-contas-crud-spec.md`, `api-users-auth-spec.md`. Qualidade/produção:
> `code-review-producao-spec.md` (review completo em 2 fases — **Phase 1: modo normal**
> read-only, diagnóstico cross-layer; **Phase 2: plan mode**, prompts XML de correção por área;
> gate lint+typecheck+test+prune+vulture; usa `claude-opus-4-8` p/ análise multi-arquivo) e
> `auditoria-seguranca-spec.md` (auditoria de segurança: AuthN/Z, RLS por coluna, IDOR/mass
> assignment, SSRF no download de boleto, XSS, segredos/deps; **Phase 1: modo normal**,
> **Phase 2: plan mode**). Os dois últimos escrevem só em `docs/review/` — rodar o de review
> antes do de segurança (compartilham `read_first`). Modelos: `claude-sonnet-4-6` para tarefas
> isoladas; `claude-opus-4-8` para análise cross-layer com muitos arquivos.

Dependências dos apps: `npm install` na **raiz** (workspaces — lockfile único).

```powershell
# Tudo de uma vez: Flask (:8000) + os 3 apps Node (vite :5173, api :3000, portal :3002)
npm run dev            # via concurrently — serviços falham de forma INDEPENDENTE (ver nota)

# …ou individualmente, em terminais separados:
npm run dev:flask      # backend Flask (:8000) — leitura de e-mails (py -3 server/app.py)
npm run dev:vite       # frontend Vite interno (proxy /api → Flask :8000)
npm run dev:api        # Next API de dados — opcional p/ o fluxo atual
npm run dev:portal     # portal público — opcional
```

Scripts da raiz: `npm run dev` (sobe **flask+vite+api+portal** em paralelo via
`concurrently`) · `npm test` · `npm run typecheck` · `npm run lint` · `npm run prune`
(rodam em todos os workspaces via `--workspaces --if-present`). Builds:
`npm run build:vite|build:api|build:portal`. O `dev` raiz **inclui o Flask**
(`dev:flask` = `py -3 server/app.py`); requer Python com `pdfplumber` no PATH. Para
subir só os apps Node, use os `dev:vite|dev:api|dev:portal` individuais.

> **Nota de estabilidade do dev server (2026-06-19):** o `--kill-others-on-fail` foi
> removido do script `dev` — cada serviço agora falha de forma independente. Antes, uma
> falha do Flask (ex.: porta `:8000` ocupada de sessão anterior) derrubava o Vite junto.
> **Para sessões de trabalho exclusivamente de frontend, prefira `npm run dev:vite`** —
> o Vite sobe sem depender do Flask e não há risco de queda por serviços externos.

> **Versão do Node — use 20.9+ ou 22 LTS, NUNCA a 24 (não regredir — 2026-06-30):** o
> `next dev` do **Next 16** (api-backend/portal) **crasha o worker** no **Node 24**
> (*"Jest worker encountered N child process exceptions, exceeding retry limit"*) — TODAS
> as rotas `/api/*` autenticadas passam a devolver uma **página HTML de erro 500** (não o
> envelope JSON), e o frontend mostra o genérico **"Erro 500 ao acessar a API de dados"**.
> **Só acontece no dev local** (a Vercel roda Node LTS, produção intocada), o que confunde
> o diagnóstico. O manifesto agora trava a versão: **`.nvmrc` = `22`** + **`engines.node`
> = `"^20.9.0 || ^22.0.0"`** na raiz (`nvm use` seleciona a certa; `npm install` avisa no
> Node fora da faixa). Se aparecer 500 HTML em TODAS as rotas autenticadas mas `/api/health`
> (pública) responder JSON: é o worker do dev, não o código — troque para Node 22
> (`nvm use 22`) e/ou limpe `apps/api-backend/.next` e reinicie. **Sintoma-chave:** o
> genérico "Erro {status} ao acessar a API de dados" só aparece quando a resposta **não é
> JSON** (`dataApiCall` não achou `error` no corpo) — indica falha de infra/dev-server,
> não erro de validação (que ecoa a mensagem curada do backend).

Acessibilidade em navegador (Playwright + axe) — **não** roda no `npm test`; runner
separado em `apps/frontend-vite` (sobe o Vite dev sozinho via `webServer`):

```powershell
cd apps\frontend-vite
npx playwright install chromium      # uma vez (baixa o navegador)
npm run test:e2e                     # todas (protegidas pulam sem credencial)
npm run test:e2e -- public-auth      # só login/forgot/reset (sem login)
npm run test:e2e:headed              # com janela do navegador
```

Para escanear as rotas protegidas, exporte `A11Y_TEST_EMAIL`/`A11Y_TEST_PASSWORD` (usuário de
teste no Supabase). No CI, o workflow `.github/workflows/a11y.yml` roda isso a cada PR/push na
`Features`. **Não executar daqui (sandbox do agente)** — o renderer crasha na SPA completa.

Leitura de e-mails:

```powershell
python skills\email-reader\scripts\read_emails.py --days 7
python skills\email-reader\scripts\read_emails.py --dry-run
python skills\email-reader\scripts\read_emails.py --all --mark-seen
```

Reprocessar PDFs pendentes (`status=pendente`: `attachment_saved=true`, `pdf_extracted=false`):

```powershell
py -3 scripts\retry_extraction.py          # usar py -3, não python
py -3 scripts\retry_extraction.py --dry-run
```

Reprocessar a fila de `falha` (rebusca o corpo no IMAP). Os dois são complementares —
rode primeiro o de **link** (boleto por URL), depois o de **corpo**:

```powershell
py -3 scripts\reprocess_link_emails.py --dry-run   # boleto por link (BRASPRESS/SIEG…)
py -3 scripts\reprocess_body_emails.py --dry-run   # conta no corpo do e-mail (sem anexo/link)
```

Reprocessar após **ampliar o filtro de assunto** (acrônimos de tributo) ou ajustar a regra
de NF-e. Fase A: `ignorado` que passou a casar keyword → rebusca no IMAP e extrai. Fase B:
NF-e pura sem conta a pagar → reclassifica para `ignorado` (só status, sem IMAP):

```powershell
py -3 scripts\reprocess_ignored_emails.py --dry-run
```

Alinhar dados JÁ gravados à regra de **CT-e/transporte** (ver "CT-e / transporte" em
"Normalização de `document_type`"). Fase A: boleto de fornecedor de transporte →
`document_type='cte'`. Fase B: `cte` que não é boleto → **hard delete** + e-mail órfão →
`ignorado`. Roda uma vez (rodado em 2026-07-02):

```powershell
py -3 scripts\reprocess_cte_accounts.py --dry-run   # lista o que faria
py -3 scripts\reprocess_cte_accounts.py             # re-rotula + exclui
```

Corrigir o fornecedor para o **Beneficiário Final** do boleto securitizado (ver "Beneficiário
Final vence Beneficiário/Cedente"). Baixa cada PDF `pdf_text`, extrai o beneficiário final e
re-aponta `sk_supplier` **só quando há CNPJ** (name-only → revisão manual). Aplicado em
2026-07-16 (561/562 → INORGAN):

```powershell
py -3 scripts\reprocess_beneficiario_final.py --dry-run          # varre e lista candidatos
py -3 scripts\reprocess_beneficiario_final.py --dry-run --ids 561,562  # só estes ids
py -3 scripts\reprocess_beneficiario_final.py                    # aplica
```

Limpar do bucket os **objetos ÓRFÃOS** — os que nenhuma linha referencia. `upload_attachment`
publica TODO PDF no Passo 1, **antes** de saber se ele vira conta; quando não vira (CT-e/NF-e
`ignorado`, fatura cujo boleto virou a conta, confirmação de pagamento, **dedup** de cobrança
repetida), o objeto fica sem `financial_account_attachment.storage_key` nem
`financial_account_control.source_file` — e, desde a **080**, invisível pela API. **PRESERVA** o que
é trabalho em aberto: e-mail em `pendente`/`falha` e objeto citado em `email_processing_errors`
(extração falhou — o bucket é a cópia acessível; o original só existe no IMAP). IRREVERSÍVEL — use
`--dry-run` primeiro; o backup diário (skill `backup-supabase`) cobre o bucket.

```powershell
py -3 scripts\purge_orphan_attachments.py --dry-run  # lista o que apagaria e o que preserva
py -3 scripts\purge_orphan_attachments.py            # apaga
```

> **Aplicado em 2026-07-15:** 571 → **236** objetos (335 removidos, ~41 MB). **3 preservados**
> (boleto Amil `pendente`, boleto OBER NF 963681 e fatura Correios — `extracao_falhou`). Integridade
> conferida: **0** anexos e **0** `source_file` ficaram sem objeto.

Preencher **contato do fornecedor** (telefone/WhatsApp/chave PIX) em `supplier` a partir do texto
já gravado nas contas (ver "Contato do fornecedor"). Agrupa por `sk_supplier`, lógica de 2 slots,
idempotente. Aplicado em 2026-07-16 (31 fornecedores):

```powershell
py -3 scripts\backfill_supplier_contacts.py --dry-run   # lista o que gravaria
py -3 scripts\backfill_supplier_contacts.py             # grava
```

Reprocessar **UM e-mail específico** pelo **pipeline completo** (Message-ID) — único que
cobre **anexo e IMAGEM INLINE** (recibo/comprovante colado no corpo, via Vision), que os
reprocessadores de corpo/link não cobrem. Rebusca o e-mail no IMAP, roda `process_message`,
grava em `financial_account_control` e reconcilia `email_control` (`falha`→`extraído`/…) +
remove o erro antigo de `email_processing_errors`. A leitura normal NÃO o alcança (dedup por
`message_id` pula e-mails já registrados); este script ignora a dedup para o e-mail informado:

```powershell
py -3 scripts\reprocess_message.py --message-id "<...>" --dry-run   # só inspeciona o IMAP
py -3 scripts\reprocess_message.py --message-id "<...>"             # processa e grava
```

Extração isolada:

```powershell
py -3 skills\pdf-contas-pagar\scripts\extract_pdf.py --input data\pdfs_inbox\ --output data\csv_output\ --batch
```

Backup do Supabase (banco `pg_dump` + Storage `attachments`) — ver "Pipeline de backup do
Supabase (skill `backup-supabase`)":

```powershell
py -3 skills\backup-supabase\scripts\run.py --dry-run     # valida config/conexão sem gravar
py -3 skills\backup-supabase\scripts\run.py               # backup completo (banco + Storage)
py -3 skills\backup-supabase\scripts\run.py --skip-storage  # só o banco  (valida a senha)
py -3 skills\backup-supabase\scripts\run.py --skip-db       # só o Storage
```

Dependências:

```powershell
pip install -r server/requirements.txt   # deps Python do pipeline, pinadas com ~=
npm install                              # na raiz do monorepo — instala todos os workspaces
```

`server/requirements.txt` é a fonte de verdade das dependências Python (flask, python-dotenv,
pdfplumber, Pillow, anthropic, pandas), com versões fixadas em `~=` para dev/prod não
divergirem — não rodar `pip install` solto sem atualizar o arquivo.

## Frontend — componentes e design system

### Estrutura Atomic Design

**Dois estilos visuais de auth coexistem** — não misturar componentes entre eles:

| Estilo | Páginas | Tokens | Componentes-chave |
|---|---|---|---|
| **v2 loginGreen** | `LoginPage` | `loginGreen-*`, `font-jakarta`, `border-[6px]` frame | `FilledTextField`, `AccentPillButton`, `SocialLinksBar` |
| **auth gradient** | `ForgotPasswordPage`, `ResetPasswordPage` | `bg-gradient-auth`, `auth-navy` | `AuthLayout`, `AuthInput`, `GradientPillButton`, `InlineMessage` |

Tudo em TypeScript (`.tsx/.ts`) sob `apps/frontend-vite/src/`:

```
apps/frontend-vite/src/components/
├── atoms/
│   ├── Alert.tsx              # (app) banner de página via cva — error/success/warning/info + ícone
│   ├── FilledTextField.tsx    # (v2) campo label + fundo verde + id (useId) + aria-invalid
│   ├── AccentPillButton.tsx   # (v2) botão primário verde + ArrowRight
│   ├── AuthInput.tsx          # (gradient) campo label + input + erro inline (aria-describedby)
│   ├── GradientPillButton.tsx # (gradient) botão pill com bg-gradient-auth
│   ├── CheckToggle.tsx        # checkbox de curadoria (NF/Boleto) — escreve no banco
│   ├── SelectCheckbox.tsx     # checkbox de SELEÇÃO de linha (rowSelection) + indeterminate
│   ├── LabeledSelect.tsx      # (tabelas) <select> rotulado (htmlFor/id + erro) — lookups dos forms de cadastro
│   ├── FileInputButton.tsx    # (anexos) <input type=file multiple> REAL + sr-only (teclado/leitor de tela nativos)
│   └── StatusSelectCell.tsx   # (consulta) dropdown inline de situação no grid — altera status_id (STATUS_OPTIONS)
├── molecules/
│   ├── SocialLinksBar.tsx     # (v2) círculos Otimotex/Lebianco/WhatsApp
│   ├── AuthHeroHeader.tsx     # (gradient) header decorativo com círculos sobrepostos
│   ├── InlineMessage.tsx      # (gradient) banner sucesso/erro — nunca alert()
│   ├── SupplierSelect.tsx     # (contas) react-select AsyncCreatable — busca/cria fornecedor (sort=name)
│   ├── CostCenterSelect.tsx   # (contas + fornecedores) react-select Async — centro de custo (lookup)
│   ├── ChartAccountSelect.tsx # (contas + fornecedores) react-select Async — plano de contas (CASCATA: filtrado por centro)
│   ├── ColumnVisibilityMenu.tsx # (grid) popover mostrar/ocultar + fixar coluna (pin esq/dir)
│   ├── GridToolbar.tsx        # (grid) barra: colunas + densidade + restaurar + ações de seleção
│   ├── AttachmentPicker.tsx   # (anexos) fila CONTROLADA de arquivos a enviar — valida mime/tamanho/duplicata no cliente
│   ├── AttachmentList.tsx     # (anexos) lista apresentacional PURA (serve a fila e os salvos) — ícone/tamanho/selo e-mail
│   └── SearchInput.tsx        # (cadastros) busca com lupa + botão limpar (X) — usado pelo grupo Tabelas + /fornecedores
├── organisms/
│   ├── LoginForm.tsx          # (v2) estado + validação + supabase.auth.signInWithPassword
│   ├── ForgotPasswordForm.tsx # (gradient) resetPasswordForEmail + mensagem genérica
│   ├── ResetPasswordForm.tsx  # (gradient) updateUser + signOut + redirect (fluxo "esqueci a senha")
│   ├── ChangePasswordForm.tsx # (auth) troca obrigatória no 1º acesso — updateUser + marca password_changed (sem deslogar)
│   ├── ResendErrosAction.tsx  # (cobrança) barra de seleção "Reenviar e-mails (N)" + confirmação inline + poll de progresso
│   ├── ContaForm.tsx          # (contas) form criar/editar conta — supplier/centro/plano + cascata; onSubmit(data, pendingFiles) — a fila de anexos sobe no PAI, após gravar a conta
│   ├── ContaAttachments.tsx   # (anexos) anexos SALVOS de uma conta — lista + viewer + soft delete (com confirmação); fallback legacySourceFile
│   ├── SupplierForm.tsx       # (fornecedores) form criar/editar fornecedor — classificação default (centro/plano cascata) + contatos (telefone/WhatsApp/chave PIX, 2 slots)
│   ├── CostCenterForm.tsx     # (tabelas) form criar/editar centro de custo — código + descrição
│   ├── BankForm.tsx           # (tabelas) form de banco — código(3) + nome
│   ├── FinancialAccountForm.tsx # (tabelas) form de conta — descrição/banco/situação(lookups) + saldo
│   ├── ChartAccountForm.tsx   # (tabelas) form de plano de contas — centro/subgrupo(lookups) + nível + postável
│   ├── ChartAccountGroupForm.tsx     # (tabelas) form de grupo — código + descrição + tipo(1)
│   ├── ChartAccountSubgroupForm.tsx  # (tabelas) form de subgrupo — código + descrição + grupo(lookup obrigatório)
│   ├── CrudTablePage.tsx      # (tabelas) página CRUD genérica <T,TInput> (lista+busca+modais) — base das 5 páginas
│   ├── DataGrid.tsx           # grid sobre TanStack Table v8 (+ DataGrid.test.tsx) — ver seção própria
│   ├── dataGrid.variants.ts   # cva por slot (header/row/cell/skeleton/empty/footer/pin/resize/grip/densidade/wrap) default|silver
│   └── dataGrid.rows.ts       # buildRenderItems (achata linhas→itens row/second/footer/detail p/ virtualização)
├── AuthLayout.tsx             # (gradient) wrapper full-page para Forgot/Reset
├── AttachmentViewer.tsx       # visualizador de PDF (signed URL do Storage) em <dialog> nativo (showModal: role/foco/trap/Esc nativos) + iframe SEM sandbox — o viewer PDF do Chrome (PDFium) não renderiza em iframe sandboxed, nem com allow-scripts (S5-1 introduziu e quebrou o boleto; revertido). NÃO reintroduzir sandbox; ver comentário no componente. `sourceFile` = chave CRUA do objeto (pipeline: nome flat; manual: `manual/{id}/…`); prop opcional `title` = nome amigável no cabeçalho (sem ela cairia a chave crua). Os botões (Fechar/Baixar/Nova aba) contêm o próprio clique — é montado dentro do <tr> de /consulta (ver "Contenção do clique")
├── Layout.tsx (+ Layout.test.tsx)   # sidebar; navLink = cva local (estado active); menu em 5 grupos (ver abaixo)
├── ProtectedRoute.tsx
├── ErrorBoundary.tsx          # boundary raiz (main.tsx): chunk lazy obsoleto → auto-reload; runtime → fallback "Recarregar" (+ teste/a11y)
├── StatusBadge.tsx (+ StatusBadge.test.tsx)   # componente; variantes em statusBadge.variants.ts
├── statusBadge.variants.ts    # cva(badgeVariants) + resolveBadge + badgeLabel + mapas de tipo/status
└── ExpandableText.tsx         # expansível "ver mais/ver menos" (+ ExpandableText.test.tsx)
```

**Menu da sidebar (`Layout.tsx`) — 5 grupos** (cabeçalho `uppercase`; itens `breve` são
`<span className="nav-link is-disabled">` com badge "breve", sem rota):

| Grupo | Itens (rota / estado) |
|---|---|
| **Recebimentos** | E-mails (`/emails`) · Log de erros (`/erros`) |
| **Envios** | E-mails (`/cobranca/envios`) · Log de erros (`/cobranca/erros`) — logs da cobrança automática de vencidos |
| **Contas** | Gestão de contas (`/consulta`) · Cadastro de contas (`/contas`) · Cadastro de fornecedores (`/fornecedores`) |
| **Tabelas** | Bancos (`/tabelas/bancos`) · Contas bancárias (`/tabelas/contas`) · Centro de custos (`/tabelas/centros-de-custo`) · Plano de contas (`/tabelas/plano-de-contas`) · Grupos de plano de contas (`/tabelas/grupos-plano-de-contas`) · Sub grupos de plano de contas (`/tabelas/subgrupos-plano-de-contas`) — CRUDs dos cadastros contábeis (ordem conforme `Layout.tsx`) |
| **Análise** | Dashboard (`/dashboard`) |

> "Gestão de contas" aponta para `/consulta` (só o rótulo difere da rota). Ao promover um
> item `breve` a ativo, troque o `<span … is-disabled>` por `<NavLink>` e remova o badge
> (feito para "Cadastro de fornecedores", "Cadastro de contas" e **"Dashboard"**). **Não há mais
> nenhum item `breve`** na sidebar — todos os itens são links ativos.

O **rodapé da sidebar** mostra apenas **avatar + e-mail + botão Sair** — o antigo texto de versão
`v1.0.0 — fase 1` foi **removido**. Os espaçamentos verticais foram **compactados** para o menu
**caber sem scroll** em telas ~900px+ (`nav-link` = `py-1.5`; cabeçalhos de grupo = `pt-2.5 pb-1`,
o 1º grupo `pt-0.5 pb-1`; `<nav>` `py-2`; logo `py-3`; rodapé `py-2.5`). O `overflow-y-auto min-h-0`
do `<nav>` **permanece** como rede de segurança para viewports muito baixas (rola DENTRO da sidebar
escura em vez de transbordar sobre o `<main>` branco — não regredir, ver a11y).

Hooks em `src/hooks/`: `useContainerBreakpoint.ts` (faixa `sm`/`md`/`lg` pela largura
**real do container** via `ResizeObserver` — não da janela; usado pelo `DataGrid` p/ ocultar
colunas considerando sidebar/paddings), `useGridPreferences.ts` (estado de layout do grid —
ordem/visibilidade/larguras/fixação/densidade — persistido em `localStorage` por `gridId`;
setters no formato `OnChangeFn` do TanStack + `reset()`; aceita **`defaultPinning`/`defaultDensity`**
semeados na 1ª carga e no `reset()` — prefs salvas prevalecem; ver seção do DataGrid) e
`useGridColumns.ts` (metadados de coluna — `ColumnDef` com `size?`/`minSize?`/`wrap?` opcionais,
`getConsultaColumns`, `getEmailColumns`; é módulo de **definições**, não um hook,
apesar do nome). `getConsultaColumns(onToggleFlag, onStatusChange)` é factory porque as
colunas "NF" e "BOL" (curadoria) renderizam o atom `CheckToggle` (checkbox que escreve no banco) e a
coluna "Situação" renderiza o `StatusSelectCell` (dropdown inline que altera a situação **por
`status_id`**; opções `STATUS_OPTIONS` value=id, e o badge é exibido pelo **nome** resolvido via
`STATUS_NAME_BY_ID`/embed `status_dim`) — ambos precisam dos callbacks da página. (A coluna "Ações"/`onEdit` foi removida — a edição da conta parte
do botão "Editar conta" do painel de detalhe.) Os cabeçalhos são abreviados (`NF`/`BOL`) para poupar
largura, mas o `aria-label` do checkbox continua descritivo (`Tem NF`/`Tem Boleto`). A coluna **"Fornecedor" deriva do JOIN com `supplier`** e exibe **apenas `trade_name`**
(razão fantasia — todos os fornecedores têm `trade_name` preenchido; sem fallback para
`legal_name` no grid); a antiga coluna **"CNPJ/CPF" foi REMOVIDA do grid** (segue no card de
detalhe + embed). A **coluna "Plano de contas" tem visualização ENRIQUECIDA** (`fmtChartAccountFull`,
`lib/format.ts`): **concatena plano de contas + grupo + subgrupo + centro de custo** (cada parte
`código — descrição`, separador ` · `; partes ausentes/id 0 omitidas). A **antiga coluna "Centro de
custo" foi REMOVIDA do grid** (dobrada dentro da célula de plano de contas) — mas a **edição
(inclusão/alteração) do centro e do plano no `ContaForm` permanece inalterada** (só a visualização do
grid mudou). Grupo/subgrupo vêm dos **embeds ANINHADOS em `chart_account`**
(`group:financial_chart_of_account_group(...)` via a FK direta da migration 058 +
`subgroup:financial_chart_of_account_subgroup(...)`), acrescentados ao `SELECT_WITH_EMBEDS`; o centro
de custo é o da própria conta (`cost_center_id`, embed `cost_center` — o mesmo que era exibido na coluna
removida). Os schemas de embed de grupo/subgrupo reusam `chartAccountGroup/SubgroupEmbeddedSchema` dos
cadastros (sem duplicar). **A hierarquia aninhada precisa vir nos DOIS caminhos de leitura (não
regredir):** o `SELECT_WITH_EMBEDS` do frontend (`services/supabase.ts`, usado no fetch/refresh do grid)
**e** o `SELECT_WITH_SUPPLIER` da Next API (`apps/api-backend/lib/contas.ts`, resposta de POST/PATCH que
é **mesclada IN-PLACE** no grid por `Consulta.handleEditSubmit`, sem refetch). Se só um trouxer
group/subgroup, a célula fica **parcial após salvar a edição e só corrige no refresh** — foi exatamente o
bug corrigido ao acrescentar os embeds aninhados ao SELECT da Next API. **Fornecedor e Plano de contas
SÃO ordenáveis server-side** pelo recurso
embutido, via sintaxe do PostgREST `alias(coluna)` no `order` — `sortKey: 'supplier(trade_name)'` e
`'chart_account(account_description)'` (a coluna concatenada ordena pela **descrição do plano**). O
**alias** é o mesmo do `SELECT_WITH_EMBEDS` (`supplier`/`chart_account`); usar o nome real da tabela
(`financial_cost_center(...)`) é rejeitado pelo PostgREST (400). O `key` dessas colunas de embed no
`ColumnDef` é sintético (`ColumnDef.key` é `keyof T | (string & {})`; o `accessorFn` só alimenta
sort/filter client-side, que não usamos — a ordenação é sempre server-side). Ordem das colunas de
A coluna **"Empresa"** (`company.trade_name` via a FK `sk_company`, embed `company(trade_name)`) fica
**logo APÓS o Fornecedor** — mesma posição no **card de detalhe** e no **ContaForm** (pedido do
usuário). É ordenável server-side por `company(trade_name)` e **não se confunde com o Fornecedor**:
pode haver conta da LEBIANCO cujo fornecedor é a OTIMOTEX. Ordem das colunas de
`/consulta`: **… Emissão → Fornecedor → Empresa → Tipo Documento → Tipo Pagamento → Plano de contas → Vencimento → Valor → NF → BOL → Situação → Extração**
(`Extração` é a última; **não há mais colunas "Ações" nem "Centro de custo"**). `Extração` (badge
`extraction_source`) aparece **só** no grid (removida do detalhe e do CSV); contas criadas
**manualmente** (`extraction_source` nulo) exibem o rótulo **"Criado pelo usuário"** (constante
`MANUAL_EXTRACTION_LABEL` em `useGridColumns`) em vez de "—" — o pipeline SEMPRE grava um
`extraction_source`, então vazio identifica de forma confiável a criação manual. O **card de detalhe** de
`/consulta` continua mostrando **Centro de custo e Plano de contas SEPARADOS** (via `fmtCostCenter`/
`fmtChartAccount`, inalterados) — a concatenação é exclusiva do grid.
A coluna **"Situação" ordena alfabeticamente pelo NOME** da dimensão (`sortKey: 'status'`, mapeado
no serviço para `order=status_dim(status_name)`), **não** por `status_id` (o ciclo de vida não é
linear — id ≠ ordem de negócio). **`ColumnDef` ganhou `wrap?`** (quebra de linha em vez de
truncar — usado em Fornecedor/Plano de contas) e **`minSize?`** (largura mínima por
tipo de dado, ~48–120px, respeitada no resize). `hideOn` (responsividade mobile/tablet) segue como o
mecanismo de ocultação por breakpoint.
`useIdleLogout.ts` e `useAuth` cobrem sessão (ver Autenticação).

Tipos compartilhados vêm de `@sheild/shared` (ex.: `FinancialEmail`, `EmailControl`).
Helpers em `src/lib/`: `getErrorMessage.ts` (erro em strict mode), `format.ts` (formatadores
de exibição — `fmtDate`/`fmtDateTime`/`fmtMoney`/`fmtCnpj`/`fmtCpf`/`fmtCostCenter`/`fmtChartAccount`/
`fmtBytes` (tamanho de arquivo B/KB/MB, base 1024 — usado pela lista de anexos);
**fonte única** consumida por `Consulta`/`Emails`/`Dashboard`/`useGridColumns` — não recriar cópias
locais), `csv.ts` (`csvCell` — célula CSV segura: escapa aspas, remove CRLF e **neutraliza
injeção de fórmula** `= + - @` no export de `/consulta`; segurança §5 M1), `cn.ts` (merge de
classes Tailwind — `clsx` + `tailwind-merge`, base do padrão CVA), `supabaseClient.ts`
(SDK oficial, só para auth), `authStorage.ts` (storage híbrido da sessão +
`setRememberPreference`/`getRememberPreference` — preferência "Lembrar-me"; ver
seção Autenticação), `getStatusExplanation.ts` (texto pt-BR no `Alert` do card de `/emails`
explicando por que um e-mail ficou em `falha` (error), `pendente` (warning) ou `ignorado`
(info); reusa `getFailureReason.ts` para o caso `falha`) e `chunkReload.ts` (recuperação de
chunk lazy obsoleto: `isChunkLoadError`/`reloadOnceForChunk`/`installPreloadErrorReload` —
ver "Build e code-splitting").

Infra de teste a11y em `tests/`: `setup.ts` (matcher `toHaveNoViolations`), `axe.ts`
(runner AA + `color-contrast` desligado), `contrast.a11y.test.ts` (guarda de contraste
dos tokens) e `contrast-usage.a11y.test.ts` (guarda das cores default do Tailwind em uso,
com ratchet `it.fails`). Camada de navegador em `e2e/` (Playwright + axe). Ver regra
mandatória 6.

### Guia de cores — paleta `loginGreen` (`@theme` em `apps/frontend-vite/src/index.css`)

Telas de auth usam **essencialmente** estes tokens:

| Token | Hex | Uso |
|---|---|---|
| `loginGreen-ink` | `#0c1e14` | títulos, labels, texto de input |
| `loginGreen-inkMid` | `#2a3d30` | textos secundários ("lembrar-me") |
| `loginGreen-inkMuted` | `#4a6b55` | labels sociais, divisores |
| `loginGreen-inkFaint` | `#558a6d` | ícone olho — AA ≥3:1 sobre o campo (1.4.11) |
| `loginGreen-placeholder` | `#437355` | placeholder (`placeholder:text-loginGreen-placeholder`) — AA ≥4.5:1 sobre o campo |
| `loginGreen-field` | `#eef9f3` | fundo dos campos |
| `loginGreen-fieldFocus` | `#e4f6ec` | fundo em foco |
| `loginGreen-surface` | `#e6f5ec` | definido no `@theme` mas **sem uso atual** — candidato a remoção |
| `loginGreen-socialBg` | `#f4fcf7` | fundo dos círculos sociais |
| `loginGreen-border` | `#94D0AE` | borda principal (frame externo) |
| `loginGreen-borderLight` | `#c6e8d3` | borda secundária |
| `loginGreen-borderField` | `#b8dfc8` | borda dos campos |
| `loginGreen-borderFocus` | `#2d8a52` | borda em foco, `accent-color` do checkbox |
| `loginGreen-accent` | `#1e7a40` | botão, links |
| `loginGreen-accentHover` | `#165c30` | hover do botão (`hover:bg-loginGreen-accentHover`) |
| `loginGreen-accentMuted` | `#6aaa85` | botão desabilitado (`disabled:bg-loginGreen-accentMuted`) |

Paleta `brand` (verde dashboard) e `auth` (azul/petróleo) são usadas nas demais páginas — não misturar com `loginGreen`.

> **Contraste AA travado:** `loginGreen-inkFaint`/`-placeholder` foram escurecidos para
> cumprir AA sobre o campo verde (≥3:1 ícone / ≥4.5:1 placeholder). Não clarear sem
> revalidar em `tests/contrast.a11y.test.ts`.

### Guia de cores — paleta semântica `status` (`@theme` em `src/index.css`)

Fonte de verdade para **feedback, badges e banners** em todo o app — usar estes tokens em
vez de cores default do Tailwind. Cada grupo tem `bg` (fundo suave), `fg` (texto/ícone) e
`border`; `error` ainda tem `solid`/`solidBorder` (badge crítico de fundo cheio). Todos
cumprem WCAG AA (verificado em `tests/contrast.a11y.test.ts`).

> **Não reintroduzir tokens semânticos não-`status-*`:** os tokens legados `--color-danger`/
> `--color-warning`/`--color-info` foram **removidos** (mortos — limpeza de CSS) por
> duplicarem `status-error-*`/`status-warning-*`/`status-info-*`. Também foram removidos do
> `index.css` os `@utility` órfãos `btn-ghost` e `table-row-hover`, o token duplicado
> `loginGreen-accentDark` (= `accentHover`) e os `@utility active`/`is-disabled` **standalone**
> (o `@utility nav-link` já cobre os estados via `&.active`/`&.is-disabled` — o uso
> `nav-link is-disabled` segue intacto). Pendência conhecida: o `@keyframes fadeInUp` ainda é
> definido 2× (em `@theme` + standalone) — consolidação adiada por risco de quebrar a animação
> de `card`/`metric-card` (que usam `animation: fadeInUp` cru).

| Token | fg / bg | Uso |
|---|---|---|
| `status-error-*` | `#b91c1c` / `#fef2f2` (border `#fecaca`) | erro, vencido, falha |
| `status-error-solid` | branco / `#dc2626` | badge crítico (`erro_api`) |
| `status-success-*` | `#15803d` / `#f0fdf4` | sucesso, pago, **extraído + recebido** (verde) |
| `status-warning-*` | `#b45309` / `#fffbeb` | atenção (cartório, erros de extração) |
| `status-info-*` | `#1d4ed8` / `#eff6ff` | informativo, a vencer, prorrogado, baixado |
| `status-source-*` | `#0f766e` / `#f0fdfa` | origem da extração (teal) |
| `status-neutral-*` | `#475569` / `#f8fafc` | neutro, cancelado, documento, **pendente + ignorado + duplicidade** (cinza slate-600) |
| `status-prorrogado-fg` / `status-baixado-fg` | `#7c3aed` / `#0e7490` | **só preenchimento gráfico** do donut + swatch da legenda no Dashboard (sem par bg/border; ≥3:1 sobre branco — 1.4.11). Travados em `tests/contrast.a11y.test.ts` |

Aplicação **sempre via `cva`**: `StatusBadge` (`statusBadge.variants.ts`), `Alert` (banner
de página) e `InlineMessage`. As quatro paletas — `brand` (verde dashboard), `auth`
(azul/petróleo), `loginGreen` (auth v2) e `status` (semântica) — **não se misturam**; cada
uma no seu contexto.

**Cards de KPI em `/emails` espelham o badge** (`CARD_TONE` em `Emails.tsx`): ícone + número
de cada card usam a mesma cor do `StatusBadge` do status; o card ativo (filtro) ganha anel +
fundo no tom. Esquema (decisão de UI): **Total**=preto (`text-gray-900`) · **Extraídos +
Recebidos**=verde · **Falha**=vermelho · **Pendente + Ignorados + Duplicidades**=cinza
(`neutral`). Ordem dos cards: Total · Extraídos · Recebidos · Pendente · Duplicidades ·
Ignorados · Falha. Ao mudar a cor de um status, mexer **só** no `STATUS_VARIANT`
(`statusBadge.variants.ts`) — o card herda pelo `CARD_TONE` apontando o mesmo token.

### Guia de cores — grid de dados (`DataGrid`, `dataGrid.variants.ts`)

O `DataGrid` é **chrome de tabela neutro**, não estado semântico — por isso usa as escalas
neutras default do Tailwind (exceção explícita à regra "não usar cores default" da Regra 1,
que vale só para **estados semânticos**). Dois temas via `variant`:

| Tema | Uso | Neutro | Header/célula |
|---|---|---|---|
| `default` | `/consulta` | `slate-*` | `.table-header` / `.table-cell` |
| `silver` | `/emails` | `zinc-*` | `.table-header-silver` / `.table-cell-silver` |

Linha selecionada usa o acento `brand` (`bg-brand/10 border-l-2 border-brand`); o **hover** é
cinza neutro (`hover:bg-slate-100` no tema `default`, `hover:bg-zinc-200` no `silver`) para
contrastar com o verde da selecionada. Quando há coluna **fixada à esquerda** (ex.: a de
seleção), a 1ª célula fixada opaca cobriria o `border-l` do `<tr>`, então o acento é repintado
nela via box-shadow inset brand (variante `selected` do `pinnedCell`, aplicada só à primeira
célula left-pinned da linha selecionada). O `StatusBadge` dentro das células continua na paleta
`status`. Cada slot (header, row, cell, skeleton, empty, sub-linha de detalhe) é um `cva`
próprio com a base + o neutro do tema — string literal completa.

> **Contraste AA do texto do grid (não regredir):** o "chrome neutro" vale para
> **fundos/bordas e ícones SVG** (grip, sort, skeleton) — o axe `color-contrast` checa **só
> texto**, então ícone claro não é flagado. Mas **todo TEXTO** do grid precisa cumprir AA: a
> varredura em navegador (`e2e/`) reprovava `slate/zinc-300/400` na sub-linha de detalhe e nos
> cabeçalhos. Mínimos travados: `table-header`/`-silver` = `slate-600`/`zinc-600`;
> `secondText` (sub-linha) `label`/`sep` = `*-500`, `value` = `*-600`; `emptyText` = `*-500`.
> Botão/badge com **texto branco** usa `bg-brand-dark` (não `bg-brand` sólido, que dá só
> 3,4:1) — ver `DensityButton`/`PinButton`. Foi o axe em navegador que provou que a antiga
> "exceção" cobria texto demais.

### Guia de tamanhos — tokens Tailwind em uso

Usar o token mais próximo; valor arbitrário só como exceção documentada (ver abaixo).
A login passou por compactação para centralizar melhor o card, depois por uma **redução
global de ~20%** (×0,8) e, mais tarde, por um **aumento global de ~10%** (cada valor foi
multiplicado por 1,1 e snapado ao token Tailwind mais próximo — por isso alguns tokens
sobem um passo cheio, ex.: `h-8`→`h-9`, `text-xs`→`text-sm`) — os valores abaixo são os
**atuais** (não os do design original).

> **Snap aplicado em todo o app (não só na login):** tamanhos arbitrários de fonte foram
> eliminados — `text-[9px]/[10px]/[11px]` → `text-xs`, `text-[13px]`/`body` → `text-sm`,
> `tracking-[0.15em]` → `tracking-widest`. **Não reintroduzir `text-[Npx]`**; o corpo
> (`body` em `index.css`) é `text-sm` (14px) e as classes utilitárias `.table-header*` /
> badge base usam `text-xs`. As únicas exceções arbitrárias aceitas seguem sendo as de
> layout (ver abaixo) — nunca tipografia.

**Tipografia:**

| Classe | Tamanho | Uso no projeto |
|---|---|---|
| `text-sm` | 14px | labels sociais ("fale com a gente"), rótulos dos círculos, labels/inputs/erro dos campos (`FilledTextField`) — subiram de `text-xs` no aumento de ~10% |
| `text-base` | 16px | "lembrar-me", erro inline, links, subtítulo do login + texto do botão primário (`AccentPillButton`) — subiram de `text-sm` no aumento de ~10%; também o corpo padrão do restante do app |
| `text-2xl` | 24px | h1 do login ("Login") — mantido (24×1,1=26,4 snapa de volta a `text-2xl`) |

**Espaçamento e dimensões recorrentes (login page):**

| Classe | px | Uso |
|---|---|---|
| `h-9` | 36px | altura dos campos de input (`FilledTextField`) — subiu de `h-8` no aumento de ~10% |
| `h-11` | 44px | altura do botão primário (`AccentPillButton`) — subiu de `h-10` (40×1,1=44 exato) |
| `h-48` | 192px | altura do banner da login page — subiu de `h-44` no aumento de ~10% |
| `h-1` | 4px | divisor verde entre banner e card (decorativo — não escalado) |
| `w-11 h-11` | 44px | círculos sociais — subiu de `w-10 h-10` no aumento de ~10% |
| `w-7 h-7` | 28px | ícone dentro do círculo social — subiu de `w-6 h-6` |
| `w-3.5 h-3.5` | 14px | checkbox "lembrar-me" — subiu de `w-3 h-3` |
| `border-[6px]` | 6px | frame externo + moldura interna do banner (exceção arbitrária — subiu de `border-[5px]`) |
| `border-2` | 2px | borda dos campos e círculos (mantido — 2×1,1 snapa de volta a `border-2`) |
| `ring-4` | 4px | anel interno do card (`ring-inset ring-loginGreen-border/25`) — decorativo, não escalado |
| `rounded-xl` | 12px | border-radius do card/frame |
| `rounded-md` | 6px | border-radius de campos e botão |
| `gap-2.5` | 10px | espaçamento entre seções do formulário (mantido — 10×1,1 fica entre `gap-2.5`/`gap-3`) |
| `gap-1` | 4px | label↔campo e círculo↔rótulo social |
| `gap-7` | 28px | espaçamento entre círculos sociais — subiu de `gap-6` no aumento de ~10% |
| `my-2.5` | 10px | folga vertical extra do botão Login (acima/abaixo, somada ao `gap-2.5`) |
| `px-5` | 20px | padding horizontal do card (mantido — fica entre `px-5`/`px-6`) |
| `pt-2` / `pb-2.5` | 8px / 10px | padding vertical do card (topo/base) |
| `px-3` | 12px | padding horizontal dos campos |
| `max-w-[21rem]` | 336px | largura máxima do frame (exceção arbitrária — ~10% acima de `max-w-[19rem]`) |

**Exceções de valor arbitrário aceitas (login page):**

- `max-w-[21rem]` — 336px; não há token entre `max-w-xs` (320px) e `max-w-sm` (384px), então
  o valor de layout é arbitrário para honrar o aumento de ~10% sobre o antigo `max-w-[19rem]`.
- `border-[6px]` — 6px não existe na escala (`border-2`/`-4`/`-8`); usado no frame e na
  moldura do banner por decisão visual (5×1,1≈6, após o aumento de ~10%).
- `object-[center_25%]` — enquadramento do banner sem token equivalente.
- `w-[calc(100%+2px)] max-w-none -ml-px` no `<img>` do banner — "sangra" 1px para cada
  lado, recortado pelo `overflow-hidden` do frame, para **eliminar o risco escuro** que a
  coluna de pixels da borda da imagem deixava contra a moldura verde.

**Fonte customizada:**

`font-jakarta` → `Plus Jakarta Sans` (Google Fonts, carregada em `app/index.html`).
Aplicada no div raiz de `LoginPage.tsx`; herda por cascata para todos os filhos.

## Pontos-chave que exigem ler vários arquivos

### `run_reader()` é a única fonte de verdade da leitura

`skills/email-reader/scripts/read_emails.py` — tanto o CLI quanto `server/app.py`
chamam `run_reader()`. Edite só ali — nunca duplique lógica no Flask.

`read_emails.py` carrega o `.env` da raiz (`load_dotenv(parents[3]/".env")`).
`server/app.py` insere o caminho no `sys.path` e importa o módulo.

### Robustez da leitura e da extração (não regredir)

Proteções aprendidas "na dor" — manter:

- **IMAP com timeout** (`_connect_imap`, `IMAP_TIMEOUT_SECONDS`, env `IMAP_TIMEOUT` default
  120s): sem timeout de socket, um `fetch` que estanca (mensagem grande, hiccup do servidor)
  **congela o run síncrono para sempre**. Com timeout, levanta `socket.timeout`, o e-mail é
  pulado/erra e o run segue. **Nunca** criar `IMAP4_SSL` sem `timeout`.
- **IMAP com retry/backoff** (`_connect_and_search`, `IMAP_MAX_ATTEMPTS` default 3,
  `IMAP_RETRY_BACKOFF` default 5s): connect + select + search são uma **unidade resiliente** —
  uma falha transitória (timeout de socket, `imaplib.IMAP4.abort`) refaz a sequência (nova
  conexão) com espera crescente. Erro de protocolo/login (`imaplib.IMAP4.error` puro) **não**
  repete (retry ali é inútil). Esgotadas as tentativas, levanta `RuntimeError` → o caller HTTP
  devolve `502`. `run_reader` monta o `criteria` **antes** de chamar `_connect_and_search`.
- **IMAP fechado em `try/finally`** (`run_reader`): o loop de leitura é envolto em `try` com
  `mail.logout()` no `finally` (best-effort) — uma exceção inesperada que escape do loop **não**
  deixa a conexão IMAP aberta. Os scripts manuais `reprocess_link_emails`/`reprocess_body_emails`
  seguem o mesmo padrão (logout em `finally`) e usam `_rfc822_from_fetch` (não `md[0][1]` direto).
  Teste: `tests/test_run_reader_logout.py`. **Nunca** voltar o `logout()` para fora do `finally`.
- **Reprocessadores abrem IMAP pelo helper canônico (A4-1 — não regredir):** os 3 scripts de
  reprocessamento manual (`reprocess_body_emails.py`, `reprocess_link_emails.py`,
  `reprocess_message.py`) conectam por **`R._connect_imap()`** (timeout de socket + login + select),
  não por `imaplib.IMAP4_SSL(...)` cru — um `fetch` que estanca não congela o reprocessamento.
  (`reprocess_ignored_emails.py` já usava.) **Nunca** reintroduzir `IMAP4_SSL` cru nesses scripts.
- **Claude API com timeout** (`extract_pdf.py`, `CLAUDE_API_TIMEOUT_SECONDS`, env
  `CLAUDE_API_TIMEOUT` default 90s): mesma classe de falha do IMAP. Sem `timeout` explícito o
  SDK Anthropic usa ~10 min/request; num run síncrono que processa muitos PDFs, **um request
  travado congela o pipeline inteiro**. As 3 instâncias `anthropic.Anthropic(...)`
  (`_try_barcode_vision`, `extract_with_vision`, `extract_fields_with_claude`) **sempre** passam
  `timeout=CLAUDE_API_TIMEOUT_SECONDS`. **Nunca** criar o client sem `timeout`.
- **Extração IN-PROCESS (não regredir — 2026-06-22)**: `run_extraction` chama
  `extract_pdf.extract_to_csv()` **no mesmo processo**, via import lazy — **não** mais um
  subprocesso `python extract_pdf.py`. Motivo: na busca geral de 2026-06-22, **100% das
  extrações falharam** com `rc=0xC0000142` (STATUS_DLL_INIT_FAILED) quando o spawn de
  subprocesso partia do processo do Flask — o subprocesso nem inicializava (DLLs nativas de
  pandas/Pillow não carregavam naquele contexto de *desktop heap*). O caminho do corpo
  (in-process) seguia funcionando; só o de PDF (subprocesso) caía. Chamar a função direto
  **elimina a criação de processo** → funciona idêntico no app (Flask), no CLI e no scheduler,
  e ainda evita reimportar pdfplumber/pandas/anthropic por PDF. **Nunca** voltar a
  `subprocess.run([sys.executable, extract_pdf.py])`. Ver memória `pdf-extraction-dll-init-fail`.
- **`run_extraction` resiliente**: retorna `(csv_path, motivo)`. `_run_extraction_once`
  classifica a falha — **transitória** (exceção de I/O/runtime → repete com backoff;
  `EXTRACTION_MAX_ATTEMPTS=3`/`EXTRACTION_RETRY_BACKOFF`) vs **definitiva** (extração não gerou
  registros → não repete). O `motivo` é gravado em `email_processing_errors.raw_payload`
  (`detalhe`) e fica **visível em `/erros`** — antes só ia para o console do Flask, fazendo um
  blip transitório parecer "tudo quebrado".
- **FETCH RFC822 robusto** (`_rfc822_from_fetch`): o `imaplib` pode **intercalar** respostas
  (um `FLAGS`/`UID` isolado como item `bytes`) no retorno do `fetch`. Aí `data[0]` não é a
  tupla `(meta, raw)` e `data[0][1]` indexa um `bytes`, devolvendo um **int** — e
  `email.message_from_bytes(int)` quebra com `'int' object has no attribute 'decode'`
  (crash intermitente). `process_message` usa `_rfc822_from_fetch(data)`, que varre `data`
  e pega a primeira tupla cujo 2º elemento sejam bytes. **Nunca** voltar a `data[0][1]` direto.
- **Reprocesso sem perda de dado** (`scripts/reprocess_ignored_emails.py`): a Fase A **não
  apaga** a linha de `email_control` antes de reprocessar — roda `process_message` (que
  re-registra com `ignore-duplicates` e cria a conta) e só então faz `PATCH` do status. Apagar
  antes arriscava perder o e-mail se a extração falhasse.

Testes: `tests/test_run_extraction.py`, `tests/test_imap_timeout.py`, `tests/test_imap_retry.py`,
`tests/test_status_for_result.py`, `tests/test_rfc822_fetch.py`, `tests/test_extract_pdf_timeout.py`,
`tests/test_pdf_amount_validation.py`.

### Deduplicação por `message_id`

Gravado em `email_control.message_id` (UNIQUE). `register()` usa
`Prefer: resolution=ignore-duplicates` — mensagens já processadas são ignoradas sem
atualizar o registro existente. Fallback local em CSV quando Supabase indisponível
(`SupabaseControl._available`).

### Fatura + boleto no MESMO e-mail → só o boleto vira conta (não regredir)

E-mail com **2 anexos** (uma **fatura/relatório** + um **boleto**) descreve **um único
débito**: "o boleto sempre vence". Regra (em `extract_and_store_accounts`):
- **fatura + boleto → extrai só o BOLETO** (a fatura é ignorada — geraria conta duplicada);
- **só fatura (sem boleto) → extrai a fatura** normalmente.

O sinal é o **CÓDIGO DE BARRAS** (`_is_boleto_barcode` — linha digitável 44 FEBRABAN moeda
'9' ou 48 de arrecadação) **+ o VALOR**, **NÃO** o `document_type`: o extrator rotula tanto o
boleto quanto o relatório como `boleto`, mas só o boleto tem linha digitável (o relatório traz
uma chave de 44 dígitos com moeda ≠ '9', ex.: padariabelga id 387). Por isso a decisão **não**
pode ser por `document_type`.

**GUARDA DE VALOR (não regredir — caso LMED id 519/520):** o descarte só vale para a linha
**sem** boleto próprio cujo **valor COINCIDE** com um boleto real do e-mail (a fatura/relatório
descreve o **MESMO** débito — mesmo valor). Uma linha de valor **DISTINTO** é **outra dívida** e
é **mantida mesmo sem barcode**. Isso cobre o **2º boleto ESCANEADO** (`pdf_vision`) cujo Vision
**não leu a linha digitável** — antes, bastava existir 1 boleto real para descartar QUALQUER
linha sem barcode, e o 2º boleto era **perdido silenciosamente** (e-mail "BOLETOS LMED": 2937
R$ 2.476,55 com barcode + 1748 R$ 1.166,67 sem barcode → só o 2937 virava conta). Bias
intencional: **preservar** a conta (perda silenciosa é pior que uma conta a revisar).

Implementação — `extract_and_store_accounts` roda em **DOIS PASSOS** (não regredir para o
loop anexo-a-anexo, que era cego ao resto do e-mail): **Passo 1** extrai TODOS os anexos e
coleta as linhas (`pending`); calcula `has_real_boleto = _email_has_real_boleto(pending)`
(algum anexo com boleto real) e `real_boleto_amounts = _real_boleto_amounts(pending)` (valores
dos boletos reais, normalizados por `_amount_key`). **Passo 2** grava as contas — uma linha
**sem** boleto próprio (`not _is_boleto_barcode(payload['barcode'])`) só é **ignorada** quando
`_amount_key(payload['amount']) in real_boleto_amounts` (mesmo valor de um boleto real → mesma
dívida). Skip intencional, logado, contado em `skipped_nonpayable`; **não** é `falha`. A regra
fica **acima** das validações (`sem_valor`/`sem_fornecedor`) e da dedup. Sem boleto no e-mail →
`real_boleto_amounts` vazio → nada descartado (a fatura é gravada). Casos preservados: carnê /
2 boletos reais (ambos com linha digitável → nenhum descartado); **2 boletos de valores
distintos, um sem barcode → ambos gravados**; boleto + guia com barcode de arrecadação (ambos
pagáveis). É **independente da ORDEM** dos anexos (o pré-scan do passo 1 decide antes de gravar).
Testes: `tests/test_fatura_boleto.py` (helper + fluxo completo com `run_extraction` mockado —
ordem inversa, valores distintos sem barcode, mesmo valor sem barcode ainda ignorado). **Limpeza retroativa** aplicada em 2026-07-03: hard delete de 7 faturas/relatórios
que coexistiam com o boleto do mesmo e-mail (ids 379/327/146/242/129/387/111; boletos
380/328/147/243/130/388/112 preservados) — todos os pares tinham valor idêntico.

### Documentos NÃO-pagáveis pulados no Passo 2 (baixa de recebível, assinatura/marketing — não regredir)

Duas guardas adicionais em `extract_and_store_accounts` **Passo 2**, no mesmo ponto e padrão
(`skipped_nonpayable`) dos skips CT-e/fatura+boleto — **acima** das validações
`sem_valor`/`sem_fornecedor`, para o e-mail virar `ignorado` (não `falha`) e **não logar erro**:

- **Baixa/cancelamento de RECEBÍVEL próprio** (`_is_receivable_notice(subject, description)`):
  e-mail sobre títulos que a **empresa EMITIU** (relatório de baixa/cancelamento, ex.: assunto
  "COBRANÇA OTIMOTEX" / "Cobranças não enviadas", ou descrição "Cancelamento (Baixa)…") — não é
  conta a pagar. Sinais: `_RECEIVABLE_SUBJECT_TERMS` (assunto) ou `_RECEIVABLE_DESC_RE` (descrição).
- **Conteúdo visual sem valor** (`_is_nonpayable_visual(row)`): imagem de **assinatura/logo de
  e-mail** (`image001.png` colada no corpo, Vision descreve "Assinatura de e-mail comercial") ou
  **apresentação/proposta de marketing** (ex.: GNW Business). **Conservador:** só dispara com
  `amount<=0` **E** sem código de barras — recibo/boleto legítimo (inclusive inline) tem valor
  e/ou linha digitável, então nunca cai aqui. Regex `_SIGNATURE_DESC_RE`/`_MARKETING_DESC_RE`
  sobre a `description`. **Limitação conhecida:** quando o Vision devolve só o contato cru (nome +
  telefone) em vez de "assinatura", a imagem não casa e cai em `sem_valor` (ex.: assinatura da
  Saito no e-mail de locação) — aceitável, vira lançamento manual.

Testes: `tests/test_nonpayable_rules.py`.

### Vencimento AUTORITATIVO pelo fator do código de barras (não regredir)

A data de vencimento de um boleto é **codificada pelo emissor no FATOR DE VENCIMENTO** do
código de barras FEBRABAN (posições 6-9, `d[5:9]`) — é **determinística** e imune à **inversão
dia/mês** que o Vision/OCR pode cometer ao ler a data IMPRESSA. Falha grave de origem (id 435):
boleto OBER cujo Vision gravou `2026-08-07` (07/08) no lugar de `2026-07-08` (08/07). Por isso,
sempre que houver boleto bancário com fator válido, o **vencimento derivado do barcode é a fonte
de verdade** e sobrescreve o valor extraído.

- **`due_date_from_barcode(barcode, ref_date)`** (`extract_pdf.py`): decodifica o fator só de
  **boleto bancário** (44 dígitos, moeda `'9'`, banco ≠ `000`); retorna `None` para fator 0
  (à vista), chave NF-e/CT-e ou arrecadação de 48. Trata o **reset da NT FEBRABAN** (o fator
  chegou a 9999 em 21/02/2025 e voltou a 1000 em 22/02/2025) escolhendo, entre a **base antiga**
  (`1997-10-07`) e a **nova** (`1000` = `2025-02-22`), a candidata mais próxima de `ref_date`
  (emissão/extração). As duas ficam ~24 anos distantes, então a escolha é **inequívoca**
  (`_FATOR_MAX_DELTA_DAYS = 730`: candidata a mais de 2 anos do ref é descartada).
- **`apply_barcode_due_date(rec)`** (`extract_pdf.py`): override idempotente do `due_date`, com
  `processing_notes`. Aplicado em `build_record_from_json`, `build_record_regex` e no dispatcher
  `build_record` (após o barcode ser recuperado por regex/Vision).
- **Rede de segurança UNIVERSAL** — `_apply_barcode_due_date(payload)` (`read_emails.py`) roda no
  **choke point único** `register_financial` (antes de `_apply_status_id`), cobrindo TODOS os
  caminhos de gravação do pipeline Python (PDF, corpo, reprocessos). Import lazy do `extract_pdf`,
  best-effort (qualquer falha é ignorada — não derruba a gravação). Contas do **corpo** não têm
  barcode → no-op.

- **GATE de CONSISTÊNCIA do barcode (id 463 — não regredir):** o fator só é AUTORITATIVO quando o
  barcode é **confiável** — o **valor embutido nele** (`amount_from_barcode`, posições 10-19) bate
  com o `amount` extraído (tolerância 1 centavo). Um barcode **mal lido pelo OCR** (comum em boleto
  **ESCANEADO** → `pdf_vision`) tem valor divergente e **NÃO** dita o vencimento. Falha real (id 463
  CIPATEX, e-mail "BOLETOS CIPATEX" com 3 anexos escaneados): o Vision leu a data impressa **certa**
  (`2026-07-10`) e o valor certo (R$ 32.400), mas leu o **barcode embaralhado** (valor R$ 2.026.142,93,
  fator 1259) — a regra do fator sobrescreveu o vencimento correto por `2025-11-08` (impossível: <
  emissão). A blindagem centraliza tudo em **`authoritative_barcode_due_date(barcode, amount, ref,
  issue_date)`** (`extract_pdf.py`), usada pelos **dois** pontos de aplicação (`apply_barcode_due_date`
  e a rede `_apply_barcode_due_date`): devolve o vencimento **só** com barcode consistente. Preserva a correção
  original (id 435: barcode consistente → corrige a inversão) e mata o novo erro (barcode corrompido →
  mantém a data impressa). **Varredura (2026-07-10):** dos 167 boletos, 6 têm barcode inconsistente;
  só o 463 fora vítima (os outros 4 com erro de casa decimal geram fator fora de faixa → `None`, nunca
  sobrescreveram; 194 já divergia). id 463 corrigido para `2026-07-10`.
- **GATE 2 — PLAUSIBILIDADE + PRIORIDADE da data impressa (id 473/474 — não regredir):** dois reforços
  para boleto **SECURITIZADO/renegociado** cujo fator da linha digitável ficou o ORIGINAL (stale) e
  diverge do vencimento IMPRESSO (HYOSUNG via SB Crédito: fator 1051 → 2025-04-14, mas impresso
  2026-07-21). (1) `authoritative_barcode_due_date` ganhou o parâmetro `issue_date` e rejeita
  (`None`) quando `venc < emissão` (impossível — fator stale/errado), além do gate de valor. (2)
  **A data de vencimento IMPRESSA no TEXTO do PDF é a fonte PRIMÁRIA** (análise do PDF real >
  LLM > fator): `extract_due_date_from_text(raw)` ancora no rótulo "Vencimento" (ignora "Data do
  Documento"/"Data Movto") e, quando plausível (≥ emissão), **vence** o LLM e o barcode em
  `build_record` (caminho `pdf_text`). O fator só volta a mandar em PDF **escaneado** (sem texto —
  onde corrige inversão do Vision, id 435). **Coerência entre as duas camadas (não regredir):** a rede
  universal de `register_financial` NÃO reestraga a data impressa que o `build_record` já gravou —
  para o boleto de texto, o **gate 2 (venc < emissão) rejeita** o fator stale (`None`), então a rede é
  no-op; para o escaneado, o fator consistente corrige a inversão. As duas camadas convivem sem
  conflito (verificado em payloads frescos). Dados: 473/474 (1 conta errada cada) → reprocessados em
  **8 contas** (ids 488-495, 4 parcelas/carnê, venc. 21/07…11/08/2026).
- **Split de carnê com linha digitável QUEBRADA (id 473/474 — não regredir):** `_boleto_pages` detecta
  boletos por `extract_linha_digitavel`; num carnê HYOSUNG a linha vinha **quebrada em 3 linhas**
  (`…630000 1` / `ITAU 341-7` / `10510000356008`) e os 3 regex falhavam → 0 páginas → **1 conta em vez
  de 4**. Um 4º padrão em `extract_linha_digitavel` (captura os 4 campos + o 1º bloco isolado de 14
  dígitos, `re.DOTALL`, ignorando ruído no meio) restaura a detecção → carnê dividido em 1 registro por
  boleto. **Limitação:** carnê **escaneado** (sem texto) segue sem split (evolução futura: Vision
  multi-boleto).

Testes: `tests/test_barcode_due_date.py` (fator real do id 435 → `2026-07-08`; desambiguação do
reset; fator 0; não-boleto; correção de inversão; no-op quando já bate; **gate de consistência:
barcode corrompido do id 463 NÃO sobrescreve a data correta**). **Deploy:** mudança só
em Python — copiar `extract_pdf.py` **e** `read_emails.py` para produção (ver "Deploy manual do
Email Reader"). A trigger de banco recalcula `a vencer`/`vencido` a partir do `due_date` corrigido.

### Dedup de conteúdo + reemissão (`financial_account_control`)

Além do dedup por `message_id`, `find_financial_duplicate(payload)` evita gravar o
**mesmo documento** chegado em e-mails diferentes. Casa por 4 impressões: (1) barcode;
(**1b**) **`sk_supplier`** + `nosso_numero` — ver abaixo; (2) **`sk_supplier`** + `invoice_number`
(≥6) + valor — pega **guia/DAS reemitida** com o mesmo número e vencimento novo; (3) **`sk_supplier`**
+ valor + vencimento (**+ tipo só quando o novo NÃO tem barcode** — ver abaixo). Quando encontra
duplicata, `extract_and_store_accounts` **não cria outra conta**: se a reemissão tem
vencimento **mais recente**, chama `update_financial` para atualizar `due_date` + boleto
(`barcode`, `amount_charged`, `fine_interest`, `other_additions`) na conta existente — uma
guia paga uma vez, sempre com o boleto válido. A trigger recalcula a situação em `status` no
UPDATE (só quando em aberto — migration 034).

**Impressão 1b — `sk_supplier` + `nosso_numero` (identificador ESTÁVEL do título — não regredir):**
o **nosso número** é o identificador do título no banco e a **2ª via / aviso de vencimento MANTÉM o
mesmo** — mesmo quando a reemissão muda **VALOR (juros) E VENCIMENTO** ao mesmo tempo, combinação que
faz as impressões 1/2/3 falharem (o barcode difere pelo fator+valor; a 2 exige valor igual; a 3 exige
valor E vencimento iguais). Falha real **ids 323/560** (fatura SIEG): o aviso de vencimento reemitiu
com **+juros** (435,18 → 444,01) e **venc +1 dia** (15/07 → 16/07), gerando conta duplicada porque
NENHUMA das 3 impressões casou — mas o `nosso_numero` `000000091070-8` é idêntico. A 1b roda **após o
barcode e antes das 2/3** (identificador forte), escopada por fornecedor (o nosso número é único por
beneficiário/título). Guarda `_is_real_nosso_numero` (**≥8 dígitos, não só zeros**) evita fundir
títulos distintos por nosso número vazio/curto/lixo. Casada, cai no mesmo caminho de reemissão (atualiza
o vencimento/boleto da conta existente). Varredura do banco: só **1** grupo duplicado por nosso número
(323/560) — o 560 foi **hard-deletado** (2026-07-16), 323 preservado. Testes: `tests/test_dup_nosso_numero.py`.
Este era o bug "aleatório" de duplicidade: só se manifestava quando a reemissão alterava valor **e**
vencimento juntos. **Deploy:** copiar só `read_emails.py` (sem `.env`/banco). **Limitação conhecida:** a
1b compara o `nosso_numero` como TEXTO (`=eq.`) — cobre reemissões do mesmo gerador/formato (o caso
real); variação de formatação do nosso número entre reemissões não é coberta (evolução futura:
normalizar por dígitos, se surgir).

**Impressão 3 casa por `sk_supplier`+valor+vencimento, INDEPENDENTE do `document_type`
(robustez cross-e-mail — não regredir):** regra de negócio — **se fornecedor + valor +
vencimento coincidem, é a MESMA conta a pagar**; o `document_type` varia entre os documentos
que descrevem a dívida (`boleto` no PDF, `fatura`/`outro`/`pix` no corpo). Antes a impressão 3
exigia `document_type` igual e deixava a duplicata passar em **qualquer ordem de chegada**,
criando 2 contas — casos reais **ids 7/176** (ESPRO), **217/218** e **511/512** (Smart Web).
O tipo **saiu** da impressão 3. Distinção que permanece — **código de barras**:
- **Novo doc COM barcode** (boleto autoritativo): casa `sk_supplier`+valor+vencimento com
  `barcode=is.null` — só candidatos SEM linha digitável (conta do corpo/notificação da mesma
  dívida). Boletos DISTINTOS (cada um com barcode próprio, ex.: parcelas HYOSUNG, guias GNRE de
  R$ 399,03) **NÃO** se fundem: candidato com barcode ≠ é documento distinto (a impressão 1 já
  teria casado se fosse o mesmo).
- **Novo doc SEM barcode** (corpo/notificação/reemissão): casa **qualquer** conta da mesma
  dívida (`sk_supplier`+valor+vencimento), inclusive um boleto já gravado com barcode — um
  documento sem linha digitável nunca é um 2º pagável legítimo, então é a mesma dívida.

**Enriquecimento:** quando um boleto casa uma conta do corpo **sem barcode** (vencimento igual),
`extract_and_store_accounts` grava a linha digitável do boleto na conta sobrevivente (o boleto
sempre vence o corpo), sem duplicar. Testes: `tests/test_dup_barcode_synthetic.py`
(`DedupCrossTypeBodyTest` + `test_corpo_casa_boleto_existente_qualquer_ordem`) e
`tests/test_boleto_dedup_suppresses_body.py` (enriquecimento). **Limpeza retroativa** (2026-07-13):
hard delete das duplicatas do corpo ids 7 (mantido 176), 218 (mantido 217) e 512 (mantido 511,
enriquecido com o barcode). **NÃO são duplicatas** (preservados): boletos distintos de mesmo
valor/vencimento com barcodes próprios (HYOSUNG 286/287, GNRE 297/300 e 329/330, DAMSP 267/402)
e lançamentos manuais com números distintos (Multa 411/412).

**Retry da consulta de dedup (robustez de rede — não regredir):** um hiccup de rede na
consulta de duplicidade (`_find`) faria `find_financial_duplicate` retornar `None` ("sem
duplicata") e o pipeline **gravaria conta duplicada**. Por isso `_find` **re-tenta** em falha
transitória (`DUP_QUERY_ATTEMPTS` default 3, backoff `DUP_QUERY_BACKOFF` default 1,5s × tentativa)
antes de desistir; um resultado **vazio** (`rows == []`) NÃO é erro — retorna `None` de imediato
(não re-tenta). Esgotadas as tentativas, retorna `None` (não bloqueia a inserção
indefinidamente) após logar. Testes: `tests/test_dup_barcode_synthetic.py`
(`DedupQueryRetryTest`).

**Boletos DISTINTOS não podem fundir por número SINTÉTICO nem por valor/vencimento
quando têm código de barras próprio (não regredir):** quando o PDF não traz Nº do
documento nem vencimento, o pipeline gera um `invoice_number` **sintético**
(`{tipo}_{ddmmaa}` ou `PIX_…`) e *defaulta* o vencimento p/ a data da extração. Dois
boletos diferentes do mesmo fornecedor com o **mesmo valor** colidiam nessas duas
impressões e a dedup **perdia** um deles (caso real: HYOSUNG 181063-1/2/3 e 5 guias GNRE,
duas de R$ 399,03). Correção em `find_financial_duplicate`: a **impressão 2 IGNORA número
sintético** (`_is_synthetic_invoice_number` — só Nº PRÓPRIO do documento é chave; a reemissão
de DAS/guia segue funcionando por número real) e a **impressão 3 só casa candidatos SEM
barcode quando o NOVO tem barcode** (`barcode=is.null`) — código de barras presente e
diferente = documento distinto (a impressão 1 já teria casado se fossem o mesmo). Sem barcode
no novo (corpo do e-mail), a impressão 3 casa por `sk_supplier`+valor+vencimento (ver a regra
detalhada abaixo — o `document_type` **não** entra na impressão 3). Testes:
`tests/test_dup_barcode_synthetic.py`.

**A dedup casa por `sk_supplier`, não por texto do fornecedor** (migrations 040/041/042): o
fornecedor é resolvido ANTES da dedup por `_finalize_supplier` (RPC
`resolve_supplier_for_account` → `SupabaseControl.resolve_supplier`), que grava
`payload['sk_supplier']` e **remove** as colunas brutas `supplier_name`/`supplier_cnpj`/
`supplier_cpf` do payload. Como a resolução já normaliza nome/CNPJ (via `resolve_supplier_id`:
CNPJ → CPF → e-mail → `normalize_search(legal_name/trade_name)` → auto-insert), a antiga dedup
por nome (RPC `financial_dup_by_name` / `_dup_by_name`) foi **removida** — "EFE Displays" e
"EFE DISPLAYS" deduplicam por já resolverem o mesmo `sk_supplier`. Teste:
`tests/test_dup_by_supplier_id.py`.

### Duas chaves Supabase, dois papéis

- **`anon`** (`VITE_SUPABASE_ANON_KEY`): frontend — leitura REST, respeita RLS `TO authenticated`.
- **`service_role`** (`SUPABASE_SERVICE_KEY`): scripts Python/Flask — escrita, ignora RLS.

### Normalização de `document_type`

`extract_pdf.py` usa `_ns()` (strip de acentos + lowercase) para lookup em `_DOC_TYPE_NORM`.
CHECK constraint em `financial_account_control.document_type` usa `lower()` (migrations 014,
017, **024**, **026**, **043**, **062**, **066** e **075**). Tipos aceitos incluem: `boleto`, `cte`, `nfe`, `nfse`, `tributo`,
`das`, `seguro`, `fatura`, `recibo`, `contrato`, `honorários`, `container`, `multa`, `dare`, `cartório`, `outro`
(DAS de Simples Nacional → `das`; **`multa`** = multa/penalidade/juros avulsos, auto de
infração; **`dare`** = Documento de Arrecadação de Receitas Estaduais, antes dobrado em `dae` — a
migration 062 separou DAE=eSocial de DARE=estadual em `_DOC_TYPE_NORM`/`_BODY_DOC_KEYWORDS`).
**`pix` NÃO é tipo de documento (removido na migration 075)** — é só forma de pagamento
(`PAYMENT_METHODS`). Um pagamento PIX sem outro indício de tipo fica `document_type='outro'` e
`payment_method='pix'`; quando não há Nº de documento próprio, o sintético é
**`{payment_method}_{valor}`** (`pix_R$ …`) para PIX+`outro`, senão `{tipo}_{ddmmaa}`. As antigas
fontes de `document_type='pix'` (`apply_pix_override` no PDF e o ramo `has_pix` do corpo) foram
removidas — o backfill da 075 converteu os `pix` existentes em `outro`.
`container` = frete/demurrage/movimentação de
contêineres (keyword de assunto + classificação no corpo e PDF; migration 026).
`SKIP_ACCOUNT_TYPES = ['nfe', 'nfse']` — não geram conta a pagar.

**Cartório (`cartório`) — pagamento de/em cartório (não regredir):** custas de
tabelionato/registro/protesto. Classificado por **contexto no ASSUNTO ou no NOME DO
FORNECEDOR** — a palavra `cartorio`/`cartório` (ou `tabelionato`/`tabeliao`), por palavra
inteira sem acento (`_is_cartorio_context`, `read_emails.py`). `_apply_cartorio_doc_type`
**só re-rotula tipos genéricos** (`boleto`/`outro`/`pix`), preservando guias/utilities/`cte`/
`honorários` (um ITBI pago no cartório continua ITBI). Aplicado nos **dois caminhos**
(`build_financial_payload` do PDF e `extract_from_email_body` do corpo), **abaixo** de
utility/tax/transporte. `extract_pdf.py` também mapeia `cartorio`/`tabelionato` → `cartório`
em `_DOC_TYPE_NORM` (caso o Claude emita o tipo direto). Keyword de assunto (`cartório`/
`cartorio`/`tabelionato`) em `KEYWORDS_DEFAULT` **e** no `EMAIL_KEYWORDS` do `.env`. Caso de
origem: id 400 ("PAGAMENTO CARTORIO ...", boleto real → re-rotulado `cartório`). A migration
066 amplia o CHECK + faz backfill dos genéricos com contexto de cartório no assunto. Teste:
`tests/test_doc_type_cartorio.py`.

**Classificação contábil AUTOMÁTICA de GUIAS TRIBUTÁRIAS (extração — não regredir):** para
**e‑mails tributários** (`_is_tax_document`, `document_type` ∈ `darf, das, gru, dae, dare, gnre,
ipva, iptu, dam, duam, dam / duam, iss, itbi, gare, tributo`), a guia é **relacionada
automaticamente ao plano de contas** (`financial_chart_of_account`) pelo TIPO/CONTEXTO do imposto,
determinando `cost_center_id`/`chart_account_id` — **NÃO** a partir do `supplier`. **Precedência
MÁXIMA:** essa regra determinística **VENCE** o default do fornecedor e as demais regras; e **grava
com write‑back** (o `supplier` é atualizado com o mesmo destino, exceto **OTIMOTEX** `sk=1` e
**funcionário** — trigger `trg_supplier_no_funcionario_classification`). Quando **não** dá para
determinar (sem sinal, `tributo` sem esfera, ou código ausente no cadastro), **não força** — cai no
comportamento atual (default do fornecedor).

O alvo é sempre um **`account_code`** do plano, resolvido para `(cost_center_id, chart_account_id)`
por `SupabaseControl.classification_for_account_code(code)` (cacheado, `:640`) — **não hardcodar ids**
(se o cadastro reclassificar, a regra acompanha). Resolvedor `_resolve_tax_chart_code(document_type,
blob, sender_email)` em **3 níveis** (blob = assunto+descrição+corpo, sem acento via `_ns_body`/
`_has_word`):

1. **Frase/combinação específica** (maior prioridade): `_ICMS_IMPORT_PHRASES`→`4.3.05` (ICMS
   Importação); `_ICMS_ST_PHRASES` **ou** GNRE de `@lebianco` (`_is_lebianco_sender`)→`4.1.02`
   (ICMS‑ST); `imposto de importacao`→`4.3.01` (II); `pis`+`cofins`+(`csll`/`retid`)→`4.2.05`.
2. **Por `document_type`** (a guia já determina o imposto — vem ANTES do scan p/ não rebaixar GNRE):
   `gnre`→`4.4.01` (GNRE a Recolher), `gare`→`4.1.01` (ICMS), `iss`→`4.1.06`, `ipva`→`6.4.02`,
   `iptu`→`6.4.01`, `das`→`4.4.04` (Taxas Federais — Simples sem conta dedicada).
3. **Palavra‑chave distintiva** no texto (refina DARF/DARE/GRU): `irrf`→`4.2.03`, `irpj`→`4.2.01`,
   `csll`→`4.2.02`, `inss`→`4.2.04`, `iss`→`4.1.06`, `ipi`→`4.1.03`, `cofins`→`4.1.05`, `pis`→`4.1.04`,
   `icms`→`4.1.01`, `ipva`→`6.4.02`, `iptu`→`6.4.01`.
4. **Fallback por ESFERA** do `document_type`: federal (`darf`/`gru`/`dae`)→`4.4.04`; estadual
   (`dare`)→`4.4.02`; municipal (`dam`/`duam`/`dam / duam`/`itbi`)→`4.4.03`. `tributo` (sem esfera)
   **não força** (evita mis‑forçar boleto de fornecedor mal‑rotulado).

`resolve_forced_classification(ctrl, document_type, subject, *extra_texts, sender_email, sk_supplier)`
→ `(cc, ca, write_back)`: se `_is_tax_document`, o fornecedor **não** está excluído (ver EXCLUSÃO
abaixo) e o resolvedor devolve um code com cc/ca ≠ 0/0 → `(cc, ca, True)`. Aplicado por
`apply_forced_classification` (que passa `sk_supplier`) APÓS `_finalize_supplier` e ANTES da
gravação, nos dois caminhos (PDF em `extract_and_store_accounts`; corpo em `try_extract_from_body`,
onde os clones de parcela herdam a classificação). Write‑back via `update_supplier_classification(sk,
cc, ca)` (PATCH `supplier`, best‑effort; nunca `sk=1`). As regras antigas fixas (IRRF/ICMS‑Import) e
por‑código (DAM/DUAM→ISS, GNRE‑ST) foram **subsumidas** pelo resolvedor (removidas
`_detect_forced_classification`/`_chart_code_for_document` e as constantes `CC_FISCAL`/`CA_IRRF`/
`CA_ICMS_IMPORT`/`DAM_DUAM_*`/`GNRE_ICMS_ST_CHART_CODE`). **Mudanças de comportamento:** DAM/DUAM sai
de ISS (4.1.06) → Taxas Municipais (4.4.03); GNRE sem ST agora classifica (4.4.01, antes 0/0);
IRRF/ICMS‑Import/GNRE‑ST/DAM passam a fazer **write‑back**; um CT‑e com "IRRF" no texto segue como
transporte (não é tributário). **TRANSPORTE (não‑tributário) preservado à parte:** CT‑e/frete →
`CC_LOGISTICA`(4)/`CA_TRANSPORTADORAS`(339), com write‑back, só por assunto+document_type
(`_is_transport_context`). Backfill retroativo: `scripts/reprocess_classification_overrides.py`
(`--dry-run`, reusa `resolve_forced_classification`). Testes: `tests/test_classification_overrides.py`.
**Backfill APLICADO em 2026-07-10** (11 guias tributárias legítimas reclassificadas —
DAM/DUAM→Taxas Municipais, DARE→Taxas Estaduais, DAS→Taxas Federais, GNRE→GNRE a Recolher,
IPTU→conta dedicada) + **write-back** em 4 fornecedores (CONTABIL ESQUEMA→GNRE, Receita Federal
×2→Taxas Federais, PREFEITURA SP→Taxas Municipais). **Correção de dados do Dr. Ricardo (sk 1262):**
7 contas (ids 423‑429) normalizadas para **reembolso** (`recibo`/`pix`, Jurídico/Reembolsos 14/530);
a 425 estava órfã em Fiscal/ICMS-Import (3/11) e foi corrigida — depois disso a guarda de exclusão
foi criada para impedir reincidência.
**EXCLUSÃO de fornecedor (não regredir):** fornecedores em
`TAX_CLASSIFICATION_EXCLUDED_SK_SUPPLIERS` (hoje `{1262}` = **Dr. Ricardo**, despachante) **NÃO**
recebem a classificação tributária forçada — a regra é pulada (o `sk_supplier` é passado a
`resolve_forced_classification`) e a conta mantém o **default do fornecedor** (Dr. Ricardo =
Jurídico/Reembolsos 14/530). Motivo: as contas dele são **reembolso de tributos, honorários e
outros tipos jurídicos**, nunca conta fiscal pura, mesmo quando o documento é uma guia de
arrecadação (Junta Comercial). Ver memória `dr-ricardo-reembolso`. **Risco residual:** outro
fornecedor mal‑rotulado como tributário (ainda não na allowlist de exclusão) seria classificado
por esfera — acrescentar o `sk_supplier` ao set quando identificado.

**CT-e / transporte: só o BOLETO gera conta; o CT-e fiscal é ignorado (não regredir):** o
CT-e (Conhecimento de Transporte) é documento **fiscal**, não pagável — quem se paga é o
**boleto** de frete. Regra (espelha a NF-e, mas condicional ao boleto):
- **CT-e/transporte SEM boleto → não gera conta; e-mail vira `ignorado`** (não `falha`).
- **CT-e/transporte COM boleto → extrai só o boleto**, rotulado `document_type='cte'`.
- **Boleto de transporte → `document_type='cte'`** quando o **contexto é de transporte**:
  assunto com `cte`/`ct-e`/`dacte`/`conhecimento de transporte`/`transporte`/`transportadora`,
  **ou** fornecedor de transporte (nome com `transporte(s)`/`transportadora`/`logística`/
  `cargas`/`encomendas`/`frete(s)`), **ou** já classificado `cte`.

Implementação em `read_emails.py` (não em `extract_pdf.py`, que continua classificando CT-e por
chave de acesso): helpers `_is_transport_supplier`, `_is_transport_context` e
`_apply_transport_boleto_doc_type` (mesmo padrão de `_classify_utility_by_supplier`). O
**boleto** é distinguido da chave de acesso NF-e/CT-e por `_is_boleto_barcode` (44 FEBRABAN
moeda '9' ou 48 de arrecadação; a chave de acesso de 44 dígitos **não** casa). O re-rótulo
boleto→cte é aplicado nos **dois caminhos** (`build_financial_payload` do PDF e
`extract_from_email_body` do corpo), **abaixo** de utility/tax (uma transportadora que manda um
DARF continua DARF — só tipos genéricos `boleto`/`outro`/`pix`/`cte` são re-rotulados) e **acima**
de `boleto`. O **skip** de CT-e-sem-boleto ocorre em `extract_and_store_accounts` (que passa a
retornar também `nonpayable_only`) e em `try_extract_from_body` (novo retorno `BODY_IGNORED`); o
status `ignorado` vem de `status_for_result(nonpayable=…)`, posicionado **antes** de
`csv_generated` (o PDF do CT-e gera CSV mas nenhuma conta — senão viraria `extraído`, errado).
Caso misto (CT-e fiscal + boleto no mesmo e-mail): o boleto grava → `accounts_saved>0` →
`extraído`; o CT-e é pulado. Testes: `tests/test_doc_type_transporte.py` (+ casos `nonpayable` em
`tests/test_status_for_result.py`). **Limpeza retroativa** dos dados já gravados:
`scripts/reprocess_cte_accounts.py` (aplicado em 2026-07-02 — Fase A re-rotulou 28 boletos de
transporte para `cte`; Fase B **hard delete** de 100 CT-e fiscais + 87 e-mails → `ignorado`;
estado final: as únicas contas `cte` são boletos de transporte).

**CEDENTE do boleto vence o EMITENTE do CT-e agregado (fatura SSW — não regredir):** numa
fatura de transporte que **agrega um ou mais CT-e**, o credor é o **cedente/beneficiário do
boleto** (a transportadora que EMITE a fatura e recebe o pagamento), **não** o **emitente do
CT-e** (a transportadora física SUBCONTRATADA). O extrator, vendo o bloco "IDENTIFICAÇÃO DO
EMITENTE" do CT-e, gravava o subcontratado como fornecedor — falha real id 528 (fatura
CAMPINENSE Nº 0324348, R$ 502,40) gravada sob **TRANSPORTADORA J.D.F.** (o CT-e agregado).
Correção em **duas camadas** (defesa em profundidade):
- **Prompt (`extract_pdf.py`, soft):** a seção CT-e ganhou a "PRIORIDADE DO CEDENTE DO BOLETO"
  — se o documento tem boleto (linha digitável / 'Cedente' / 'Nosso Número'), o
  `supplier_name`/`supplier_cnpj` é o cedente; a regra de EMITENTE vale só para **DACTE/CT-e
  PURO** (sem boleto).
- **Guarda determinística (`read_emails.py`, robusta — imune à variação do LLM):**
  `_ssw_cedente_from_body(sender, body, own_cnpj)` extrai o cedente do CORPO da fatura SSW
  (`sswsistemas.com.br`) — nome via "…realizados por `<NOME>`" e CNPJ do rodapé (o CNPJ
  mascarado que **não** é o da própria OTIMOTEX). Em `extract_and_store_accounts`, para a linha
  que **é boleto real** (`_is_boleto_barcode`), o cedente do corpo **sobrepõe** o fornecedor
  extraído (`[CEDENTE-SSW]`) antes de `_finalize_supplier`; como a resolução prioriza CNPJ, o
  fornecedor correto é resolvido/criado de forma determinística. **Degrada com segurança**:
  remetente não-SSW ou corpo sem cedente → nenhum override (comportamento atual). O
  `process_message` passa `body_text` à função; os reprocessadores históricos
  (`reprocess_link_emails`) usam o default `body_text=""` (no-op). Testes:
  `tests/test_ssw_cedente.py`. Correção pontual do id 528 aplicada em 2026-07-14 (fornecedor →
  CAMPINENSE TRANSPORTE DE CARGAS LTDA, sk 1278; nº doc → `0324348`).

**Beneficiário Final vence Beneficiário/Cedente (boleto securitizado — não regredir):** em boleto
**securitizado/factoring**, o "Beneficiário"/"Cedente" é a securitizadora/empresa de COBRANÇA e o
**"Beneficiário Final"** é o credor REAL (o fornecedor que vendeu) — o fornecedor da conta é o
**BENEFICIÁRIO FINAL**. Falha real (ids 561/562, "BOLETOS INORGAN"): boleto gravado sob **MB COBRANCAS
LTDA** (CNPJ 45.175.261/0001-80, o Beneficiário) sendo o correto **INORGAN INDUSTRIA QUIMICA LTDA**
(56.879.838/0001-51, o Beneficiário Final). Correção em `extract_pdf.py`:
- **Prompt (soft):** já prefere `beneficiario final > beneficiario > cedente` (linha ~152), mas o LLM
  às vezes escolhe o Beneficiário mais proeminente.
- **Override DETERMINÍSTICO (robusto — imune ao LLM):** `extract_beneficiario_final(text)` acha o
  rótulo "Beneficiário Final" no TEXTO do PDF (nome + CNPJ, na mesma linha OU nas 1-2 seguintes) e
  `apply_beneficiario_final(rec, raw)` **sobrescreve** `supplier_name`/`supplier_cnpj` (e zera
  `supplier_cpf`), aplicado no fim de `build_record` do caminho **pdf_text** (após o barcode, antes do
  `return`). Vale para os dois sub-caminhos (LLM e regex fallback). **Vision (`pdf_vision`/
  `image_vision`) NÃO tem o texto do PDF** (o `raw` é a resposta JSON) → depende do prompt.
- **EXIGE o CNPJ do beneficiário final (não regredir — o cerne da robustez):** "Beneficiário Final"
  também aparece como **RÓTULO DE COLUNA** no cabeçalho de MUITOS boletos (ex.: "Ag./Cód. Beneficiário
  Final") — aí o texto ao lado é lixo/o próprio beneficiário, **sem CNPJ**. A varredura completa
  achou **2 casos REAIS com CNPJ** (561/562) vs **36 rótulos-de-coluna sem CNPJ** (BRASPRESS, STC,
  SEVEN EXPRESS…). Por isso o override **só atua quando há CNPJ** ao lado do rótulo (tanto no pipeline
  quanto no backfill) — o CNPJ é o discriminador entre securitização REAL e rótulo de coluna. Sem
  isso, o pipeline corromperia o fornecedor dos 36. Testes: `tests/test_beneficiario_final.py` (inclui
  o caso do rótulo-de-coluna → no-op).
- **Backfill:** `scripts/reprocess_beneficiario_final.py` (`--dry-run`/`--ids 561,562`) varre as contas
  `pdf_text` com `source_file`, baixa o PDF do bucket, extrai o beneficiário final (mesmo extractor) e
  re-aponta `sk_supplier` (resolve/cria via RPC) **só quando o CNPJ difere**; name-only vira revisão
  manual (logado, não aplicado). Idempotente. **Aplicado em 2026-07-16:** ids 561/562 → INORGAN
  (sk 944, CNPJ 56.879.838/0001-51); os 36 name-only foram corretamente ignorados. **Deploy:** copiar
  só `extract_pdf.py` (o `read_emails.py` NÃO muda; sem `.env`/passo de banco).

**Override de GUIA TRIBUTÁRIA pelo ACRÔNIMO no ASSUNTO (não regredir):** guias estaduais
são visualmente quase idênticas (DARE × GARE × GNRE) e o Claude do `extract_pdf.py` troca
uma pela outra (caso real: id 326, assunto "PAGAMENTO DARE - REF. T05S1" extraído do
`pdf_text` como `gare`). Regra: o **acrônimo explícito no assunto é o sinal mais confiável**
do tipo de guia (quem encaminha o pagamento digita o tipo certo) e **sobrepõe** a
classificação do PDF/corpo. `_classify_tax_doc_type_from_subject(subject)`
(`_SUBJECT_TAX_DOC_KEYWORDS`) casa por **palavra inteira** (`_has_word`, sem acento) →
`darf/gps/das/gru/dare/dae/gnre/gare/ipva/iptu/iss/itbi/dam / duam/multa`. **Conservador:**
`das` (artigo do português) e `dam` **não** casam pela forma pura — só por frase inequívoca
(`simples nacional`/`simei`) para não gerar falso positivo em "pagamento DAS contas".
Aplicado nos **dois caminhos** com precedência **abaixo da concessionária** e **acima** de
honorários/PIX/keyword: `build_financial_payload` (PDF) e `extract_from_email_body` (corpo).
O prompt do `extract_pdf.py` também instrui o Claude a copiar EXATAMENTE o acrônimo impresso
no cabeçalho (não inferir pelo estado). Teste: `tests/test_doc_type_tax_subject.py`.

**Contas de concessionária** (migration 043): `conta de água`, `conta de luz` e
`conta de telefone / internet` (com barra, estilo `dam / duam`). Classificadas em `read_emails.py`
por **duas regras** (palavra inteira via `_has_word`, sem acento via `_ns_body`), ambas com
**precedência máxima** sobre boleto/fatura/PIX:
- **Frase do assunto/corpo** — `_UTILITY_DOC_KEYWORDS` + `_classify_utility_doc_type(*texts)`:
  água=`conta (de) água`; luz=`conta (de) luz`; telefone/internet=`conta (de) telefone|internet`,
  `(conta) vivo`, `vivo (conta)`, `vivo`, `fibra`.
- **Marca no NOME DO FORNECEDOR** — `_UTILITY_SUPPLIER_BRANDS` +
  `_classify_utility_by_supplier(supplier_name)`: `enel`/`eletropaulo`→luz;
  `vivo`/`claro`/`tim`→telefone-internet; `sabesp`→água. **Escopo restrito ao `supplier_name`** de
  propósito: `claro`/`tim`/`vivo` são palavras comuns no corpo ("está claro", "ao vivo") — casar no
  corpo livre geraria falso positivo.

Aplicadas no corpo (`extract_from_email_body`, recebe `subject`) e no PDF
(`build_financial_payload`, recebe `subject` — `extract_pdf.py` é cego ao assunto, então o override
é em `read_emails.py`); a frase tem precedência sobre a marca (`frase or marca`). `payment_method`
permanece o detectado (não é forçado). Geram conta a pagar (não entram em `SKIP_ACCOUNT_TYPES`).
Teste: `tests/test_doc_type_utilities.py`.

**Captura do nº de documento no corpo** (migration 043 / `_BODY_DOCNUM_RE`): além de
`_BODY_INVOICE_RE` (NF/fatura + dígitos), o rótulo **explícito** `Número do documento` captura
valores **alfanuméricos** (ex.: Sabesp `SOR202659903949`, CATAGUASES `014696-001`) como fallback,
antes do SIEG e antes do nº sintético `{tipo}_{ddmmyy}`. Conservador de propósito — rótulos
frouxos (`documento nº`) capturavam lixo ("Banco"). Backfill da migration 043 corrigiu os ids 5,
18 e 171.

**Regra honorários** (migration 024): e-mail de honorários (keyword de assunto `honorário`;
termo `honorário(s)` no corpo ou recibo) é gravado com `document_type='honorários'` e
`payment_method='pix'` — honorários mantêm o tipo `honorários` mesmo com PIX detectado (o PIX só
define a forma de pagamento, nunca o tipo — ver a nota sobre `pix` removido dos tipos de documento),
e o pagamento é forçado a `pix` tanto no corpo (`extract_from_email_body`) quanto no PDF
(`build_financial_payload`).

**Forma de pagamento DECLARADA no corpo → `payment_method` (não regredir):** quando o pagador
escreve como pagou (ex.: "PAGAMENTO EM DINHEIRO", "pago depósito", "TED AGÊNCIA…", "Tipo de
pagamento: Débito Automático"), a forma é capturada em vez de cair em `outro`. Caso de origem:
id 442 (MANOS DOCES, R$ 182,49, "PAGAMENTO EM DINHEIRO") gravava `outro` → agora `dinheiro`.
`_classify_body_payment_method(*texts)` (`read_emails.py`) casa por **palavra inteira sem acento**
(`_has_word`/`_ns_body`) contra `_BODY_PAYMENT_METHOD_KEYWORDS` e devolve o valor do enum
`PAYMENT_METHODS` (`dinheiro`/`depósito`/`débito automático`/`crédito`/`débito`/`cartão`/`ted`/
`transferência`/`cheque`/`vale`/`duplicata`/`pix`/`boleto`) ou `None`. `débito automático` (débito
direto em conta — "Tipo de pagamento: Débito Automático" das contas Sabesp; migration 071) vem
**ANTES** do `débito` genérico (cartão) na lista, para casar o valor específico. **Precedência
POR TEXTO** (chamado com
`(body_text, subject)` → o **corpo vence o assunto**: id 325 corpo "TED AGÊNCIA…" vs assunto
"PAGAMENTO PIX" → `ted`); dentro de um texto, a ordem da lista desempata (`crédito`/`débito`
antes de `cartão`, p/ "cartão de crédito" → `crédito`). Aplicado em `extract_from_email_body`
**só como preenchimento de lacuna**: roda quando `payment_method == 'outro'`, **abaixo** do
`has_pix` (PIX) e do override de boleto por código de barras — que têm precedência e não são
sobrescritos. Só no caminho do **corpo** (o do PDF usa o `payment_method` do extrator). Falso
positivo de `crédito`/`débito` em texto não-financeiro (ex.: "cadastros de crédito" de alerta de
protesto) é contido a montante pela regra `subject_is_ignorable_notification` (protesto/cartório
viram `ignorado`, nunca chegam a virar conta). Teste: `tests/test_body_payment_method.py`.

### Auto-resolução de fornecedor

**ASSUNTO como ÚLTIMO recurso para o nome do fornecedor (não regredir):** e-mail INTERNO de
pagamento ("PAGAMENTO BOLETO HYOSUNG 181063-3", "ENC: GUIA GNRE", "PAGAMENTO PIX FULANO")
encaminha um boleto/imagem cujo anexo **não traz nome/CNPJ/CPF**, e o remetente interno
(`@otimotex`/`@lebianco`) é **bloqueado** como fornecedor (migration 046) — a RPC então lança
"nenhum identificador válido" e a conta (com valor + código de barras) era **PERDIDA** como
`db_erro`. Correção: `_finalize_supplier`, quando não há nome/CNPJ/CPF extraído, deriva o nome
do favorecido do **assunto** via `_supplier_name_from_subject` (remove prefixos de
encaminhamento `ENC:/RES:/RE:/FWD:`, as palavras de ação `pagamento/boleto/pix/guia/…` e a
cauda de número de documento). Vale para TODOS os caminhos (PDF/imagem/corpo — todos passam
por `_finalize_supplier` com `payload['subject']` preenchido). Conservador: só roda como
último recurso e devolve `''` para assunto sem nome utilizável.
Testes: `tests/test_supplier_from_subject.py`. **Efeito colateral conhecido:** o assunto pode
criar um fornecedor com nome "curto" (ex.: `HYOSUNG`) divergente de um cadastro canônico
existente (`HYOSUNG SC`, CNPJ 11703922000181) — o operador funde os dois em `/fornecedores`
quando forem o mesmo (não há merge automático, pois o boleto não trouxe CNPJ para provar).

**SIGLA DE RAZÃO SOCIAL (LTDA) como âncora do nome no assunto (não regredir):** a razão social
quase sempre TERMINA numa sigla societária (`LTDA`/`EIRELI`/`EPP`/`MEI`/`S.A.`), então ela é a
âncora mais confiável para isolar o nome do fornecedor no assunto. `_supplier_name_by_legal_suffix`
(usado com **preferência** dentro de `_supplier_name_from_subject`) pega o SEGMENTO do assunto que
termina na sigla — descartando prefixos (`FATURAMENTO --`, `ENC:`, `PAGAMENTO`) e a cauda de
data/número após a sigla. Ex.: `"ENC: FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026"` →
`"MOVVI LOGISTICA LTDA"` (a heurística genérica devolvia `"FATURAMENTO -- MOVVI LOGISTICA LTDA"`,
que não casava o cadastro pelo `normalize_search`). Fica com a **última** sigla quando há mais de
uma (o pagador pode aparecer antes do fornecedor). Siglas `ME`/`SA` **isoladas** (sem separador)
ficam de fora — ruidosas demais. Caso de origem: conta id 401 (fatura MOVVI que caíra sob OTIMOTEX).

**O CNPJ DA PRÓPRIA EMPRESA PAGADORA (OTIMOTEX) NUNCA é o fornecedor (não regredir):** e-mails de
faturamento reencaminhados trazem o **bloco do destinatário** no corpo (ex.: `TÊXTIL E CONF.OTIMOTEX
/ CNPJ: 47273917/0001-23`), e a extração capturava esse CNPJ como se fosse do fornecedor — gravando
a conta sob a OTIMOTEX (sk=1) mesmo com o favorecido real nomeado no assunto. `_finalize_supplier`
descarta o `supplier_cnpj` extraído quando ele é igual ao CNPJ da empresa pagadora
(`ctrl.company_cnpj()`, sk_company=1) — assim a resolução segue pelo nome/assunto (âncora LTDA
acima). É a **guarda que habilita** a âncora de assunto nesse caso (sem ela, o CNPJ do pagador
venceria a resolução por CNPJ antes do fallback de assunto). **Não** afeta a regra de imposto nem o
fallback de pagador, que gravam OTIMOTEX explicitamente quando NÃO há favorecido. Best-effort (se o
ctrl não expõe `company_cnpj`, a guarda é pulada). Testes em `tests/test_supplier_from_subject.py`.

**Um TIPO DE DOCUMENTO ou TIPO DE PAGAMENTO NUNCA vira fornecedor (não regredir):** o assunto
"ENC: GUIA GNRE" reduzia a "GNRE" (um `document_type`) e virava fornecedor — errado.
`_is_non_supplier_term` (set `_NON_SUPPLIER_TERMS`, espelha `DOCUMENT_TYPES`/acrônimos de tributo
de `WORD_KEYWORDS` + `PAYMENT_METHODS` de `@sheild/shared`) rejeita o candidato quando ele É, no
todo, um tipo (`GNRE`, `BOLETO`, `PIX`, `DARF SP` — acrônimo isolado + UF/número). **Não** rejeita
nomes que apenas CONTÊM a palavra (`Porto Seguro`, `Vale Fertilizantes`). O filtro vale para o nome
**extraído** E o derivado do assunto.

**Fallback final — o PAGADOR (último recurso de todos):** quando esgotam CNPJ/CPF/nome/e-mail/
assunto e o pagador está claro, `_resolve_supplier_by_payer` usa `payer_cnpj` (14 dígitos, casa o
fornecedor por CNPJ) ou `payer_name` (ex.: `OTIMOTEX`) como fornecedor — garante que a conta a pagar
**nunca se perca** por falta de fornecedor identificável; o operador reclassifica em `/consulta`. É o
que as 5 guias GNRE internas usam (favorecido real = a SEFAZ da UF, que a extração não captura → caem
no pagador OTIMOTEX). A guarda `sem_fornecedor` (PDF) também aceita assunto/pagador como chave, para
não barrar a conta antes do fallback rodar. Ordem completa: **extraído → assunto → e-mail (RPC) →
PAGADOR**.

**GUIA DE IMPOSTO sem favorecido real → OTIMOTEX (sk=1) — precede o assunto (não regredir):** o
credor de uma guia de tributo é o **Fisco** (SEFAZ/RFB/prefeitura), que a extração não captura; o
"favorecido" derivado do assunto vira lixo (ex.: id 374 — `document_type='darf'`, assunto
"PAGAMENTO IMPOSTOS" → criava o fornecedor fictício **"IMPOSTOS"**; idem "GNRE -PAGAMENTO",
"DARE - REF"). Regra (`_finalize_supplier`): quando `document_type` é imposto
(`_is_tax_document` → `_TAX_DOCUMENT_TYPES` = `darf, das, gru, dae, dare, gnre, ipva, iptu, dam,
duam, iss, itbi, gare, tributo` — **`gps`/INSS e `multa` ficam de fora**, por decisão do usuário) **E**
não há favorecido REAL extraído (`supplier_name`/`supplier_cnpj`/`supplier_cpf` do documento), a conta
é lançada sob a **OTIMOTEX** (`OTIMOTEX_SK_SUPPLIER = 1`, a empresa pagadora — imposto próprio),
**curto-circuitando os fallbacks de assunto e pagador**. Favorecido real extraído (ex.: "PREFEITURA
DE SÃO PAULO", "CONTABIL ESQUEMA") **NÃO** dispara a regra e é preservado. A guarda `sem_fornecedor`
(PDF) também aceita `_is_tax_document` como chave, para uma guia de imposto sem nenhum outro
identificador não ser barrada antes da regra. Testes: `tests/test_supplier_imposto.py`. Backfill
único aplicado em 2026-07-03 (ids 331/333/334/373/374 → OTIMOTEX; fornecedores-lixo 1243/1247/1248
**hard-deletados** a pedido do usuário — eram fictícios, sem CNPJ/curadoria, e sem contas após o
remapeamento; exceção pontual à regra de soft delete de `supplier`).

O pipeline resolve o fornecedor **antes do INSERT** via RPC `resolve_supplier_for_account`
(`migration 040`; `_finalize_supplier` → `SupabaseControl.resolve_supplier`), que chama
`resolve_supplier_id(cnpj, cpf, name, email)` + `_add_supplier_email`. Ordem de busca
(**migration 054**): **CNPJ → CPF → nome normalizado → e-mail exato (não interno) → auto-insert**
em `supplier`. **O e-mail é um FALLBACK após o nome falhar** (não exige ausência de nome): se o nome
extraído não casa nenhum cadastro, a busca por `email`/`email2`/`email3`/`email4` ainda roda — o
nome mantém precedência (só quando ele falha o e-mail entra). Histórico: 027/028 punham o e-mail
ANTES do nome (colapsava fornecedores por remetente interno); a **046** corrigiu pondo o e-mail
depois, mas restringiu demais (**só "na ausência total de nome"**) — então, quando o corpo sem nome
confiável usava o próprio e-mail como "nome" (`v_has_name=true`), a busca por e-mail era PULADA e o
pipeline criava fornecedor DUPLICADO (ex.: `financeiro@smartwebservices.com.br`, já no email2 do
fornecedor 1213, virou um fornecedor novo). A **054** restaura a intenção documentada ("a RPC casa
por e-mail, passo email/2/3/4") sem reabrir o problema da 046, porque o **bloqueio de e-mail interno
é mantido** (`_is_internal_email`). **REGRA ROBUSTA do lado Python (não regredir):** em
`extract_from_email_body`, sem nome confiável (sinais/mapa por remetente falham) o nome fica **VAZIO**
— o e-mail NUNCA vira nome ANTES da busca; é passado à RPC como chave própria e **só vira nome no
auto-insert (último recurso) quando NÃO é encontrado** em nenhum fornecedor. Isso impede recriar o
"shadow supplier" nomeado pelo e-mail (que venceria o Passo 3). **Domínios internos não viram
fornecedor** (`migration 046`): `_is_internal_email` — **função SQL da RPC (migration 046),
NÃO uma função Python** — (`%@otimotex.com.br`/`%@lebianco.com.br`)
bloqueia esses e-mails tanto no `_add_supplier_email` quanto no Passo 4 e no auto-insert do
`resolve_supplier_id` (todos SQL). O lado Python não tem esse helper; o bloqueio de remetente
interno é imposto no banco pela RPC. A precedência **anexo → corpo**
do nome é garantida antes, no pipeline Python (o corpo só alimenta o resolver quando o anexo não
gera conta). Função `normalize_search()` é SECURITY DEFINER. `financial_account_control`
referencia o fornecedor **apenas pela FK `sk_supplier`** (surrogate key snowflake, NOT NULL —
`migration 042`): a RPC e as funções de resolução retornam/keyam `sk_supplier`; `supplier_id`
virou **chave de negócio** e ficou só na tabela `supplier` (NOT NULL UNIQUE, igualada ao `sk`
nos fornecedores criados pela extração via trigger de espelho, podendo divergir em cargas
externas). As antigas colunas denormalizadas `supplier_name`/`supplier_cnpj`/`supplier_cpf` e
o trigger `trg_fe_supplier_id` foram **removidos** (`migration 041`); nome/CNPJ vêm do JOIN com
`supplier`. A extração (`extract_pdf.py`/corpo) ainda **produz** nome/CNPJ — são a **entrada**
do resolver, descartados por `_finalize_supplier` depois de obter o `sk_supplier`.

- **Reconhecimento por e-mail** (`027`): na falta de CNPJ/CPF, o **remetente** (`sender_email`)
  é a chave — regra de negócio: o e-mail é estável por fornecedor e raramente um fornecedor
  tem o e-mail como `trade_name`/`legal_name`. Por isso, ao casar, um nome cadastrado em
  formato de e-mail é **promovido** ao nome real quando este chega (`_enrich_supplier_name`).
  Match por **e-mail exato** (case-insensitive) — seguro até em domínios públicos; match por
  **domínio** foi deliberadamente evitado (risco com `gmail.com`/`hotmail.com`).
- **Múltiplos e-mails** (`028`): `supplier` tem `email`, `email2`, `email3`, `email4` e o
  match considera os quatro. O trigger **acrescenta** o remetente no primeiro campo vazio
  (`_add_supplier_email`) em vez de sobrescrever `email` — sem duplicar (dedup case-insensitive);
  com os 4 cheios, o excedente é ignorado. A extração grava
  `financial_account_control.sender_email` (de `email_control.sender_email`) e o trigger o
  propaga ao resolver/criar o fornecedor.

### Empresa pagadora (`sk_company`) — regra LEBIANCO (não regredir)

Duas empresas pagam contas: **OTIMOTEX (`sk_company=1`, default)** e **LEBIANCO (`2`)**.
Regra (decisão do usuário, 2026-07-17): **e-mail que faz REFERÊNCIA a "lebianco" → conta da
LEBIANCO; SEM menção → SEMPRE OTIMOTEX.** Fontes varridas (sem acento, case-insensitive,
**substring** — "lebianco" é nome próprio distintivo, então **não** se usa `_has_word`/`\b`, que
existe para termos comuns como `das`/`iss`): **remetente/domínio** (`_is_lebianco_sender`,
reusado da classificação de ICMS-ST), **assunto**, **corpo**, **anexo** e `description`/
`source_file`/`payer_name`/`email_body_excerpt`.

- **A REFERÊNCIA VENCE O CNPJ** (o cerne): a conta pode ser da LEBIANCO com o **CNPJ da OTIMOTEX
  impresso no boleto**. Logo o CNPJ **não** participa da regra — sem menção é `1` **mesmo com
  `payer_cnpj` = CNPJ da LEBIANCO** (caso real: conta **267**, que permanece em `1`). Na prática
  o Python grava `sk_company` **sempre** (1 ou 2) e o resolvedor SQL `resolve_company_sk` deixa de
  influenciar o pipeline. **As DUAS origens informam a empresa explicitamente**: o pipeline pela
  regra LEBIANCO e o CRUD manual pelo **select do `ContaForm`** (default OTIMOTEX). O
  `resolve_company_sk` virou, na prática, **fallback residual** — só atuaria num INSERT que
  omitisse `sk_company` (nenhum caminho do app faz isso hoje).
- **`sk_company` (PAGADORA) é INDEPENDENTE de `sk_supplier` (FORNECEDOR)** — "pode acontecer de
  company ser lebianco, mas fornecedor ser otimotex". Por isso **`supplier_name`/`supplier_cnpj`
  ficam FORA da varredura**: se a LEBIANCO for o FORNECEDOR, quem paga é a OTIMOTEX (`1`), e
  varrer o nome do fornecedor inverteria a conta. Reforço: `_finalize_supplier` já remove essas
  chaves do payload, e a regra roda depois dele.
- **"LE BIANCO" (com ESPAÇO) vale SÓ NO ASSUNTO** (`_subject_has_lebianco`): no assunto é
  referência deliberada ("LE BIANCO - PAGAMENTO FORNECEDOR"); no **corpo** ela aparece na
  **assinatura do grupo** ("Departamento Financeiro | Otimotex / Le Bianco") e marcaria contas que
  são da OTIMOTEX — falso positivo **comprovado** na conta **167** (assunto "COBRANÇA OTIMOTEX
  TECIDO"), que corretamente permanece em `1`.
- **Anexo**: o texto CRU do PDF não chega ao payload (o CSV só traz `description`/`source_file`),
  então `_pdf_mentions_lebianco(pdf_path)` o lê no **passo 1** de `extract_and_store_accounts`
  (único ponto com o arquivo em disco), uma vez por e-mail, com curto-circuito. **Best-effort** —
  qualquer falha (PDF cifrado, imagem, pdfplumber) devolve `False` sem levantar; a regra nunca
  bloqueia a gravação da conta.
- **Onde é aplicada** (`apply_sk_company`, respeita valor já presente — idiom de `created_by`):
  (1) `extract_and_store_accounts` passo 2 (único ponto com `body_text` + flag do anexo em
  escopo); (2) `extract_from_email_body` no payload BASE, **antes** do bloco de parcelas (os
  clones herdam via `dict(payload)`); (3) **rede de segurança UNIVERSAL** no choke point
  `register_financial` (mesmo padrão de `_apply_barcode_due_date`), cobrindo os 3 scripts de
  reprocessamento.
- **Trigger (migration 084) — não regredir:** `trg_fe_resolve_company()` só resolve
  `IF NEW.sk_company IS NULL`. Antes a atribuição era **incondicional** e tinha dois defeitos
  provados: descartava o valor do Python **e qualquer UPDATE re-resolvia a empresa** (um
  `UPDATE ... SET has_invoice = has_invoice` na conta 267 mudava `sk_company` de 1→2 — a curadoria
  de NF/BOL revertia a empresa e o backfill não grudaria). Mantém `SECURITY DEFINER` +
  `search_path` + chamada qualificada (lição da **074**).
- **Estado após o backfill (2026-07-17):** **55** contas em `sk_company=2` (19 por menção no
  texto, 46 pelo remetente `@lebianco.com.br` — 36 delas *só* pelo remetente) e **381** em `1`.
  Trade-off aceito: se alguém da Lebianco encaminhar um boleto da OTIMOTEX, a conta fica como
  Lebianco. Testes: `tests/test_sk_company_lebianco.py`.

### `extraction_source` — origem dos dados

| Valor (banco) | Origem | Rótulo exibido (badge/UI) |
|---|---|---|
| `pdf_text` | PDF digital (pdfplumber) | `pdf anexado` |
| `pdf_vision` | PDF escaneado (Claude Vision via base64 — não exige poppler) | `pdf anexado` |
| `image_vision` | Anexo de IMAGEM (jpg/png/gif/webp) lido via Claude Vision — recibo/comprovante/foto (ex.: "Valor do porte" dos Correios). Migration 061 no CHECK | `imagem anexada` |
| `email_body` | Corpo do e-mail (sem PDF válido) | `corpo email` |
| `falha` | Falha na extração | `falha` |

> O rótulo amigável em pt-BR é resolvido por `badgeLabel()` (`statusBadge.variants.ts`),
> usado pelo `StatusBadge` e pelo painel de detalhe de `/consulta` — `pdf_text` e `pdf_vision`
> compartilham "pdf anexado" (para o usuário ambos são um PDF anexado; a distinção é interna).
> Valores não mapeados caem no próprio texto.

**Anexos de IMAGEM (jpg/png/gif/webp) — lidos via Claude Vision (`image_vision`):** o
pipeline trata imagem (recibo/comprovante/foto, ex.: "Valor do porte" dos Correios) como
documento. Prioridade: **anexo PDF → anexo imagem → PDF por link → IMAGEM INLINE → corpo**.
`save_attachments` (`read_emails.py`) salva imagens **anexo explícito** (`Content-Disposition:
attachment`). Imagem **inline** (`Content-ID`, sem `attachment` — recibo colado no corpo pelo
Outlook) é tratada por `save_inline_images` como **fallback SÓ quando não houve anexo nem PDF
por link**: salva a **MAIOR** imagem inline `>= _IMAGE_INLINE_MIN_BYTES` (50 KB) — o documento é a
imagem mais proeminente; logos/assinaturas/ícones e a 2ª imagem ficam de fora, evitando chamadas
Vision desnecessárias (fora desse fallback, imagem inline nunca é processada). O caso real que
motivou: reembolso de postagem dos Correios com o recibo colado inline (`process_message` →
`save_inline_images` → Vision → conta `recibo` R$ 172,39, fornecedor ECT/Correios). No `extract_pdf.py`, `process_pdf` desvia imagens **antes** de pdfplumber/
descriptografia/carnê (que abririam o arquivo como PDF) para `_extract_image` → `extract_with_vision`,
que monta o bloco Vision conforme o tipo (`_vision_source_block`: `type:image`+media_type para
imagem → `image_vision`; `type:document`+`application/pdf` para PDF → `pdf_vision`). `build_record`
trata `image_vision` pelo mesmo caminho JSON do `pdf_vision`. O prompt de `amount` inclui o rótulo
"Valor do porte"/"Valor total" de recibo de postagem. `upload_attachment` grava o Storage com o
`Content-Type` por extensão (`_UPLOAD_CONTENT_TYPES`), não mais fixo em `application/pdf`. CHECK do
banco: migration **061** (domínio `email_body`/`pdf_text`/`pdf_vision`/`image_vision`/`falha`); enum
Zod `EXTRACTION_SOURCES` e o badge (`image_vision`→"imagem anexada") alinhados. Testes:
`tests/test_extract_pdf.py` (roteamento de imagem), `tests/test_save_attachments.py` (salva PDF+imagem,
ignora inline) e `StatusBadge.test.tsx`.

### Boleto por link (sem anexo) — prioridade anexo → link → corpo

A prioridade de extração vale também para **links**: e-mail **sem anexo PDF mas com link**
deve usar o link para encontrar o boleto, antes de cair no corpo. Em `process_message`,
quando `save_attachments` não traz nada, o fluxo chama `extract_pdf_links(body_text,
body_html)` e tenta `download_pdf_from_url` em cada candidato; os PDFs obtidos entram em
`saved_pdfs` e seguem o caminho normal — inclusive **upload no Storage** (todo PDF salvo
passa por `upload_attachment` dentro de `extract_and_store_accounts`, anexo ou link).

- **Reconhecimento do link** (`extract_pdf_links`): âncora/URL com termos de cobrança
  (`_LINK_TEXT_RE`/`_LINK_URL_RE`, que inclui `protocolo`) ou caminho `.pdf`.
- **Página HTML intermediária** (`download_pdf_from_url`): se o link abre uma landing/portal
  HTML, varre os `<a>` (1 nível) atrás de um link de boleto (âncora/URL de cobrança ou
  `.pdf`) e baixa o PDF. Hrefs são **desescapados** (`html.unescape`, `&amp;`→`&`) para os
  parâmetros não quebrarem.
- **SIEG — QUEBROU em 2026-06-16 (handler deferido — decisão A1):** a SIEG migrou
  `app.sieg.com/faturas` para **ASP.NET WebForms com boleto gerado por JS/ajax**
  (`financeiro.min.js`). O scan genérico (sem JS) não acha mais o PDF → loop em HTML +
  `TimeoutError` → cai no corpo (NFE) → `falha`. **Não foi regressão nossa** (caminho de link
  intocado). Mecanismo mapeado p/ o futuro handler: `POST /ajax/BillsDetails.aspx/GetDetailsBills`
  body `{bill:'<bill>',companyid:''}` → `d.Charges[0].PrintUrl` quando `PaymentMethod.Code`
  contém `bank_slip` (`bill`/`branchid` vêm da query da URL). Reprodução server-side dá HTTP 500
  (exige sessão/JS do navegador). **Adiado até entrar uma fatura SIEG em aberto** para validar o
  download de verdade (as atuais estão "Pago"). Detalhes na memória `link-boleto-pipeline`.
- **SSW (transportadoras — `sswsistemas.com.br`) → preferir o link de FATURA, descartar o DACTE
  (`_ssw_doc_kind`/`_SSW_LINK_RE` em `extract_pdf_links` — não regredir):** o e-mail "Sua fatura
  Nº… está disponível" traz VÁRIOS links `ssw.inf.br/cgi-local/ssw1188?id=<hex>`, e o **1º byte do
  `id` (hex→ASCII)** indica o tipo: **`F` = Fatura** (traz o **boleto** no rodapé — âncora "AQUI"/
  número da fatura) · **`D`/`E`/`X` = DACTE/CT-e** (documento **fiscal**, sem boleto — âncora
  "Download do arquivo"). Sem tratamento, o `extract_pdf_links` casava o DACTE (a âncora "Download"
  bate a heurística `download`) e **ignorava a fatura** (âncora "AQUI"/número não casa
  boleto/fatura/.pdf) → baixava o DACTE (sem linha digitável) e, sendo transportadora, a conta caía
  em **`ignorado`** (regra CT-e/transporte sem boleto). Correção: `_ssw_doc_kind` classifica o link
  pelo id; `extract_pdf_links` **prioriza a fatura (`F`)** (posição 0) e **descarta os DACTE
  (`D`/`E`/`X`)** — no HTML e no texto puro. Caso de origem: conta da fatura 596597 (Arlete
  Transportes, R$ 1.505,37) que virou `ignorado`; reprocessada (`reprocess_message.py`) → boleto
  extraído (cc 4 / plano 339, transporte). Testes: `tests/test_link_extraction.py`
  (`SswLinkSelectionTest`).
- **Portal BRASPRESS** (`download_pdf_from_url` + `_braspress_download_url`): caso que o scan
  genérico não cobre, pois o link do PDF é montado por JS. O link do e-mail
  (`/protocoloweb?protocolo=CHAVE`) abre uma página cujo botão chama `faturaPDF(chave)`, que
  baixa de `/fatura/download?protocolo=CHAVE&protocoloWeb=true`. Exige **cookie de sessão**
  (`JSESSIONID`) — por isso `download_pdf_from_url` usa um `http.cookiejar`/opener
  compartilhado entre a página e o download (`_fetch_url` aceita `opener`). Outros portais
  com link de PDF montado por JS seguem esse padrão (handler dedicado).
- **Lmed/mdnet (portal ScriptCase) — adiado por CAPTCHA (decisão do usuário, 2026-06-17):**
  `srv2.mdnet.com.br/lmedseg/vExternoFatura` pede os "primeiros 3 dígitos do CPF/CNPJ"
  (campo `m_veri`) **e um CAPTCHA com imagem**. O prefixo do CNPJ viria de `company.cnpj`
  (`sk_company=1`, tentar 5 e depois 3 primeiros dígitos), mas o captcha bloqueia o download
  automático → fatura fica em `falha` p/ download manual. **Regra de prefixo de CNPJ ainda
  não implementada** — fazer quando houver um portal que peça só o prefixo (sem captcha).
  Detalhes na memória `link-boleto-pipeline`.
- **Links suspeitos são ignorados** (`_is_suspicious_link`, regra Locaweb): redirecionadores/
  rastreadores ofuscados — `bing.com/ck/a?…&u=a1<base64>`, Microsoft SafeLinks, Proofpoint
  URL Defense — **nunca** viram candidatos a download (evita baixar malware de phishing).
  Esta é a **defesa primária**: detecta no corpo o próprio link que faz a Locaweb exibir o
  aviso "Tem certeza que deseja acessar este link?" (modal de webmail mostrado **após** o
  clique, logo ausente do corpo bruto). Como rede secundária, `_body_has_suspicious_warning`
  descarta todos os links se esse texto de aviso aparecer citado no corpo.
- **Guarda anti-SSRF do download (segurança §4 C-1/C-2 — não regredir):** todo `GET` de
  link passa por `_is_safe_download_url` (`_fetch_url`) — bloqueia scheme ≠ http(s), porta
  fora de `{80,443}` e host que resolve para IP **interno** (privado/loopback/link-local/
  reservado/multicast — cobre metadata cloud `169.254.169.254`, `localhost`, LAN). O
  `_SafeRedirectHandler` **revalida cada redirect** (impede bypass via 302 para alvo interno);
  os PDFs salvos são contidos em `PDF_INBOX` (`_is_within_inbox`). Conteúdo de remetente
  desconhecido controla a URL — **nunca** remover essas guardas. Os caminhos legítimos
  (BRASPRESS, página HTML intermediária) batem em hosts públicos e passam. O cookiejar do
  `http.cookiejar` só envia cookie a domínio correspondente (sem vazamento cross-domain).
- **`_PinnedHTTPSHandler` compatível com Python 3.12+/3.14 (não regredir):** o handler que
  fixa o IP validado (anti-DNS-rebinding, S4-1) NÃO pode referenciar `self._check_hostname` —
  atributo **removido do `HTTPSHandler` no Python 3.12+** (a verificação de hostname passou a
  ser carregada pelo `context`). Sob **Python 3.14** (a produção roda 3.14.5) o acesso direto
  lançava `AttributeError('_check_hostname')` e quebrava **TODO** download de link HTTPS
  (BRASPRESS, SIEG, qualquer portal) — o e-mail caía em `falha`. `https_open` passa só
  `context` (preserva a verificação de certificado/cadeia via `_context.wrap_socket` com o
  `server_hostname` original) e inclui `check_hostname` **apenas se o atributo existir**
  (Python < 3.12). A guarda anti-SSRF continua intacta. Regressão travada em
  `tests/test_ssrf_guard.py` (`PinnedHttpsHandlerPy312PlusTest`).
- **Erro de código NÃO se disfarça de "link inacessível" (robustez — lição do bug 3.14):**
  `_fetch_url` separa **falha de REDE esperada** (`urllib.error.URLError`/`OSError`/
  `http.client.HTTPException` — host/timeout/TLS/conexão → `log.info` silencioso, retorna
  `None`) de **erro INESPERADO** (bug de código, ex.: incompatibilidade de versão do Python →
  `log.exception` com **traceback**, visível, e segue sem derrubar o run). Antes, um
  `except Exception` genérico logava só "falha ao acessar link", escondendo o `AttributeError`
  do handler por dias em produção. **Não** voltar ao `except Exception` mudo.

Testes: `tests/test_link_extraction.py` (reconhecimento, unescape, filtro de suspeito, URL
BRASPRESS) e `tests/test_ssrf_guard.py` (bloqueio de IP interno/scheme/porta + redirect +
contenção em PDF_INBOX + compat Python 3.12+ do handler HTTPS).

**Reprocessar histórico**: `scripts/reprocess_link_emails.py` (com `--dry-run`) varre os
e-mails `status='falha'`, rebusca o corpo no IMAP, baixa o boleto pelo link e grava em
`financial_account_control` + atualiza `email_control` (`falha`→`extraído`); duplicatas
(original + encaminhado) deduplicam para uma conta e ambos os e-mails viram `extraído`.

### Caminho `email_body`

Acionado em `process_message()` **só quando o anexo NÃO respondeu por nenhum pagável**
— assim o corpo nunca conflita com um arquivo anexado válido ("o boleto sempre vence o
corpo"). O gate usa a flag **`attachment_account`** (4º retorno de
`extract_and_store_accounts`), que é True quando um PDF anexado gerou uma conta pagável
**criada como nova OU casada/atualizada por DEDUP** contra uma conta já existente (mesmo
documento chegado por outro e-mail). **Não regredir para `accounts_saved == 0`** (só
contas NOVAS): um boleto **deduplicado** tem `accounts_saved==0` e, com o gate antigo, o
corpo criava uma conta ESPÚRIA com dados divergentes — falha real id 510 (OBER,
R$ 5.576,66): o boleto anexado deduplicou contra o id 159 (venc. 18/07 pelo fator do
código de barras), mas o corpo gravou uma 2ª conta com venc. 11/07 (lido do texto, sem
barcode), que ainda foi auto-baixada para `pago` por causa da data errada. Cobertura:
`tests/test_boleto_dedup_suppresses_body.py`. **Limpeza retroativa** (2026-07-13): hard
delete do id 510 (id 159 preservado). Caso ainda ABERTO após o fix: id 7 (corpo, ESPRO
R$ 304) duplica o id 176 (boleto) — mesma dívida em **e-mails separados**, não deduplicada
por o tipo divergir (`outro`×`boleto`); causa distinta (gap de dedup cross-e-mail), não
coberta por este fix.

**MÚLTIPLAS PARCELAS no corpo → UMA conta por boleto (NUNCA somar — não regredir):**
quando o corpo lista uma TABELA de boletos (documento, parcela, emissão, vencimento,
valor, dias — caso OBER, em que o webmail quebra cada campo em uma linha `\r`),
`_extract_body_installments()` (regex `_BODY_INSTALLMENTS_RE`) detecta as linhas e o
`try_extract_from_body` cria **uma conta por boleto** (clona o payload com o fornecedor já
resolvido e sobrescreve nº=`{doc}/{parcela}`, valor, vencimento e emissão por linha; dedup
por linha). A linha **"Total"** nunca vira conta (não casa o padrão doc+parcela+2datas+valor).
Dispara só com **≥2 linhas** e vencimentos OU (doc,parcela) distintos; caso contrário cai no
caminho de conta única, em que `_extract_body_amount` mantém a soma para pagamento único com
componentes (ex.: "Valor R$ 297,08 + R$ 6,96 / Total R$ 304,04"). Contas do corpo **não têm
código de barras** (a linha digitável só existe no PDF) — por isso o caminho de PDF (quando
legível) é preferível. Teste: `tests/test_body_installments.py`.

> **Boletos protegidos por senha + carnê (OBER `info.ober.com.br`) — RESOLVIDO no PDF:** o boleto
> é um PDF **criptografado** (senha = N primeiros dígitos do CNPJ do pagador) e um **carnê de N
> boletos** (N páginas). `extract_pdf.process_pdf` (orquestrador) trata os dois: (1) PDF cifrado
> (`_pdf_is_encrypted`) → tenta senhas `company.cnpj[:4]→[:5]→[:6]` (`_decrypt_pdf`; candidatos
> gerados por `read_emails.pdf_password_candidates(ctrl.company_cnpj())` e threaded por
> `run_extraction`→`extract_to_csv(pdf_passwords=...)`), gravando uma cópia descriptografada
> temporária; (2) **carnê** (`_boleto_pages` acha ≥2 páginas com linha digitável) → divide em
> 1 PDF por página (`_write_single_page`) e roda `_extract_single` em cada um → **1 registro por
> boleto** (com a linha digitável de cada). `process_pdf` agora devolve **lista** de registros;
> `extract_to_csv` itera, e o loop de `extract_and_store_accounts` (que já cria 1 conta por linha
> do CSV) gera as contas individuais com código de barras. **Esgotadas as senhas** → registro de
> falha → fallback do corpo (que também cria parcelas individuais, porém sem barcode). **Por que
> bundled:** decrypt SEM a emissão por boleto regrediria (o carnê viraria 1 conta somada e o corpo
> não rodaria). Requer `pypdf` (em `server/requirements.txt`). Testes:
> `tests/test_pdf_decrypt.py` (decrypt + candidatos) e a validação dos helpers contra o PDF real
> (`_boleto_pages`/`_write_single_page`). **Importante (produção):** copiar `extract_pdf.py` **e**
> `read_emails.py` juntos e instalar `pypdf` na máquina do scheduler — ver "Deploy manual".

> **Boleto cifrado só com senha de DONO (usuário vazia) — RESOLVIDO via pdfplumber (não regredir):**
> caso distinto do OBER (SB Crédito / HYOSUNG via "SB CREDITO SECURITIZADORA"): o PDF é cifrado
> **só com senha de DONO** (senha de USUÁRIO vazia + flags de restrição). O `pypdf` marca
> `is_encrypted=True` e `reader.decrypt('')` devolve `0` (**não** decifra), mas o **pdfplumber/
> pdfminer lê o arquivo transparentemente**. Antes, o gate de decrypt descartava esses boletos
> legíveis como "protegido por senha" → `extracao_falhou` em massa (14 boletos SB Crédito presos).
> Correção em `process_pdf`: quando `_pdf_is_encrypted` E `_decrypt_pdf` retorna `None` **MAS**
> `_pdf_text_readable(pdf_path)` (o pdfplumber lê texto) → segue com o PDF **ORIGINAL**
> (`work = pdf_path`) em vez de emitir `_failure_record`. Só quando o pdfplumber TAMBÉM não lê
> (senha real desconhecida — ex.: boleto dos **Correios** "Sua Fatura Correios Empresas") é que
> vira falha/manual. Testes: `tests/test_pdf_decrypt.py` (`TestEncryptedOwnerOnlyFallback`).
> **Deploy:** só `extract_pdf.py` (sem dependência nova).
`extract_from_email_body()` faz parsing por regex. **Fornecedor** (`_BODY_NAME_RE`): rótulo no
início da linha — `fornecedor`/`responsável`/`prestador`/`nome` (+ `favorecido`/`beneficiário`/
`cedente`/`razão social`/`empresa`). O **separador `:`/`-` é OPCIONAL** (aceita só espaço,
ex.: "Nome MATEUS JAE WON AHN"); para não capturar continuação de frase ("Responsável **pela**
compra"), o valor **deve começar por maiúscula/dígito** (char class `[A-ZÀ-Þ0-9]` case-sensitive;
só o rótulo é case-insensitive via `(?i:...)`), e `\b` evita casar prefixo ("Nomeação"). **Cuidado
CRLF:** o fim da linha é `[ \t\r]*$` — o `\r` do `\r\n` bloqueia o `$` se esquecido (bug já
corrigido; teste usa `\r\n`). **Sem rótulo nem documento**, tenta sinais (`_supplier_from_signals`):
assinatura titulada (`Prof./Dr. <Nome>`) e destinatário do pagamento (`pix/pagar p/|para <Nome>`,
com stopwords cortando a captura). Depois o **mapa por remetente** (`_supplier_from_sender`/
`_SENDER_SUPPLIER_MAP`: `correios.com.br` → `Correios`) e só então cai para `sender_email`.
**Valor** (`_extract_body_amount`): (1) "Total"/"Valor Total" com `R$` tem precedência; (2) valores
`R$` somados; (3) **fallback sem `R$`** (`_BODY_LABELED_AMT_RE`) — número rotulado por `Valor`/`Total`
no formato BR com **2 a 3 casas** (`Valor 50,00`, `Total 1.250,00`), usado só quando não há
nenhum `R$` (exige rótulo + centavos p/ não pegar número solto/`NF 1087`; "Total" tem precedência
sobre "Valor"). **3ª casa decimal (não regredir):** aceita `,\d{2,3}` — o 3º dígito é digitação com
zero a mais (ex.: `VALOR: 1.799,960` → R$ 1.799,96, id 186, nota interna NIKE); `_brl_to_decimal`
trata vírgula como decimal BR com `,\d{1,3}$` e `round(…,2)` normaliza (sem o fix, caía no ramo de
milhar e virava R$ 1,80). O fallback tolera **um conectivo curto colado ao número** (`de`/`da`/`do`)
entre o rótulo e o valor — `o valor de 172,39` casa; um substantivo no meio (`Total da nota 1.250,00`,
sem `R$`) **não** casa (conservador, evita falso positivo; o caminho com `R$` cobre o caso comum).
`payment_method='pix'` se o termo aparecer (ou sempre, p/ honorários). **Vencimento** (`_BODY_DUE_RE`
= "vencimento"): fallback **`_BODY_PAYDATE_RE`** reconhece `DATA (PARA/DE) PAGAMENTO: DD/MM/AA` (rótulo
das notas internas, id 186) antes de cair na data de emissão/extração. **Valida
fornecedor+valor**: sem valor → não grava conta (vira `falha`). `email_body_excerpt` (migration 016)
guarda o corpo completo. Testes: `tests/test_body_amount.py`. O **barcode do corpo**
é normalizado por `_normalize_body_barcode`, que reusa `extract_pdf.normalize_barcode` (import
lazy) — mesma regra canônica do caminho de PDF (44/48 dígitos mantidos, 47 → 44, outros →
None), em vez de um `re.sub` solto que aceitava qualquer sequência de 44-48 (F2).

**Corpo SÓ-HTML** (ex.: Correios — `noreply_componentes@correios.com.br`, assunto "Pagamento
Boleto Fatura"): quando o anexo não vem e o link é portal HTML sem PDF, `get_body_text()`
volta vazio. `process_message` então usa `_html_to_text(get_body_html(msg))` (remove tags,
desescapa, colapsa espaços) para alimentar a extração — recupera "Fatura nº: 3918439"
(→ `invoice_number`), "Valor da fatura R$ 1.530,47" (→ `amount`) e classifica
`document_type='fatura'` (keyword `fatura` em `_BODY_DOC_KEYWORDS`, fallback antes de
`outro`). Prioridade segue **anexo → link → corpo**. O status da conta do corpo é **sempre
`pendente`** — a baixa/atualização é feita pelo usuário, mesmo quando o corpo diz "pagamento
realizado com sucesso". Dedup do corpo (`find_financial_duplicate`) evita duplicar conta já
registrada. Testes: `tests/test_body_html_extraction.py`.

**Fallbacks de campo (corpo E PDF — `build_financial_payload`):** `issue_date` vazio →
data do e-mail (`received_at`); `due_date` vazio → `issue_date` → hoje; `invoice_number`
vazio → `"{document_type}_{ddmmyy(vencimento|emissão)}"`. Um **identificador de fornecedor**
extraído (nome **ou** CNPJ **ou** CPF) e `amount` são obrigatórios para gerar conta — o nome/CNPJ
extraído alimenta a resolução do `sk_supplier` (`_finalize_supplier`) e depois é descartado;
não vira coluna em `financial_account_control`.

### Registrar TODOS os e-mails + filtro de assunto (`KEYWORDS_DEFAULT`)

`run_reader()` registra **todos** os e-mails da caixa em `email_control` — `/emails`
espelha o webmail inteiro (o app substitui abrir a caixa). O filtro de keyword decide
**o que extrair**, não o que registrar:

- **Dedup primeiro** (`message_id` em `known_ids`) → pula.
- **Sem keyword** no assunto → `ctrl.register({... status:'ignorado'})` sem baixar/
  extrair (`has_attachment` fica NULL). Respeita `--dry-run` (não grava).
- **Com keyword** → `process_message` (baixa + extrai) define o status via `status_for_result`,
  por **prioridade**: conta do PDF (`accounts_saved>0`) → `extraído` · **NF-e pura sem conta**
  (`subject_is_pure_nfe`) → `ignorado` · CSV do PDF → `extraído` · conta do corpo → `recebido`
  (**vale mesmo com anexo** cujo PDF não gerou CSV — antes virava um falso `pendente`) ·
  **duplicidade** (pagável do corpo duplica conta já registrada) → `duplicidade` · anexo
  salvo sem conta → `pendente` · **notificação sem anexo/conta** (`subject_is_ignorable_notification`)
  → `ignorado` · nada → `falha`. Ver migrations 022/031 e `tests/test_status_for_result.py`.
- **Regra de DUPLICIDADE** (`try_extract_from_body` → `BODY_CREATED`/`BODY_DUPLICATE`/`BODY_NONE`):
  quando o pagável extraído do corpo casa uma conta já existente (`find_financial_duplicate`),
  a conta **não** é recriada e o e-mail vira `duplicidade` (status próprio, migration 031) — não
  `falha`. Cobre a thread original + seu `RES:`/encaminhamento. `email_rec['duplicate_of']` guarda
  o id da conta; `notes` registra "Duplicata — conta já registrada (id N)". Vale no pipeline e no
  `scripts/reprocess_body_emails.py`. Testes: `tests/test_body_duplicate.py`.
- **Corpo é fallback só quando o anexo NÃO respondeu por nenhum pagável**
  (`attachment_account==False` — conta nova **ou** boleto deduplicado; ver "Caminho
  `email_body`") — havendo conta de arquivo anexado válido (mesmo deduplicada), o corpo é
  ignorado (sem conflito).

**Matching de keyword (`match_keyword`, `tests/test_match_keyword.py`)** — comparação
**sem acento** (NFD + lowercase). Dois modos:
- **Acrônimos de tributo/câmbio** (`WORD_KEYWORDS`: `darf, das, dae, dare, dam, duam, gps,
  gru, gnre, gare, ipva, iptu, iss, itbi, cambio`) casam por **palavra inteira** (`\b…\b`) —
  evita falso positivo de substring (`das` em "ca**das**tro"/"executa**das**", `iss` em
  "em**iss**ão", `gru` em "**gru**po", `cambio` em "inter**câmbio**").
- **Demais termos** (frases e siglas distintivas: `boleto, nota fiscal, nf-e, conhecimento
  de transporte, dacte`…) seguem **substring**.
- **Câmbio**: lê `cambio` **ou** `câmbio` (sem acento), mas a keyword gravada/retornada é
  sempre `câmbio` (forma gramatical correta na lista).

**Remetente de SISTEMA → `ignorado`** (`is_ignored_sender`, `IGNORED_SENDER_LOCALPARTS`,
`tests/test_match_keyword.py`): e-mails cujo **local-part** do remetente está na lista
(hoje `postmaster`) — NDR/bounce/aviso de servidor (ex.: "Undeliverable: …") — viram
`ignorado` **sem baixar nem extrair**, e o filtro roda **antes** do match de keyword (no loop
de `run_reader`), então vale **mesmo que o assunto case uma palavra-chave**. Motivo: um aviso
de não-entrega frequentemente cita o corpo da cobrança original (com valor), e sem esse filtro
o pipeline criava uma conta a pagar **falsa** a partir do bounce. Match por local-part
(case-insensitive, qualquer domínio); a lista é um `set` extensível. O registro `ignorado` é
compartilhado com o filtro de assunto via `_register_ignored`.

**Confirmação de pagamento → `ignorado` (não é conta a pagar — não regredir):** e-mail cujo
ASSUNTO indica que o **pagamento JÁ foi realizado** (`subject_is_payment_confirmation`,
`_PAYMENT_CONFIRMATION_RE`) vira `ignorado` **sem baixar nem extrair**, e o filtro roda **antes**
do match de keyword no loop de `run_reader` (logo após `is_ignored_sender`), então vale **mesmo
que o assunto case uma palavra-chave** (ex.: "Pagamento confirmado - boleto 123"). Motivo: uma
confirmação/comprovante de pagamento é um **recibo**, não uma cobrança — antes o pipeline criava
uma conta a pagar **falsa** (ex.: "Confirmação de Pagamento da fatura 18292"). O regex (assunto
sem acento) casa `confirmação de/do pagamento`, `comprovante de pagamento/pix/transferência/
depósito`, `confirmado (o) pagamento` e `pagamento (foi/já) confirmado/processado/efetuado/
realizado/aprovado/recebido` — o **particípio no passado** evita casar "REALIZAR pagamento" /
"pagamento A realizar" (que SÃO conta a pagar). Distinto de `NOTIFICATION_PHRASE_TERMS` (que só
vira `ignorado` na ausência de anexo/conta): aqui o e-mail é ignorado **antes** de processar,
sempre. Teste: `tests/test_match_keyword.py` (`PaymentConfirmationTest`). Limpeza retroativa
(2026-07-06): **hard delete de 10 contas** de confirmação de pagamento em `financial_account_control`
(8 "Confirmação de Pagamento da fatura" + 2 "pagamento foi aprovado") + os `email_control`
correspondentes → `ignorado`.

**Assunto com "lembrete" → `ignorado` (não é conta a pagar — não regredir):** e-mail cujo ASSUNTO
contém a palavra **`lembrete`** (substring, sem acento — `subject_is_reminder`) vira `ignorado`
**sem baixar nem extrair**, no mesmo ponto do loop de `run_reader` (logo após
`subject_is_payment_confirmation`), então vale **mesmo com keyword/anexo** (ex.: "Lembrete de
Pagamento: vencimento 10/06/2026", de `boleto@smartwebservices.com.br`). Decisão do usuário: **o foco
é a palavra `lembrete`** — um lembrete/aviso não é a cobrança em si; `vencimento` sozinho **NÃO**
basta (pode ser um boleto real, ex.: "Boleto vencimento 10/07"). Distinto de
`NOTIFICATION_PHRASE_TERMS` (nível FRACO — só `ignorado` sem anexo/conta) e de
`subject_is_payment_confirmation` (pagamento JÁ feito). Substring pega o plural `lembretes`. Teste:
`tests/test_match_keyword.py` (`ReminderSubjectTest`). Limpeza retroativa (2026-07-07): **hard
delete de 5 contas** com "lembrete" no assunto (4 "Lembrete de Pagamento: vencimento" de
`boleto@smartwebservices` + 1 "ENC: Lembrete Sua Fatura") + os `email_control` correspondentes → `ignorado`.

Lista padrão em `KEYWORDS_DEFAULT`, **sobrescrita por `EMAIL_KEYWORDS` no `.env`** (fonte de
verdade usada hoje). **NF-e "pura"** (`subject_is_pure_nfe`): assunto com `nota fiscal/nfe/
nf-e/nfse/nfs-e` **por palavra inteira** (não casa "co**nfe**cções") e **sem** indício de
pagável (`boleto/fatura/vencimento/`acrônimos…) que **não** gera conta a pagar vira
`ignorado` em vez de `falha` — notificação fiscal não é conta a pagar.

**Notificações → `ignorado`** (`subject_is_ignorable_notification`, `tests/test_match_keyword.py`):
e-mails de aviso/confirmação **sem anexo e sem conta no corpo** (gatilho no lugar do antigo
`falha`) viram `ignorado`. Termos: palavra inteira `nfe, nf-e, informe, sieg, cte, ct-e, dacte`;
frases `informativo, confirmado (o) pagamento, confirmação de/do pagamento, pagamento confirmado,
pagamento processado, aviso de vencimento, título a vencer, lembrete de vencimento, títulos
próximos do vencimento, comprovante de pix, protesto, protestado, cartório, comunicado,
fatura a vencer, aviso de fatura, conhecimento de transporte`.
**CT-e/transporte (não regredir):** os termos `cte`/`ct-e`/`dacte`/`conhecimento de transporte`
fecham a lacuna da notificação de CT-e **sem anexo/link** (ex.: SSW "Arquivos de Conhecimento de
Transporte Eletronico", "OCORRENCIA CTE …") — a regra CT-e-sem-boleto de `extract_and_store` só
atua quando há PDF extraído; aqui não há anexo, então cai neste nível. Como `notification` é o
**último** critério de `status_for_result`, um boleto de transporte real gera conta ANTES e não é
escondido. **`fatura a vencer`/`aviso de fatura`** cobrem o aviso da transitobrasil ("Aviso de
fatura a vencer"). Testes: `tests/test_nonpayable_rules.py` + `tests/test_match_keyword.py`.
**Nota:** qualquer assunto com a palavra `lembrete` já é ignorado **antes** deste ponto, no
nível FORTE (`subject_is_reminder`, sem baixar/extrair — ver "Assunto com 'lembrete'"), então o
termo `lembrete de vencimento` aqui é redundante; os demais termos de vencimento (`aviso de
vencimento`/`título a vencer`/`títulos próximos do vencimento`, sem "lembrete") seguem valendo só
neste nível FRACO (só `ignorado` na ausência de anexo/conta).
Avisos sem termo generalizável (oferta de frete, "nova área do cliente", "taxa de
agendamento") são marcados por **Message-ID** em `EXPLICIT_IGNORE_IDS`
(`scripts/reprocess_ignored_emails.py`). **Não** há exclusão por boleto/fatura aqui — o
gatilho já exige ausência de anexo/conta (sem anexo nem dado no corpo ⇒ é só um aviso); com
anexo, o PDF vira `pendente` (revisão), nunca `ignorado`. Reprocesso histórico (e Message-IDs
avulsos marcados à mão, ex.: alerta de protesto SPC/Serasa) via
`scripts/reprocess_ignored_emails.py`. **SIEG** (atualizado 2026-06-17): avisos/confirmações
da SIEG **sem pagável** (ex.: "identificamos o pagamento", NF-e) seguem `ignorado`; já as
**faturas SIEG** (mensalidade R$ 426,80, link JS quebrado — ver A1) **geram conta `recebido`
pelo corpo** (fornecedor SIEG, valor, vencimento). O `bill=NNN` do link SIEG
(`_BODY_SIEG_BILL_RE`) vira `invoice_number` (`sieg_<bill>`), fazendo os dois lembretes
("Vencimento Próximo" + "Hoje") da mesma fatura **deduplicarem** (antes geravam 2 contas/mês
porque o nº saía de data relativa e divergia). Isso **revoga** a regra anterior de manter
faturas SIEG em `ignorado`; o handler A1 (baixar o boleto real) segue como melhoria futura.

### Frontend — rotas e serviços

| Rota | Componente | Tabela |
|---|---|---|
| `/emails` | `Emails.tsx` | `email_control` + `financial_account_control` por `message_id` (RLS por remetente p/ grupo restrito — migration 078) |
| `/consulta` | `Consulta.tsx` | `financial_account_control` (scroll infinito + virtualização, filtros, CSV client-side; RLS por dono p/ grupo restrito — migration 076) + `financial_account_attachment` (painel de detalhe lista os anexos; o modal de edição adiciona/remove — ver "Anexos de conta"). Painel de detalhe: **Editar conta** + **Excluir conta** (hard delete só p/ grupo Administrador — ver "CRUD de contas") |
| `/erros` | `Erros.tsx` | `email_processing_errors` (RLS por remetente p/ grupo restrito — migration 078) |
| `/contas` | `ContasNovaPage.tsx` | `financial_account_control` (lançamento manual via `ContaForm`) + `financial_account_attachment` (anexos enviados após o POST devolver o id — ver "Anexos de conta") |
| `/fornecedores` | `SuppliersPage.tsx` | `supplier` (CRUD via Next API) |
| `/tabelas/centros-de-custo` | `CostCentersPage.tsx` | `financial_cost_center` (CRUD via Next API) + grid complementar mestre-detalhe do plano de contas do centro selecionado (`financial_chart_of_account` lançável) |
| `/tabelas/bancos` | `BanksPage.tsx` | `financial_bank` (CRUD via Next API) |
| `/tabelas/contas` | `FinancialAccountsPage.tsx` | `financial_account` (CRUD via Next API) |
| `/tabelas/plano-de-contas` | `ChartAccountsPage.tsx` | `financial_chart_of_account` (CRUD via Next API) |
| `/tabelas/grupos-plano-de-contas` | `ChartAccountGroupsPage.tsx` | `financial_chart_of_account_group` (CRUD via Next API) |
| `/tabelas/subgrupos-plano-de-contas` | `ChartAccountSubgroupsPage.tsx` | `financial_chart_of_account_subgroup` (CRUD via Next API) |
| `/dashboard` | `Dashboard.tsx` | `financial_account_control` (KPIs/gráficos por mês ou geral; `getDashboardData`). **Cards de KPI clicáveis = filtro** (Total/Pagos/A vencer/A vencer em 7 dias/Vencidas): clicar aplica o filtro (`KpiFilter`) a TODOS os gráficos; os KPIs seguem com os totais completos. **4 donuts** (situação · tipos de conta · **Tributos** = só guias tributárias detalhadas · formas de pagamento; tipos de conta colapsa os tributários numa fatia "Tributos" via `groupDocumentTypeLabel`/`isTaxDocumentType`) |
| `/cobranca/envios` | `cobranca/CobrancaEnvios.tsx` | `cobranca_envios_log` (ver "Pipeline de cobrança de vencidos") |
| `/cobranca/erros` | `cobranca/CobrancaErros.tsx` | `cobranca_erros_log` |

- `services/supabase.ts` — fetch direto REST, `Prefer: count=exact` + `Content-Range` para paginação.
  O total é parseado por `parsePaginationTotal` (resiliente): quando o PostgREST devolve a contagem
  indisponível (`*/*` ou `0-19/*`), **não zera** — estima `offset + itens + (página cheia ? pageSize : 0)`
  e marca `totalIsEstimate` em `Paginated<T>` (evita prender o usuário na página 1). `Consulta.tsx`
  trata a estimativa de forma transparente (sem mudança visual no footer).
- `services/emailReader.ts` — leitura IMAP **assíncrona com progresso** (proxy Vite → Flask):
  `startEmailRead` faz `POST /api/emails/read/start` (Flask dispara `run_reader` numa **thread**
  e responde na hora) e `getEmailReadProgress` faz `GET /api/emails/progress`. `Emails.handleRead`
  faz **poll a cada ~1,5s** mostrando um banner com fase + barra `done/total` + contadores +
  cronômetro (`elapsed`), e recarrega KPIs/tabela a cada ~5 polls. **Por que assíncrono:** o
  modelo síncrono antigo segurava um request por minutos — o proxy derrubava a conexão e o botão
  "voltava" antes do fim (parecia travado). `run_reader(on_progress=...)` é a fonte do progresso
  (callback best-effort, não derruba o run); o estado vive em `server/app.py` (dict + lock, **um
  job por vez**). O `POST /api/emails/read` síncrono permanece só para a ponte da Next API.
  **Reconexão ao job (não regredir):** o poll vive em `trackJob` (idempotente via `trackingRef`),
  reusado por `handleRead` **e** por um efeito no mount que consulta `GET /progress` e, se houver
  job **rodando**, retoma banner + poll. Sem isso, atualizar a aba no meio do processamento perdia
  o estado e o botão parecia "pronto" enquanto o backend seguia registrando (total subia a cada
  refresh). O card **"Total de e-mails"** (sub-rótulo "na caixa de entradas") = contagem de
  `email_control`, que converge para o total do INBOX **quando o job termina** (não antes).
  **`/consulta` reusa o mesmo motor:** o botão **"Atualizar"** (topo direito) dispara
  `startEmailRead({ days: 7 })` + poll de progresso (mesmo padrão: banner `info` "Buscando
  e-mails dos últimos 7 dias…", recarrega o grid ao vivo a cada ~5 polls e no `finally`, e
  suspende/retoma o logout por inatividade) — assim traz e-mails novos **sem abrir `/emails`**.
  O **label permanece "Atualizar"** (só ganha spinner + disabled enquanto processa); a guarda
  `readingRef` evita disparos concorrentes. Não há reconexão ao job aqui (escopo do `/emails`).
- **TanStack Query v5 — rollout PENDENTE para `Consulta.tsx` e `Emails.tsx`:** o padrão já está
  aplicado em `SuppliersPage` (`staleTime: 60_000`, `gcTime: 300_000`, `refetchOnWindowFocus:
  false`). As duas páginas de maior volume ainda usam `useEffect`+`fetch` direto; migrar seguindo
  o mesmo padrão de `SuppliersPage` quando houver oportunidade. **Não** adicionar `useMemo`/
  `useCallback`/`React.memo` manualmente — o React Compiler cuida da memoização.
- **Disparo de leitura IMAP é OCULTO em produção (`src/lib/featureFlags.ts` → `EMAIL_READER_ENABLED`):**
  os 3 botões que acionam o Flask — `/emails` **"Buscar novos"** + **"Busca Geral"** e `/consulta`
  **"Atualizar"** — só renderizam quando a flag está ligada. A flag é `import.meta.env.PROD ? false :
  true` por padrão (LIGADA em dev, DESLIGADA no build do Vercel, onde **não há Flask**); override
  `VITE_EMAIL_READER_ENABLED='true'` reativa (quando o Flask for exposto numa VM). O efeito de
  **reconexão ao job** em `/emails` (poll de `GET /progress` no mount) também é pulado quando a flag
  está desligada (não tenta falar com um backend inexistente). Os botões **"Buscar"** (filtro) e
  os **"Atualizar"** que só recarregam do Supabase (`/emails`, `/erros`, `/fornecedores`) **não** são
  afetados — funcionam no domínio. Ver memória [[vercel-deploy]].
- **Busca textual com debounce (form vs. aplicado) — padrão em `/consulta` e `/emails`:** o input de
  busca escreve num estado de **formulário** (`f.supplier` / `senderInput`), separado do valor
  **aplicado** que dispara o fetch (`applied.supplier` / `filters.sender`). Um `useEffect` com debounce
  de **350ms** e `cleanup` (`clearTimeout`) commita form→aplicado — **fonte única, sem `ref`** — com
  guarda `if (form === aplicado) return` (cobre o mount). Enter/Buscar commitam na hora; o `cleanup`
  cancela o timeout pendente quando o aplicado muda por outra via (Enter, card, limpar), eliminando a
  corrida em que um debounce antigo sobrescreveria o valor recém-aplicado. Isso evita o refetch a cada
  tecla (antes `/emails` recarregava por caractere porque `load` dependia de `filters` inteiro).
- **Fornecedor + classificação vêm de JOIN/embeds (migrations 040/041/042 + 047):**
  `financial_account_control` não guarda nome/CNPJ/CPF — só a FK `sk_supplier`.
  `getFinancialAccountControl` e `getAccountsByMessageId` usam o `SELECT_WITH_EMBEDS`:
  `*,supplier(trade_name,legal_name,cnpj,cpf),cost_center:financial_cost_center(cost_center_code,cost_center_description),chart_account:financial_chart_of_account(account_code,account_description,group:financial_chart_of_account_group(group_code,group_description),subgroup:financial_chart_of_account_subgroup(subgroup_code,subgroup_description))`.
  O embed de `chart_account` traz a **hierarquia aninhada** (grupo/subgrupo) para a **célula
  enriquecida "Plano de contas"** do grid (plano + grupo + subgrupo + centro de custo concatenados —
  ver seção do `useGridColumns`). O grid exibe o fornecedor por **`trade_name`** apenas (sem fallback
  para `legal_name` no grid — o card de detalhe e o CSV mantêm o nome completo) e **Plano de contas**
  (concatenado); a coluna **CNPJ/CPF** e a **coluna "Centro de custo"** foram **removidas do grid** (a
  primeira segue no detalhe; o centro de custo agora aparece dentro da célula de plano de contas).
  Lookups da Next API em `services/lookups.ts`. No **card de detalhe**
  de `/consulta`, o campo **Fornecedor** exibe `sk_supplier - nome` (helper `fmtSupplier`; fallback
  só o id quando o JOIN não traz nome) — o cabeçalho do painel, a coluna do grid e o CSV seguem só
  com o nome.
  A coluna **"Fornecedor" É ordenável** server-side por `supplier(trade_name)` (embed do PostgREST);
  ver a nota das colunas de embed acima. A **busca por fornecedor** resolve antes os `sk_supplier` que casam o termo
  na tabela `supplier` (nome/CNPJ/CPF + 4 e-mails, via `findSupplierIdsByTerm`) e filtra
  `sk_supplier=in.(...)` — o `applyFinancialFilters` casa ainda `invoice_number`/`subject`/
  `sender_email`, que são colunas próprias da conta.
- **Busca inclui a CLASSIFICAÇÃO CONTÁBIL (mesmo campo livre):** como
  `financial_account_control` só guarda as FKs `cost_center_id`/`chart_account_id` (grupo/subgrupo
  vêm por hierarquia a partir do plano), o termo resolve antes os ids nos cadastros e filtra por
  `cost_center_id=in.(...)`/`chart_account_id=in.(...)` — mesmo padrão do fornecedor. Resolvers em
  `services/supabase.ts` (espelham `findSupplierIdsByTerm`): `findCostCenterIdsByTerm` (casa
  `cost_center_code`/`cost_center_description`) e `findChartAccountIdsByTerm` (casa `account_code`/
  `account_description` do plano **OU** o grupo/subgrupo — resolve `chart_account_group_id`/
  `chart_account_subgroup_id` primeiro, via as FKs diretas migration 058, e entra como `.in.(...)` no
  `or` do plano). O helper `resolveSearchIds(term)` resolve fornecedor + centro + plano em **paralelo**
  (`Promise.all`) e alimenta os 3 call sites (grid/valor total/contagem). Ambos os cadastros **excluem
  o sentinela id 0** ("não informado" — `id=gt.0`). Busca por valor (`R$ …`) continua exata, pulando
  os resolvers. `applyFinancialFilters` acrescenta as duas cláusulas ao `or(...)` só quando o array
  não é vazio (evita `in.()` inválido). Testado em `services/supabase.test.ts` (composição pura do
  `or`); o placeholder/`aria-label` do input de `/consulta` citam a classificação.
- **Busca também por VALOR do documento + valores de `ilike` CITADOS (`services/supabase.ts`):**
  quando o termo da busca é um valor monetário (formato BR ou simples — `463,21`, `44.406,08`,
  `391`, `463.21`), `parseBrlAmount` o converte e adiciona `amount.eq.<valor>` ao `or(...)`
  (correspondência **exata**); termos não-numéricos seguem só na busca textual. Os valores dos
  `ilike` passam por `ilikeContains` (entre **aspas duplas**: `"*termo*"`) — sem isso, um termo com
  **vírgula** (ex.: `463,21`) quebrava o `or(...)` inteiro do PostgREST (a vírgula é delimitador de
  cláusula → erro `PGRST100 failed to parse logic tree`). Aplicado tanto em `applyFinancialFilters`
  (conta) quanto em `findSupplierIdsByTerm` (fornecedor). Índices de performance da busca em
  `financial_account_control` (migration **060**): GIN trigram em `invoice_number`/`subject`/
  `sender_email` (para `ilike '%termo%'`), btree em `amount` e em `created_at DESC`.
- **`/consulta` — `cancelado` aparece no GRID, mas NÃO nos KPIs (mudança 2026-06-25):** a regra
  antiga ocultava cancelado em tudo; agora o **grid mostra canceladas** por padrão e os **KPIs as
  excluem** (para o "Valor total"/"Total de registros" não somar cancelado e gerar confusão). Como
  isso é implementado: `applyFinancialFilters` recebe `includeCancelled` (default **false** = exclui)
  — o **grid** (`getFinancialAccountControl`) passa `true`; o card **"Valor total"**
  (`getFinancialAccountTotalValue`) usa o default (exclui). O `getFinancialStats` mantém
  `status_id=neq.<cancelado>` (KPIs gerais sem cancelado — por `STATUS_ID_CANCELADO`). Filtro
  explícito de situação (`status_id=eq.<id>`) sobrescreve tudo nos dois caminhos. **Consequência aceita:** o rodapé do grid ("N de M") conta
  canceladas e o KPI "Total de registros" não — divergência **intencional** (cancelado é visível,
  mas fora dos totais). Linha cancelada é pintada de vermelho (`bg-status-error-solid/15`, via
  `DataGrid rowClassName`), tom distinto do badge "vencido".
- **Grid compartilhado sobre TanStack Table v8** (`organisms/DataGrid.tsx`): `/consulta` (tema
  `default`) e `/emails` (tema `silver`) usam o mesmo grid, com as colunas de `useGridColumns.ts`
  (`getConsultaColumns` / `getEmailColumns`). O TanStack é **headless**: fornece row model (core),
  header groups e os estados de layout. A interface pública `DataGridProps<T>` é retrocompatível —
  features novas são **opt-in** via props.
  - **Sort e filtro seguem SERVER-SIDE** (Supabase): `manualSorting` ligado, sort via
    `onSort`/`sortCol`/`sortDir`, filtros nas páginas. **Nunca** ligar
    `getSortedRowModel`/`getFilteredRowModel`/`getPaginationRowModel`: o grid recebe linhas já
    filtradas/ordenadas pelo servidor, então esses modelos client-side agiriam sobre um subconjunto = bug.
  - **Virtualização de LINHAS + scroll infinito (opt-in `enableRowVirtualization`, usado em `/consulta`)** —
    `@tanstack/react-virtual`. `/consulta` deixou de paginar em botões e passou a **scroll infinito**
    (`Consulta.tsx`: `PAGE_SIZE=50`, acumula linhas, `loadMore` por `onLoadMore` do grid + botão
    "Carregar mais"; rodapé "{carregadas} de {total}"). Técnica **spacer-rows** (linhas em fluxo normal
    entre dois `<tr>` espaçadores — **preserva `table-fixed`, larguras, fixação sticky e o `<thead>`
    fixo**, sem posicionamento absoluto); cada `<tr>` real leva `data-index` + `ref={measureElement}`
    para **altura dinâmica** (cobre word-wrap, sub-linha, rodapé e o detalhe expandido). `buildRenderItems`
    (`dataGrid.rows.ts`) achata as linhas em itens `row/second/footer/detail` (1 item = 1 `<tr>`). **Fallback
    sem layout (jsdom/testes):** altura do viewport `0` → renderiza tudo (não virtualiza), mantendo os
    testes verdes. `/emails` **não** liga virtualização.
  - **Rodapé de registro sempre-visível (opt-in `renderRowFooter`, usado em `/consulta`)**: prop
    `renderRowFooter?: (row) => ReactNode` — quando retorna nó não-nulo, o grid emite um `<tr>`
    full-width (`colSpan`, slot `footerCell`) **abaixo das células daquele registro**, sempre visível
    (sem clique), distinto do `detail` (clique/seleção) e do `second` (breakpoint). Ordem dos itens:
    `row → second → footer → detail`. `/consulta` usa para exibir a **informação adicional**
    (`additional_info`) só nos registros que a têm — ver "CRUD de contas". Virtualização preservada
    (o footer é um `RenderItem` próprio com `data-index`/`measureElement`; `estimateSize` ~30px).
    - **Auto-recuperação do scrollRect (não regredir):** o `react-virtual` cacheia a altura do viewport
      (`scrollRect`) via `ResizeObserver`; trocas de aba/inatividade (ou um "ResizeObserver loop") fazem
      o navegador **descartar notificações de resize** → o `scrollRect` fica defasado (pequeno), a janela
      virtual encolhe e o grid renderiza só ~4 linhas com o corpo em branco. Duas defesas: (1)
      `useAnimationFrameWithResizeObserver: true` no virtualizer (reduz notificações perdidas por loop);
      (2) um efeito que, ao reganhar `visibilitychange`/`focus`/`pageshow`/`resize`, re-mede o viewport
      real e — **só se divergir** do cache — reinjeta em `rowVirtualizer.scrollRect` + `measure()`
      (guardado contra altura 0). Cobre o caso "aba em background → volta com o grid em branco".
  - **Camadas responsivas** (própria, não do TanStack): (1) breakpoint pela largura **real do
    container** (`useContainerBreakpoint`/`ResizeObserver`) oculta `hideOn` e desce `secondLine`
    para a sub-linha; (2) truncagem (`truncate`) com `title`; (3) rolagem horizontal no viewport.
    **Visibilidade efetiva = (usuário não ocultou via menu) E (breakpoint não escondeu).**
    `getVisibleLeafColumns()` já exclui as ocultas pelo usuário; o filtro de breakpoint vem por cima.
  - **Gestão de colunas (opt-in `enableColumnManagement` + `gridId`)**: `GridToolbar` expõe
    mostrar/ocultar e **fixar** colunas (`ColumnVisibilityMenu`), **densidade** (confortável/compacto),
    **restaurar layout**; **redimensionar** (resize handle) e **reordenar por arraste** (@dnd-kit nos
    cabeçalhos — grip separado do clique de ordenação e da alça de resize). Layout persiste em
    `localStorage` por `gridId` (`useGridPreferences`). Nesse modo a `<table>` vira `table-fixed` com
    larguras de `column.getSize()` (default 160 ou `ColumnDef.size`, respeitando `minSize`) e
    `width = getTotalSize()` — daí o **cabeçalho fixo** (`maxBodyHeight` cria viewport rolável) e a
    **fixação** (sticky + offset via `column.getStart/ getAfter`, com sombra na borda) funcionarem; sem
    gestão, mantém o layout `w-full` antigo. **Defaults por grid (props `defaultPinning`/`defaultDensity`,
    semeados em `useGridPreferences` e no `reset()`; prefs salvas do usuário prevalecem):** `/consulta`
    abre **compacto** (`defaultDensity="compact"` — padding `px-2 py-1` + `text-xs`) e com **Nº Documento,
    Emissão e Fornecedor fixados à esquerda** (`defaultPinning`). `columnResizeMode: 'onChange'`.
  - **Seleção múltipla (opt-in `enableSelection`)**: coluna de checkbox (`SelectCheckbox`, sempre 1ª e
    fixada à esquerda) + barra de ações com **"Exportar selecionadas"** (`onExportSelected` — em
    `/consulta` reusa o `exportCsv`) e **alteração de situação em lote** (`bulkStatusOptions` +
    `onBulkStatusChange` → select de situação + botão **"Aplicar"**; em `/consulta` chama
    `setFinancialAccountStatusBulk` (PATCH com filtro `id=in.(…)`, uma requisição) + update otimista
    das linhas e `refreshStats()` dos KPIs). A coluna de seleção (`__select__`) é injetada na
    ordem/fixação efetivas mas **nunca** gravada nas preferências (que ficam data-only) — evita
    duplicar o id. `/emails` **não** liga seleção (sem ação em lote de e-mail).
  - **Render das células sem `flexRender`**: o renderer do `cell` é chamado direto (helper
    `cellValue`) para preservar o **valor cru** (string) que o `title` da truncagem exige — `flexRender`
    o envolveria num componente. Não regredir.
  A **sidebar** (`Layout.tsx`) colapsa em drawer com hambúrguer abaixo de `lg`; em `lg+` é estática.
  Dependências do grid: `@tanstack/react-table`, `@tanstack/react-virtual`, `@dnd-kit/core|sortable|modifiers`.

### Build e code-splitting (`frontend-vite`)

- **Rotas lazy** (`App.tsx`): só `LoginPage` entra no bundle inicial; as demais páginas
  (`Emails`/`Consulta`/`Erros`, os CRUDs do grupo Tabelas, `Dashboard`, cobrança, fluxos de
  auth secundários `Forgot`/`Reset`) são `React.lazy` + `Suspense` (fallback "Carregando…";
  um `Suspense` interno mantém o `Layout`/sidebar visível enquanto a página carrega). **Toda
  rota/página nova segue esse padrão** `lazy(() => import(...))`.
- **Recuperação de chunk lazy obsoleto + Error Boundary (não regredir — corrige "tela
  branca"):** um deploy novo no Vercel invalida os hashes dos assets referenciados pelo
  `index.html` já aberto na aba; ao navegar para uma rota lazy ainda não baixada (cenário
  típico: logout por inatividade → login → entrar), o `import()` 404/serve HTML → o React
  lança no render. Como `Suspense` **não captura erro** (só loading), sem rede de segurança
  a árvore inteira sumia (tela branca; só um refresh resolvia). Camadas (`main.tsx`):
  - **`components/ErrorBoundary.tsx`** (boundary raiz, envolve o `App`): erro de **chunk** →
    **auto-reload** uma vez ("Atualizando…", trava anti-loop de 2/sessão em `sessionStorage`);
    erro de **runtime** → fallback com botão **"Recarregar"** (sem mais tela branca).
  - **`lib/chunkReload.ts`**: `isChunkLoadError` (heurística por mensagem), `reloadOnceForChunk`
    (anti-loop), `installPreloadErrorReload` (handler `vite:preloadError` — recarrega antes do
    React tentar renderizar o erro) e `clearChunkReloadCount` (zera o contador no mount do `App`,
    sinal de bundle OK). Testes: `chunkReload.test.ts`, `ErrorBoundary.test.tsx` (+ a11y).
  - **`AuthContext.init()` endurecido**: `try/catch/finally` garante que `loading` **sempre**
    resolva (sem ficar preso em "Carregando…" se o SDK/storage lançar) — vai ao login em vez
    de travar.
- **`manualChunks`** (`vite.config.ts`): `react-vendor` (react/-dom/router) e `supabase`
  (SDK) em chunks próprios — melhora cache e download paralelo e elimina o aviso `>500 kB`
  do Vite. O código de cada rota lazy vira um chunk à parte automaticamente. **No Vite 8
  (Rolldown) o `manualChunks` é uma FUNÇÃO** (o objeto não é mais aceito) — um regex casa os
  pacotes exatos por segmento de `node_modules` (não pega `react-hook-form`/`lucide-react`/
  `@tanstack/react-table`). O `vite.config.ts` também tem `resolve.dedupe: ['react','react-dom']`
  para garantir uma única cópia do React (hoje **defensivo** — `npm ls react` confirma o
  monorepo unificado em react@19.2.7; mantido contra um futuro transitivo react@18).
- **Resolução de `paths` do tsconfig é NATIVA do Vite 8** (`resolve.tsconfigPaths: true`) — o
  plugin `vite-tsconfig-paths` foi **removido** (era redundante e pesava no build, alerta
  `PLUGIN_TIMINGS` do Rolldown; o build caiu ~3.1s→1.3s). Os aliases `@/` e `@shared/` saem do
  `tsconfig.json`. **Não reintroduzir** o plugin.
- **`skipLibCheck: true` é obrigatório** nos 4 `tsconfig.json`: sem ele o `typecheck` quebra
  com erros de tipos de **terceiros** não acionáveis — `@supabase/auth-js` (`webauthn.dom.d.ts`),
  `@tanstack/table-core` (`ColumnMeta`) e os `.next/types/*` gerados pelo Next. Testado na
  auditoria pós-upgrade (2026-06-19); **não remover**.

### Deploy do frontend (Vercel)

Deploy automático pelo GitHub (push em `main` → **production**; `Features`/PR → **preview**).
Topologia (team **`sheild`** = `team_z1BPf9qevCGsfohGRhm52iBn`):

| Projeto Vercel | Papel | Domínio |
|---|---|---|
| `pagamentos-web` | Frontend (Vite SPA) | **pag.otimotex.com.br** (alias de produção) |
| `pagamentos-api-backend` | Next API de dados | `pagamentos-alpha-six.vercel.app` (rewrite `/data-api` em `apps/frontend-vite/vercel.json`) |

**O repo NÃO tem `.vercel/project.json`** — para inspecionar deploys (estado/commit), descubra o
team/projeto via Vercel MCP (`list_teams` → `list_projects` → `list_deployments`). O deploy de
produção correto é o `state=READY` + `target=production` cujo `githubCommitSha` casa o merge em
`main`; um `CANCELED` logo após, com `githubCommitRef=Features` e o mesmo SHA, é só o preview
redundante (normal, sem impacto). Flask/IMAP **não** vão para o Vercel — a leitura de e-mails fica
local/agendada (ver flag `EMAIL_READER_ENABLED` acima e memória [[vercel-deploy]]).

## Banco de dados (Supabase)

Migrations em `supabase/migrations/`, aplicadas **manualmente no SQL Editor** em ordem
numérica (`001` → `084`). **Próxima migration = `085`** (verificar sempre antes de criar nova).
Não há migration automática. A **084** implanta a **regra LEBIANCO** da empresa pagadora (ver
"Empresa pagadora (`sk_company`) — regra LEBIANCO"): (1) o trigger `trg_fe_resolve_company()`
passa a **respeitar `sk_company` explícito** (`IF NEW.sk_company IS NULL THEN resolve…`) — sem
isso o valor gravado pelo Python era descartado **e qualquer UPDATE re-resolvia a empresa**; e
(2) **backfill** das contas já extraídas (55 de 436 → `sk_company=2`). Aplicada via psql em
2026-07-17; **idempotente** (re-run = 0 linhas). A **083** introduz a **surrogate key snowflake `sk_company`**:
`sk_company` (BIGINT `GENERATED ALWAYS AS IDENTITY`) vira a **PK** de `company` e a **chave única
de relacionamento** do app; `company_id` passa a **campo de origem** (NOT NULL UNIQUE, do sistema
maior). `financial_account_control.company_id` é **substituída** por `sk_company` (backfill via
JOIN + FK `fk_fac_company` + índice `idx_fac_sk_company`; a coluna `company_id` é DROPADA). O
trigger de resolução (`trg_fe_resolve_company()`, SECURITY DEFINER — lição da 074) passa a gravar
`NEW.sk_company` via a nova função **`resolve_company_sk(payer_cnpj, payer_name)`** (REVOKE EXECUTE
de anon/authenticated + GRANT service_role, mirror 072; fallback = sk da empresa `company_id=1`); a
antiga `resolve_company_id` é DROPADA e o trigger foi renomeado `trg_fe_company_id`→
`trg_fe_sk_company`. Espelha a 042 (supplier). **One-time — não re-executável** (troca de PK/
IDENTITY, como 042/050/051). **Aplicada via psql em 2026-07-17** (`SUPABASE_DB_URL` +
`:5432/postgres`); a coluna `sk_company` criada pelo usuário tinha `DEFAULT 0` (sentinela) — a
migration o **dropa antes** do `ADD GENERATED ALWAYS AS IDENTITY` (não coexistem). As guardas de
string em `resolve_company_sk` usam `length(trim(x)) > 0` (não `trim(x) <> ''`) para evitar um
**falso positivo do SonarCloud** (analisador PL/SQL com semântica Oracle, onde `'' = NULL`);
comportamento idêntico em PostgreSQL. **NÃO reaplicar.** A **082** adiciona as colunas de CONTATO em `supplier`
(telefone/WhatsApp/chave PIX, 2 slots cada — ver "Contato do fornecedor"); aplicada **via psql**
(`SUPABASE_DB_URL` + `:5432/postgres`, com o Supabase MCP indisponível na sessão), idempotente
(`ADD COLUMN IF NOT EXISTS` + REVOKE de escrita do papel `authenticated`). (As `059`/`060`/`061`/`063`/`064`/`066`/`067`/
`068`/`069`/`070`/`071`/**`072`**/**`073`**/**`074`**/**`075`**/**`076`**/**`077`**/**`078`**/**`079`**/**`080`**/**`081`** foram aplicadas **direto via Supabase MCP** nesta
máquina — o arquivo numerado serve
de histórico; **não reaplicar** no SQL Editor (todas idempotentes, mas evite re-run). A **081**
(**fecha a ESCRITA por `authenticated` no caminho REST direto** — ver "Escrita direta por
`authenticated`" e "ESCALADA DE PRIVILÉGIO pela view `app_user`"): (a) **CRÍTICO** — `REVOKE
INSERT/UPDATE/DELETE` na view `app_user`, que era auto-atualizável e rodava como owner: qualquer
usuário logado alterava `auth.users` (trocar o e-mail do Administrador → tomar a conta pelo "esqueci
minha senha"); (b) as policies de UPDATE de `financial_account_control` e `email_control` eram
`USING (true)` → passam a usar o MESMO predicado do SELECT (076/078), preservando a curadoria por
clique (ester: 36 próprias × 0 alheias; barbara: 412); (c) `REVOKE` dos grants default residuais em
6 tabelas + `INSERT, DELETE` (nunca `UPDATE` — quebraria os grants por coluna) nas duas da
curadoria. A **080**
(**a leitura do BUCKET herda a visibilidade da conta** — ver "Visibilidade do Storage por dono"):
a policy da 021 era `USING (bucket_id='attachments')` **sem filtro de dono** — o grupo restrito via
36 contas pela tela mas alcançava os **565 objetos** do bucket pela API do Storage (a chave é
obtível: `GET /api/contas/:id` devolve `source_file` e `/attachments` o `storage_key`, ambos via
service_role). Agora o objeto só é liberado se existir uma linha **visível para o próprio usuário**
(`EXISTS` em `financial_account_attachment.storage_key` OU `financial_account_control.source_file`)
— as subconsultas rodam como `authenticated`, então a RLS da 076/079 se aplica dentro delas e a
policy **herda a regra sozinha**. Verificado: Comercial 565→**20** objetos (0 alheios), Financeiro
565→**233** (não perdeu nenhum). + índice `ix_fac_source_file`. A **079**
(**anexos MÚLTIPLOS por conta** — ver "Anexos de conta"): cria
`financial_account_attachment` (1:N → `financial_account_control`, `origin` manual/pipeline, soft
delete `deleted_at`/`deleted_by`, UNIQUE `(account_id, storage_key)`), RLS SELECT que **herda a
visibilidade da conta pai** via `EXISTS` (sem duplicar o predicado da 076 — verificado com o papel
`authenticated` real: Comercial vê 36 contas/26 anexos, Financeiro vê tudo) + **`REVOKE INSERT,
UPDATE, DELETE` do papel `authenticated`** (o Supabase concede esses grants por DEFAULT em toda
tabela nova; a RLS já bloqueava, mas o REVOKE é a mesma defesa em profundidade das 056/057 —
sem ele a tabela ficaria assimétrica com `supplier`/`status`) + backfill dos `source_file` existentes
como `origin='pipeline'` (na aplicação: 249 linhas / 228 objetos — há menos objetos que contas porque
um PDF com N boletos gera N contas). `source_file` **permanece** na conta (dedup/auditoria do
pipeline). A **078**
(**Etapa 1 estendida a `/emails` e `/erros`** — ver "Visibilidade de contas por dono"): reescreve as
policies SELECT de `email_control` e `email_processing_errors` (papel `authenticated`) para
`NOT public.auth_group_sees_only_own() OR lower(sender_email) = lower(auth.email())` — reusa o helper
e a flag `user_group.sees_only_own_accounts` da 076, mas casando o **remetente do e-mail** com o e-mail
do usuário logado (não o `created_by`/UUID). Grupo restrito (Comercial=6) vê só os e-mails/erros de que
é remetente; demais grupos veem tudo (preservado); `service_role` mantém bypass. A **077**
(**Etapa 2 — auditoria de autor** — ver "Visibilidade de contas por dono"): adiciona
`updated_by`/`status_changed_by`/`status_changed_at` (NOT NULL DEFAULT sentinela + FK) + backfill; a
trigger `trg_fac_authorship` (`fn_stamp_account_authorship`, SECURITY DEFINER — roda ANTES dos
`trg_fe_*` para ver o `status_id` do humano, não o recálculo) carimba o editor via
`coalesce(auth.uid(), explícito)`; e a view `public.app_user (id,email)` (grant `authenticated`) para
exibir o autor. A **076**
(**Etapa 1 — visibilidade de contas por DONO, por grupo** — ver "Visibilidade de contas por dono"):
adiciona `financial_account_control.created_by` (UUID → `auth.users`, NOT NULL DEFAULT sentinela
`teste@otimotex.com.br`, FK `ON DELETE SET DEFAULT`) + backfill via `sender_email`; flag
`user_group.sees_only_own_accounts` (Comercial=6 → true); RPC `resolve_user_for_account(p_email)`
(service_role); helper `auth_group_sees_only_own()`; e troca a policy SELECT de
`financial_account_control` para `NOT auth_group_sees_only_own() OR created_by = auth.uid()`
(grupo sem flag vê tudo; Comercial vê só as próprias; service_role/admin com bypass). A **075**
remove **`pix`** do CHECK de `financial_account_control.document_type` (pix é só forma de pagamento)
+ backfill dos 39 registros `pix`→`outro` — ver "Normalização de `document_type`". A **074**
(correção de REGRESSÃO da 072 — não regredir): a 072 revogou `EXECUTE` de `resolve_company_id` de
`authenticated`, mas o trigger `BEFORE INSERT/UPDATE trg_fe_company_id` → `trg_fe_resolve_company()`
era **SECURITY INVOKER**, então passou a rodar como `authenticated` (sem EXECUTE) e **quebrou TODO
UPDATE do frontend** em `financial_account_control` — marcar NF/BOL e trocar situação em `/consulta`
davam `403 permission denied for function resolve_company_id`. Fix: a função do trigger vira
**`SECURITY DEFINER`** (owner `postgres`, que mantém EXECUTE) + `search_path` fixo + chamada
qualificada `public.resolve_company_id`. Comportamento inalterado (o `company_id` já era resolvido em
todo write); o vetor S2-1 segue FECHADO (RPC direta por `anon`/`authenticated` continua `42501`).
Verificado no banco: `prosecdef=true`, UPDATE de curadoria como `authenticated` não levanta 42501, e
`anon`→42501 na RPC. **Lição:** ao revogar EXECUTE de uma função chamada por TRIGGER, garantir que a
função do trigger seja SECURITY DEFINER (owner com EXECUTE) — senão todo write pelo papel restrito
quebra. A **073**
(higiene da auditoria de segurança 2026-07-08, idempotente): (1) **A5-2** — seed do grupo 1
"Administrador" em `user_group` (a 065 faz `UPDATE user_profile SET group_id=1`, mas a 063 só semeava
o sentinela 0 — em aplicação LIMPA a FK abortaria); (2) **S2-2** — policy **RESTRICTIVE**
`attachments_no_delete_authenticated` em `storage.objects`, bloqueio EXPLÍCITO de DELETE por
`authenticated` no bucket `attachments` (antes só o default-deny da RLS protegia; `service_role`
ignora RLS). A **072** (segurança **S2-1**, BLOQUEADOR de go-live — não regredir): `REVOKE EXECUTE`
de PUBLIC/anon/authenticated nas 6 RPCs `SECURITY DEFINER` de fornecedor (`resolve_supplier_id`,
`resolve_supplier_for_account`, `resolve_company_id`, `_enrich_supplier`, `_enrich_supplier_name`,
`_add_supplier_email`) + `GRANT` a `service_role` — fecha o vetor de escrita em `supplier` via
`/rest/v1/rpc` com a anon key (`SECURITY DEFINER` ignora RLS); verificado por `anon`→`42501`. A **071** adiciona
**`débito automático`** ao CHECK de `financial_account_control.payment_method` (débito direto em conta,
distinto do `débito` cartão) + re-mapeia as contas Sabesp de água (171/189/190) `débito`→`débito
automático` — ver "Forma de pagamento DECLARADA no corpo". A **070** cria a
trigger `trg_supplier_no_funcionario_classification` (fornecedor de FUNCIONÁRIO não carrega
classificação default — força `supplier.cost_center_id`/`chart_account_id`=0; ver "Classificação
default do fornecedor") + backfill. As **067/068/069**
são a migração faseada de **`status_id` como fonte única** da situação (remoção do `status` texto —
ver a nota da migração faseada em "Banco de dados"): **067** `status_id` NOT NULL DEFAULT 3; **068**
trigger id-primária + `GRANT UPDATE(status_id) TO authenticated`; **069** trigger só-id + DROP do CHECK
e da coluna `status`. A `066` amplia o CHECK de
`financial_account_control.document_type` com **`cartório`** (pagamento de/em cartório) + backfill dos
genéricos com contexto de cartório no assunto (id 400) — ver "Normalização de `document_type`"; ocupou
o nº que o roadmap de RBAC estimava (066–068), que desloca para 067+ quando for implementado. A `065`
cria **`public.user_profile`** (vínculo usuário→grupo por FK — ver "Grupos de usuário"). A `064` adiciona
`financial_account_control.additional_info` TEXT (nullable) — texto livre do usuário no cadastro
de contas, exibido no card de detalhe de `/consulta`; ver "CRUD de contas". A `063` cria o catálogo
**`public.user_group`** (fundação de permissões por grupo — id 0 sentinela + RLS read
`authenticated`/write `service_role`) + backfill `app_metadata.group_id=0` nos usuários; ver
"Grupos de usuário" na seção de papéis e o blueprint `docs/design/permissoes-por-grupo.md`.
(Há um `062` **duplicado** no diretório — `062_chart_account_default_level_3` e
`062_doc_type_multa_dare`; a numeração seguiu para 063.) A `061` adiciona
**`image_vision`** ao CHECK de `financial_account_control.extraction_source` — anexos de IMAGEM
lidos via Claude Vision; ver "extraction_source — origem dos dados". A `060` cria **índices de
performance** da pesquisa em `/consulta` (GIN trigram em `invoice_number`/`subject`/`sender_email`
para `ilike '%termo%'`, btree em `amount` e em `created_at DESC`). A `059` é o **backfill ÚNICO**
da classificação contábil das contas a partir do fornecedor (contas com `cost_center_id=0` E
`chart_account_id=0` herdam a classificação do supplier; fora do fluxo diário de extração).
A `058` adiciona a **FK direta**
`financial_chart_of_account.chart_account_group_id` → `financial_chart_of_account_group`
(+ índice parcial) — a coluna já existia (DEFAULT 0 = "não informado"), mas sem FK o PostgREST
não resolvia o embed `group` do grid/form de Plano de contas; sem valores órfãos, a constraint
não falha. A `057` é de **segurança**
(idempotente, defesa em profundidade): `REVOKE INSERT/UPDATE/DELETE` do papel `authenticated`
em `supplier`/`status` — o RLS já bloqueava (ambas só têm política de SELECT), isto remove o
grant default residual para simetria com a `056`; escrita segue só `service_role`. **O REVOKE do
grant default é um PADRÃO recorrente deste projeto, não um evento isolado** — o Supabase concede
INSERT/UPDATE/DELETE ao papel `authenticated` em toda tabela/VIEW nova do schema public, então
**toda migration que cria objeto novo deve terminar com o REVOKE do que o papel não escreve**
(056/057 nos cadastros, **079** no anexo, **081** nas 6 tabelas restantes + a view `app_user`,
onde deixar o default passar era uma escalada de privilégio real). Conferir com
`information_schema.role_table_grants` (grantee='authenticated', privilege_type in INSERT/UPDATE/
DELETE) — o esperado é a lista vazia, fora dos grants POR COLUNA intencionais das 030/033/068. A `056` é de **segurança**
(idempotente): habilita RLS + leitura `authenticated` + **REVOKE de escrita** do papel
`authenticated` nos cadastros pré-existentes (`company`/`financial_account`/`financial_bank`/
grupos/subgrupos) e em `audit_log` se existir — fecha o ponto cego de RLS apontado na
auditoria de segurança. **Exige verificação no SQL Editor antes de aplicar** — ver
`supabase/migrations/README.md` e `docs/review/seguranca/RELATORIO-SEGURANCA.md` §2. A `055` é **só documentação**
(`COMMENT ON`, idempotente/re-executável): registra no banco o ON DELETE efetivo das FKs de
classificação (`NO ACTION` ≡ `RESTRICT`) e que `status` é a 4ª coluna gravável por `authenticated`
em `financial_account_control` (036). Caveats operacionais — aplicação uma-vez/ordem, migrations
não re-executáveis (042/050/051/053/039) e pré-requisito de bootstrap (cadastros pré-existentes +
`normalize_search`) — em `supabase/migrations/README.md`. A `054` redefine
`resolve_supplier_id`: a busca por e-mail vira **fallback após o nome** (não-interno), corrigindo a
criação de fornecedor duplicado quando o e-mail já consta num cadastro — ver "Auto-resolução de
fornecedor". A `053` adiciona a FK
`financial_account.status_id` → `status.status_id` — formaliza no banco a relação do lookup
de situação do CRUD de Contas; a dimensão `status` tem os ids 1–10 do ciclo de contas a pagar
+ o 30 = "ativo" das contas bancárias, então não há linha órfã.) (As `050`/`051` convertem PKs para
**`GENERATED ALWAYS AS IDENTITY`** — id gerado SEMPRE pelo banco, inclusão direta de id BLOQUEADA
(exige `OVERRIDING SYSTEM VALUE`): a `050` em `financial_chart_of_account.chart_account_id`; a `051`
em `financial_account.financial_account_id`, `financial_chart_of_account_group.chart_account_group_id`,
`financial_chart_of_account_subgroup.chart_account_subgroup_id` e `financial_cost_center.cost_center_id`
(todas eram `smallint NOT NULL DEFAULT 0`; cada uma teve `DROP DEFAULT` → `ADD GENERATED ALWAYS AS
IDENTITY` → `setval` acima do `max` atual). A `052` adiciona `supplier.cost_center_id`/`chart_account_id`
(SMALLINT NOT NULL DEFAULT 0 + FKs + índices) e faz o **merge/backfill** a partir de
`financial_account_control` (par não-zero por fornecedor; diagnóstico: 0 conflitos) — base do **sync de
classificação default do fornecedor**, ver "Classificação default do fornecedor — sync bidirecional".)
(A `049` adiciona policy de **SELECT
`TO authenticated`** em `financial_cost_center` e `financial_chart_of_account` — sem ela, o RLS
estava habilitado **sem nenhuma policy** (default deny) e o embed `cost_center`/`chart_account`
lido pelo frontend com papel `authenticated` voltava **null**, fazendo o grid/detalhe de `/consulta`
mostrar o **`#id`** em vez da descrição. A Next API não sofria por usar service_role.) (As `047`/`048` adicionam a **classificação
contábil** em `financial_account_control`: a `047` cria `cost_center_id` SMALLINT (FK →
`financial_cost_center`) e `chart_account_id` SMALLINT (FK → `financial_chart_of_account`) +
índices; a `048` torna ambas **NOT NULL DEFAULT 0** — id 0 = sentinela "não informado" (a linha id 0
existe nos dois cadastros, então o JOIN sempre casa; a UI trata 0 como vazio "—"). Ver "CRUD de
contas" e "Lookups de classificação contábil". A `046` corrige a **ordem de resolução de
fornecedor** — nome antes do e-mail; e-mail só sem nome — e bloqueia e-mails de domínio interno
(`otimotex.com.br`/`lebianco.com.br`) em `supplier`; ver "Auto-resolução de fornecedor". A `045`
adiciona `supplier.deleted_at`
+ índice parcial — soft delete do CRUD de fornecedores, ver "CRUD de fornecedores (Next API)".
A `037` cria as tabelas de log da
cobrança de vencidos — ver "Pipeline de cobrança de vencidos". A `040` cria a RPC
`resolve_supplier_for_account`; a `041` dropa o trigger de resolução, a RPC
`financial_dup_by_name` e as colunas `supplier_name`/`supplier_cnpj`/`supplier_cpf`. A `042`
introduz a **surrogate key snowflake** `sk_supplier`: vira a PK auto-incremental de `supplier`
e o alvo de toda FK; `supplier_id` passa a chave de negócio (NOT NULL UNIQUE, só em `supplier`);
`financial_account_control.supplier_id` é substituída por `sk_supplier` — **ver "Auto-resolução
de fornecedor"**. A `043` adiciona os tipos `conta de água`/`conta de luz`/`conta de telefone /
internet` ao CHECK de `document_type` e faz backfill — ver "Normalização de `document_type`".)

| Tabela | Propósito |
|---|---|
| `email_control` | Dedup/controle. `status` ∈ (`extraído`, `recebido`, `pendente`, `falha`, `ignorado`, `duplicidade`) — **migrations 022/031**. `extraído`=PDF extraído (CSV gerado); `recebido`=sem PDF, conta via corpo; `pendente`=PDF salvo sem CSV (substitui `baixado`); `falha`=casou keyword mas sem PDF e sem conta no corpo; `ignorado`=não-financeiro (sem keyword) **ou NF-e pura sem conta a pagar** (`subject_is_pure_nfe`); `duplicidade`=pagável do corpo duplica conta já registrada por outro e-mail (**migration 031**; card/filtro próprios em `/emails`). O status é calculado em `process_message` pelo resultado real (conta/CSV/corpo/duplicata), não por `pdf_extracted`. **Visibilidade por REMETENTE (migration 078):** a policy SELECT (`authenticated`) filtra por `lower(sender_email)=lower(auth.email())` quando o grupo do usuário tem `sees_only_own_accounts` (Comercial) — `/emails` mostra só os e-mails de que o usuário é remetente; demais grupos veem tudo; `service_role` com bypass |
| `financial_account_control` | Tabela principal de contas a pagar — uma linha por documento; alimentada pelo pipeline de e-mail **e** por CRUD manual (baixas, consolidações, dashboards). Substitui a antiga `financial_emails` (dropada na migration 020). O fornecedor é referenciado **só pela FK `sk_supplier`** (surrogate key snowflake, NOT NULL — **migration 042**, antes era `supplier_id`) — nome/CNPJ vêm do JOIN com `supplier` (colunas denormalizadas dropadas na **migration 041**). Tem `sender_email` (migration 023; backfill em 025) usado na resolução p/ alinhar `supplier.email`, e `subject` (migration 025) — exibidos/buscados em `/consulta`. **Classificação contábil** (migrations 047/048): `cost_center_id`/`chart_account_id` SMALLINT, NOT NULL DEFAULT 0 (FKs para os cadastros; id 0 = "não informado") — preenchidos no CRUD manual (cascata centro→plano). **Autoria** (migrations 076/077): `created_by` (DONO — base da visibilidade por dono), `updated_by`, `status_changed_by`, `status_changed_at` — UUID → `auth.users`, NOT NULL DEFAULT sentinela `teste@otimotex.com.br`, carimbados pelo servidor/trigger `trg_fac_authorship` (ver "Visibilidade de contas por dono" / "Auditoria de autor") |
| `financial_cost_center` / `financial_chart_of_account` | **Cadastros de classificação contábil** (pré-existentes, **preservados em limpezas**) usados como lookup no modal de contas. `financial_cost_center` é **gerenciado pelo CRUD de centros de custo** (`/tabelas/centros-de-custo` — PK `cost_center_id` SMALLINT IDENTITY ALWAYS; id 0 = sentinela "não informado", fora do CRUD; ver "CRUD de centros de custo"). `financial_chart_of_account` (também gerenciado pelo **CRUD de Plano de contas** — `/tabelas/plano-de-contas`) tem `cost_center_id` (relaciona o plano ao centro — base da CASCATA), `chart_account_subgroup_id` (FK → subgrupo) e `is_postable` (só os postáveis são lançáveis). Os cadastros `financial_bank`, `financial_account`, `financial_chart_of_account_group` e `financial_chart_of_account_subgroup` também ganharam CRUD próprio (grupo Tabelas — ver "CRUDs dos demais cadastros contábeis"). Lidos via `lib/lookups.ts` (service_role) **e** pelo frontend via embed REST (papel `authenticated`); RLS habilitado com policy de SELECT `TO authenticated` (migration 049 — sem ela o embed voltava null e a UI mostrava `#id`) |
| `email_processing_errors` | Log de falhas com `raw_payload` JSON. **Visibilidade por REMETENTE (migration 078):** policy SELECT (`authenticated`) filtra por `lower(sender_email)=lower(auth.email())` para grupo com `sees_only_own_accounts` (Comercial) — `/erros` mostra só os erros de que o usuário é remetente; demais veem tudo; `service_role` com bypass |
| `financial_account_attachment` | **Anexos (N) de uma conta** (migration 079) — PADRÃO ÚNICO das duas origens: `origin='pipeline'` (documento do e-mail; espelha `financial_account_control.source_file`, gravado pelo reader) e `origin='manual'` (upload do usuário no cadastro/edição). `storage_key` = chave CRUA do objeto no bucket `attachments` (pipeline: nome flat; manual: `manual/{conta}/…`). **Soft delete** (`deleted_at`/`deleted_by`) — o objeto FICA no bucket; anexo `pipeline` é irremovível (auditoria → 403). UNIQUE `(account_id, storage_key)`; **não** UNIQUE global (um PDF com N boletos gera N contas que COMPARTILHAM o objeto). RLS SELECT herda a visibilidade da conta pai (076) via `EXISTS`; escrita só `service_role`. Ver "Anexos de conta" |
| `supplier` | Fornecedores. PK = `sk_supplier` (surrogate key snowflake auto-incremental — **migration 042**); `supplier_id` é **chave de negócio** (NOT NULL UNIQUE, só nesta tabela; = `sk_supplier` nos fornecedores criados pela extração, via trigger de espelho `trg_supplier_mirror_id`, podendo divergir em cargas externas). Auto-criados pelo trigger de resolução, mas **cadastro PRESERVADO** (curadoria manual de `email`/`email2`/`email3`/`email4`) — **nunca truncar** em limpezas (ver "Limpeza / reset de dados"). Reconhecimento por **e-mail** em `email`/`email2`/`email3`/`email4` (migrations 023/027/028) — ver "Auto-resolução de fornecedor". **Soft delete** via `deleted_at` (migration 045) — a baixa pelo CRUD da Next API marca `deleted_at` (nunca hard delete) e é bloqueada quando há contas vinculadas; ver "CRUD de fornecedores (Next API)". **Classificação default** `cost_center_id`/`chart_account_id` (SMALLINT NOT NULL DEFAULT 0 + FKs — migration 052): semeia o lançamento de novas contas e é atualizada pelo write-back do modal; ver "Classificação default do fornecedor — sync bidirecional". **Contatos** (migration 082): `phone_ddd1`/`phone1`/`phone_ddd2`/`phone2` (char(2)/varchar(9)), `whatsapp1`/`whatsapp2` (varchar(11)), `pix_key1`/`pix_key2` (varchar(77)) — 2 slots por tipo, preenchidos pelo form e pela extração (write-back com lógica de 2 slots); ver "Contato do fornecedor" |
| `company` | Empresa pagadora (**cadastro**, tem campo `email`). PK = **`sk_company`** (surrogate key snowflake `GENERATED ALWAYS AS IDENTITY` — migration 083, chave única de relacionamento); `company_id` é **campo de origem** (NOT NULL UNIQUE, do sistema maior). Hoje há DUAS: OTIMOTEX (sk 1) e LEBIANCO (sk 2). A empresa da conta (`financial_account_control.sk_company`) tem DUAS origens, ambas explícitas: a **regra LEBIANCO** no pipeline e o **select "Empresa" do `ContaForm`** no CRUD manual (default OTIMOTEX) — ver "Empresa pagadora (`sk_company`) — regra LEBIANCO". O trigger `trg_fe_resolve_company()` → **`resolve_company_sk`** (`payer_cnpj`/`payer_name`) ficou como **fallback residual** (migration 084): só atuaria num INSERT que omitisse `sk_company`. O lookup do select é `GET /api/companies` (`companyService`). **Preservada em limpezas** (ver abaixo) |
| `status` | **Dimensão** de situação (`status_id`, `status_name`, `status_short_name`, `has_opened`/`has_closed`/`has_invoiced`). 10 linhas (ids 1..10) = **domínio de `financial_account_control.status_id`** (fonte única — a coluna `status` texto foi removida na 069) + alvo da FK `fk_fac_status`. O nome de exibição da conta vem do embed `status_dim:status(...)`. **Cadastro/configuração — preservar em limpezas** |
| `user_group` | **Catálogo de grupos de usuário** (migration 063 — fundação de permissões por grupo). `group_id` IDENTITY ALWAYS PK, `group_name` VARCHAR(30) DEFAULT ''; **id 0 = sentinela "não informado"**. RLS read `authenticated`/write `service_role`. **Editado SÓ via Supabase** (sem CRUD no app); o usuário pretende acrescentar campos. A atribuição por usuário e o RBAC completo (`user_profile`/`permission`/`group_*`) estão **desenhados, não implementados** — ver "Grupos de usuário" na seção de papéis e `docs/design/permissoes-por-grupo.md`. **Cadastro/configuração — preservar em limpezas** |
| `cobranca_envios_log` | Cobranças de vencidos **enviadas com sucesso** (migration 037). `document_id` (= TÍTULO no Firebird) **UNIQUE** = chave de deduplicação: `already_sent()` consulta aqui antes de enviar. Exibida em `/cobranca/envios`. Alvo de limpeza (dados de teste) |
| `cobranca_erros_log` | **Falhas** da cobrança (migration 037), **sem UNIQUE** (reprocessável — o mesmo título pode falhar em execuções distintas). `error_type` ∈ (`email_ausente`, `email_invalido`, `smtp_falha`, `smtp_bloqueio`, `supabase_falha`, `firebird_falha`, `erro_inesperado`); `error_message` = motivo em linguagem leiga (exibido em `/cobranca/erros`), `error_detail` = traceback técnico. Alvo de limpeza |

**Características físicas de `supplier`** (tabela pré-existente, **não criada por migration**;
introspecção em 2026-06-23): colunas `sk_supplier` (PK, bigint), `supplier_id` (bigint, chave de
negócio), `cnpj CHAR(14)`, `cpf CHAR(11)`, `legal_name`, `trade_name`, `email`/`email2`/`email3`/
`email4`. CHECK `chk_supplier_has_identifier` (ao menos um de cnpj/cpf/legal_name/trade_name).
Índices GIN trigram nos 4 e-mails (migration 029); RLS `authenticated_select_supplier`.
- **Estado original (pré-042):** `supplier_id` era **`GENERATED ALWAYS AS IDENTITY`**
  (`pg_attribute.attidentity = 'a'`), backed por `supplier_supplier_id_seq`; PK `supplier_pkey`.
- **Pós-042:** a `042` faz `DROP IDENTITY` em `supplier_id` (remove a `supplier_supplier_id_seq`
  junto) e cria uma **sequence nova** `supplier_sk_supplier_seq` (semeada em `max(sk_supplier)+1`)
  como `DEFAULT` de `sk_supplier`; a PK `supplier_pkey` passa a ser `(sk_supplier)`; `supplier_id`
  vira `NOT NULL UNIQUE` (`uq_supplier_supplier_id`), gravado pelo trigger de espelho
  `trg_supplier_mirror_id` quando o INSERT não o informa.

> **`status_id` é a FONTE ÚNICA da situação — a coluna `status` (texto) foi REMOVIDA (migração
> faseada concluída, FASE 1→3).** A situação de `financial_account_control` é lida/escrita SÓ por
> `status_id` (FK → dimensão `status`); o NOME de exibição vem do embed
> `status_dim:status(status_name,status_short_name)`. Constantes `STATUS_IDS`/`STATUS_ID_*`/
> `STATUS_NAME_BY_ID` em `@sheild/shared` (id 1..10 = a ordem da dimensão).
> **FASE 1 (migration 067):** `status_id` `NOT NULL DEFAULT 3` ('a vencer'); leitura/filtro/ordenação/
> KPI por `status_id` + embed. **FASE 2 (migration 068):** trigger `fn_set_status_from_due_date`
> **id-primária** (recalcula 3/2 por vencimento quando aberto — ids 1/2/3) + `GRANT UPDATE(status_id)
> TO authenticated`; escrita por `status_id` — frontend (`setFinancialAccountStatus`/bulk +
> `StatusSelectCell` por id), Next API (update aceita `status_id`) e Python
> (`register_financial._apply_status_id` traduz o texto interno → `status_id` num único ponto na
> gravação; `'pendente'`→omite/DEFAULT 3, `'falha'`→10; `extract_pdf.py` intocado — ainda rotula por
> texto internamente, traduzido no register). **FASE 3 (migration 069):** trigger simplificada (só id),
> CHECK e coluna `status` texto **DROPADOS**, `status`/`accountStatusSchema` removidos do shared schema.
> **Ordenação da coluna Situação** = `order=status_dim(status_name)` (nome, alfabético — decisão de
> negócio; id ≠ ordem).

**`financial_account_control.status_id`** (`SMALLINT NOT NULL DEFAULT 3`, FK `fk_fac_status` →
`status.status_id`) é a **coluna ÚNICA de situação/ciclo de vida** — a antiga coluna `status`
(texto) foi **REMOVIDA** (migration **069**; ver a nota da migração faseada acima). Domínio = a
dimensão `status` (ids 1..10): `1 pendente · 2 vencido · 3 a vencer · 4 prorrogado · 5 baixado ·
6 protestado · 7 cartório · 8 pago · 9 cancelado · 10 falha`. O **nome de exibição** vem do embed
`status_dim:status(status_name,status_short_name)` (não há mais coluna de texto na linha). A trigger
**`fn_set_status_from_due_date`** (`trg_fe_status_vencimento`, BEFORE INSERT/UPDATE — id-primária
desde a 068, simplificada só-id na 069) grava `status_id` **3 (a vencer) / 2 (vencido)** a partir de
`due_date` × `extracted_at` **apenas quando EM ABERTO** (`status_id IN (1,2,3)`) — preserva os
estados fechados (`falha`/`pago`/`baixado`/`cancelado`/`protestado`/`cartório`/`prorrogado`).
Histórico: a **034** fundiu o antigo `due_status` na coluna `status` (texto); a **035** alinhou o
domínio à dimensão `status`; as **067/068/069** migraram a fonte de verdade para `status_id` e
dropraram o texto. `payment_method` aceita `boleto, pix, ted, cartão, depósito, duplicata,
bancário, carteira, vale, crédito, débito, débito automático, dinheiro, transferência, cheque,
outro` (`débito automático` = débito direto em conta, distinto do `débito` cartão — migration 071;
CHECK por valor EXATO, sem `lower()`); `extraction_source` ∈ (`email_body, pdf_text, pdf_vision,
image_vision, falha`).

**Schemas Zod (`packages/shared`) = fonte única de tipos.** **Zod 4** (upgrade Fase 5):
e-mail usa a API top-level `z.email('…')` (não mais `z.string().email()`); demais APIs
(`z.enum`, `.refine`, `z.coerce.number`, `.default`, `.safeParse`, `error.issues`)
inalteradas. O `zodResolver` vem do `@hookform/resolvers@5` (Standard Schema, compatível
com Zod 4). Os tipos TS são `z.infer` dos
schemas (não há tipo escrito à mão para divergir); os `z.enum` espelham 1:1 os CHECK do
banco — ao alterar um CHECK, **atualizar o enum correspondente**. **Situação:** o schema tem
`status_id` (`z.number().int()`, fonte única — não há mais campo `status` texto nem
`accountStatusSchema`) + o embed de leitura `status_dim` (`status_name`/`status_short_name`). Os
NOMES da situação seguem em `ACCOUNT_STATUSES`/`AccountStatus` (labels) e o mapa id↔nome em
`STATUS_IDS`/`STATUS_NAME_BY_ID` (+ `STATUS_ID_PAGO`/`_CANCELADO`/`_A_VENCER`/`_VENCIDO`), todos em
`@sheild/shared`. `financialAccountControlInputSchema` **inclui `status_id`** (entrada de escrita da
situação — baixa/cancelamento via PATCH) e omite `status_dim` (leitura); `...CreateSchema` omite
`status_id` (a conta nasce no DEFAULT 3 do banco + trigger por vencimento). A trigger grava
`'a vencer'/'vencido'` (ids 3/2); baixas/CRUD manual definem os demais (`pago`/`baixado`/`cancelado`/…).
O frontend consome os schemas de dados (`FinancialAccountControl`, `EmailControl`,
`ProcessingError`) **apenas como `import type`** (sem `.parse()` em runtime — `services/supabase.ts`
faz cast); só os schemas de **auth** rodam em runtime via `zodResolver`.

**Autoria no schema (migrations 076/077):** `financialAccountControlSchema` (leitura) tem
`created_by`/`updated_by`/`status_changed_by`/`status_changed_at` (`z.string().nullable()`) — todos
**OMITIDOS** dos schemas de input/create/update/manualEdit (são carimbados pelo servidor/trigger,
nunca pelo cliente). Consumidos só na exibição do autor no detalhe de `/consulta`.

**Fornecedor no schema (migrations 040/041/042):** `financialAccountControlSchema` **não** tem mais
`supplier_name`/`supplier_cnpj`/`supplier_cpf` — só `sk_supplier` (`z.number().int()`, NOT NULL — a
FK surrogate; `supplier_id` ficou só na tabela `supplier`) e um recurso embutido opcional `supplier`
(`supplierEmbeddedSchema`: `trade_name`/`legal_name`/`cnpj`/`cpf`), presente quando o select inclui
`supplier(...)`. O `financialAccountControlInputSchema` **inclui `sk_supplier`** (entrada obrigatória
— o pipeline resolve via RPC, que devolve o surrogate, antes de gravar) e omite o recurso `supplier`
(leitura).

**Classificação contábil no schema (migrations 047/048):** `financialAccountControlSchema` tem
`cost_center_id`/`chart_account_id` (`z.number().int().default(0)` — NOT NULL DEFAULT 0 no banco) +
embeds opcionais de leitura `cost_center` (`cost_center_code`/`cost_center_description`) e
`chart_account` (`account_code`/`account_description`), presentes quando o select usa os aliases
`cost_center:financial_cost_center(...)` / `chart_account:financial_chart_of_account(...)`. Schemas
`costCenterSchema`/`chartAccountSchema` em `@sheild/shared`. No input/create/update os embeds são
omitidos; os ids entram como opcionais (a UI envia `0` quando não informado).

**Classificação default no schema do supplier (migration 052):** `supplierSchema` (leitura) também
expõe `cost_center_id`/`chart_account_id` (`z.number().int().default(0)`) + embeds opcionais
`cost_center`/`chart_account` (reutiliza `costCenterEmbeddedSchema`/`chartAccountEmbeddedSchema` de
`financial-account-control.schema`). **Entram** em `editableFields` (logo em
`supplierCreateSchema`/`supplierUpdateSchema`) como `z.number().int().min(0).optional()` — editáveis
pelo CRUD de fornecedores (`/fornecedores`); ver "Classificação default do fornecedor — sync
bidirecional". O write-back do modal de contas (`setSupplierClassification`) **permanece** como
caminho paralelo de gravação.

**Anexos no schema (migration 079):** `financial-account-attachment.schema.ts` traz o domínio
(`ATTACHMENT_MIME_TYPES` — espelha `_UPLOAD_CONTENT_TYPES` do reader; `ATTACHMENT_MIME_TO_EXT`;
`ATTACHMENT_ORIGINS`; `ATTACHMENT_MAX_BYTES` = 10 MB) + `financialAccountAttachmentSchema` (leitura)
e as duas entradas do upload em 2 passos: `attachmentUploadRequestSchema` (`file_name`/`mime_type`/
`size_bytes` — o que o cliente DECLARA, só um pré-filtro) e `attachmentRegisterSchema` (+
`storage_key`). `financialAccountControlSchema` ganhou o embed de leitura
`attachments: z.array(...).optional()`, presente quando o select usa o alias
`attachments:financial_account_attachment(...)`; ele entra no `.omit()` do
`financialAccountControlInputSchema` (junto de `supplier`/`cost_center`/`chart_account`/`status_dim`)
— **anexo NUNCA é gravável pelo corpo da conta**, só pelas rotas dedicadas, o que mantém a regra
**S3-2** intacta.

**Schema base vs. criação manual:** `amount` é `nullable` no schema base (o pipeline pode
gravar sem valor → vira erro `sem_valor`, não cria conta). A criação manual via `POST /api/contas`
usa `financialAccountControlCreateSchema` e a edição via `PATCH` usa
`financialAccountControlUpdateSchema`, **ambos derivados de `financialAccountControlManualEditSchema`**
(S3-2, auditoria de segurança — não regredir): um **`.pick()`** SÓ dos campos do formulário
(`sk_supplier`, **`sk_company`**, `cost_center_id`, `chart_account_id`, `invoice_number`, `issue_date`,
`due_date`, `amount`, `document_type`, `payment_method`, `barcode`, `description`, `additional_info`,
`status_id`). **`sk_company` é um CARVE-OUT consciente da S3-2** (a empresa pagadora é escolha do
usuário no `ContaForm` — antes era só derivada): as demais colunas de pagador (`payer_cnpj`/
`payer_name`) e todas as de pipeline/auditoria **continuam fora**, e há teste travando isso. O trigger
da 084 respeita o valor explícito, então **nenhuma migration foi necessária** (a premissa documentada
na 084 — "o CRUD manual não grava sk_company" — deixou de valer). Como `sk_company` chega do schema de
leitura como `nullable`, o pick faz `.extend({ sk_company: z.number().int().positive() })`: um `null`
não daria erro — o trigger o resolveria **em silêncio** para OTIMOTEX, ignorando a intenção do cliente;
com o override vira **422**. Ele **não tem `.default()`**, então omiti-lo num PATCH preserva a empresa
atual (mesma garantia do `status_id`).
**`has_invoice`/`has_bank_slip` FICAM FORA do pick de propósito (não regredir):** elas têm
`.default(false)` no inputSchema e o **`.partial()` do Zod NÃO remove o default** — se estivessem no
pick, omiti-las no PATCH (o `ContaForm` não as edita) faria o parse injetar `false` e o UPDATE
**APAGARIA a curadoria NF/Boleto** (bug real: "Editar conta" zerava NF/BOL). A curadoria é feita
**exclusivamente** pela rota inline de `/consulta` (`setFinancialAccountFlag`, REST direto com grants
por coluna — migration 033), nunca pela Next API; fora do pick, o Zod as descarta (strip), então o
manual CRUD **não pode** tocar NF/Boleto por construção (create → DEFAULT FALSE do banco; update →
não mexe). `status_id` **entra** no pick e é seguro porque **não tem default Zod** (não é injetado). As
colunas de **PIPELINE/AUDITORIA** (`gmail_message_id`,
`source_file`, `extraction_source`, `extracted_at`, `processing_notes`, `email_body_excerpt`,
`sender_email`, `subject`, `payer_cnpj`/`payer_name`, `nosso_numero`, componentes de boleto) **NÃO são
graváveis** por POST/PATCH manual — o Zod (strip) as descarta; protege a trilha de auditoria/dedup. O
pipeline Python grava a tabela inteira via `service_role`, fora destes schemas. O create ainda **exige
`amount` > 0** e **omite `status_id`** (a conta nasce no DEFAULT 3 do banco; o cliente não cria conta
já em estado fechado). Não relaxar o `.positive()`, não reintroduzir campos de pipeline no
`.pick()`, nem trocar a base por `InputSchema` cru. Testes em `lib/contas.test.ts` travam o strip no
create e no PATCH.

RLS habilitado em todas as tabelas. Policies de leitura são `TO authenticated`
(migrations 015/018/019); escrita em `financial_account_control` é `TO service_role`
(CRUD via Next API). Toda nova tabela deve seguir o mesmo padrão. **Exceção — leitura por DONO
(migration 076):** a policy SELECT de `financial_account_control` deixou de ser `USING (true)` e
passou a `USING (NOT public.auth_group_sees_only_own() OR created_by = auth.uid())` — grupo com a
flag `sees_only_own_accounts` (Comercial) vê só as próprias; demais veem tudo. As colunas de autoria
`created_by`/`updated_by`/`status_changed_by`/`status_changed_at` (migrations 076/077) são carimbadas
pelo servidor/trigger `trg_fac_authorship`, nunca pelo cliente — ver "Visibilidade de contas por
dono" e "Auditoria de autor". **Exceção — leitura por REMETENTE em `/emails` e `/erros`
(migration 078):** as policies SELECT de `email_control` e `email_processing_errors` também deixaram
de ser `USING (true)` e passaram a `USING (NOT public.auth_group_sees_only_own() OR
lower(sender_email) = lower(auth.email()))` — a MESMA flag/helper da 076, mas casando o **remetente**
(`sender_email`) com o e-mail do usuário logado (`auth.email()`), não o `created_by`/UUID. Grupo
restrito (Comercial) vê só os e-mails/erros de que é remetente; demais veem tudo; `service_role`
mantém bypass. Linha com `sender_email` NULL fica oculta ao usuário restrito. **Exceção pontual
(migration 030):** `email_control` tem policy de UPDATE `TO authenticated`, mas com
**grant restrito à coluna** `reviewed_at` (`GRANT UPDATE (reviewed_at)`) — o frontend só
consegue marcar "revisado", não alterar outras colunas. `reviewed_at` é setado em `/emails`
ao abrir o card de detalhes de um e-mail com `status='falha'` (`markEmailReviewed`), exibindo
um check verde ao lado do badge de status (compartilhado entre usuários). **Exceção análoga
(migration 033):** `financial_account_control` tem policy de UPDATE `TO authenticated` com
**grant restrito às colunas** `has_invoice`/`has_bank_slip` (`GRANT UPDATE (has_invoice,
has_bank_slip)`) — flags de curadoria "Tem NF ?"/"Tem Boleto" editadas como checkbox
(`CheckToggle`) no grid de `/consulta` via `setFinancialAccountFlag` (update otimista).
**São DUAS travas independentes, não uma (migration 081 — não confundir):** o GRANT por coluna diz
QUAIS COLUNAS podem ser escritas; o predicado da policy diz QUAIS LINHAS. As duas policies de UPDATE
eram `USING (true)` (= qualquer linha) e passaram a usar o MESMO predicado do SELECT (076/078), de
modo que o usuário só edita o que a tela lhe mostra. Ao mexer em grant aqui, **nunca** faça `REVOKE
UPDATE` nessas duas tabelas: derruba os grants por coluna e quebra a curadoria inline — a 081 revoga
só `INSERT, DELETE` (ver "Escrita direta por `authenticated`").
**Baixa automática no ATO da edição (não regredir):** ao marcar a 2ª flag (NF ou BOL) de
uma conta com **vencimento <= hoje** e **situação em aberto** (`status_id ∈ {1,2,3}`), o
`handleToggleFlag` de `Consulta.tsx` dispara também `setFinancialAccountStatus(id,
STATUS_ID_PAGO)` — best-effort (falha aqui não reverte a flag já salva; o batch diário
reconcilia o que escapar). A regra vive em `qualifiesForAutoPago` (helper de módulo em
`Consulta.tsx`) e **espelha** o batch Python `baixa-automatica` (6h). Preserva situações
fechadas (cancelado/baixado/protestado/cartório/prorrogado/já pago) e **não** reverte ao
desmarcar. Ver "Pipeline de baixa automática (skill `baixa-automatica`)". **Terceira
coluna gravável pelo `authenticated` (migration 068):** `status_id` (`GRANT UPDATE (status_id)`) —
a troca de **situação** em `/consulta` (`StatusSelectCell` inline + ação em lote) grava por
`status_id`; a trigger `fn_set_status_from_due_date` (SECURITY DEFINER) faz o resto. O grant antigo
de `status` (texto, migration 036) sumiu com a coluna (069). O frontend só altera essas três
colunas (`has_invoice`/`has_bank_slip`/`status_id`); o pipeline (`service_role`) escreve a tabela inteira.

### Limpeza / reset de dados (SEMPRE preservar os cadastros)

Ao limpar a base para uma nova busca geral, **SEMPRE preserve estas tabelas de
cadastro/configuração** — não são alimentadas pelo pipeline e nunca devem ser apagadas:

- `company`
- `status` (dimensão de situação — domínio de `status` + alvo da FK `status_id`)
- `supplier` (cadastro com curadoria manual — nome/CNPJ/CPF + `email`/`email2`/`email3`/`email4` são a **fonte da busca por fornecedor em `/consulta`**, que resolve `sk_supplier` na tabela `supplier` via `findSupplierIdsByTerm`; truncá-lo destruiria os e-mails cadastrados à mão **e** quebraria a exibição/busca, já que `financial_account_control` só guarda a FK `sk_supplier`. **Atenção:** truncar `supplier` com `RESTART IDENTITY` zeraria a sequence de `sk_supplier` e desalinharia das contas — mais um motivo para nunca truncá-lo)
- `financial_account`
- `financial_bank`
- `financial_chart_of_account`
- `financial_chart_of_account_group`
- `financial_chart_of_account_subgroup`
- `financial_cost_center`
- `user_group` (catálogo de grupos de usuário — migration 063; id 0 = sentinela "não informado". A atribuição por usuário vive no claim `app_metadata.group_id`, não aqui. Truncar destruiria as definições de grupo/permissão)

**Alvos da limpeza** (truncar com `RESTART IDENTITY CASCADE`): `email_control`,
`financial_account_control`, `email_processing_errors`, `audit_log` — e, para os testes da
cobrança de vencidos, `cobranca_envios_log` + `cobranca_erros_log` — mais o
bucket **`attachments`** do Storage e o cache local (`data/pdfs_inbox`, `data/csv_output`).
`financial_account_attachment` **não precisa entrar na lista**: a FK
`account_id → financial_account_control(id)` é `ON DELETE CASCADE`, então o `TRUNCATE … CASCADE`
da tabela de contas já a esvazia junto (é dado do pipeline, não cadastro — pode ir).
`supplier` **não** é mais alvo: embora seja auto-criado pelo trigger, acumula curadoria
manual (e-mails `email2`/`email3`/`email4`) que seria perdida na truncagem; no
reprocessamento o `resolve_supplier_id` reutiliza os fornecedores existentes (casa por
CNPJ/CPF/e-mail/nome) sem duplicar. A `company` e o `supplier` preservados continuam
resolvendo `sk_company`/`sk_supplier` das novas contas.

> **Storage:** `DELETE` por `authenticated` em objetos do bucket `attachments` é bloqueado
> pela policy RESTRICTIVE `attachments_no_delete_authenticated` (migration 073 — S2-2; antes
> só o default-deny da RLS protegia, sem policy explícita). Esvaziar o bucket via **Storage
> API** com `SUPABASE_SERVICE_KEY` (o `service_role` ignora RLS): `POST object/list/attachments`
> → `DELETE object/attachments` com `{prefixes:[…]}`, do `.env` da raiz.

## Pipeline de cobrança de vencidos (skill `cobranca-vencidos`)

Segundo pipeline do projeto — **saída** (envio), paralelo ao de entrada (leitura de e-mails).
Lê títulos vencidos no **Firebird**, monta um e-mail HTML e **envia por SMTP (Locaweb)**,
registrando sucesso/falha no Supabase. Roda por `py -3` (Task Scheduler), **independente** do
Flask/Next.

```
Firebird (VW_PSQ_FIN_REC_BAN + _004)  →  run.py  →  SMTP transacional Locaweb (smtplw.com.br)
   títulos vencidos (STFI='VENCIDO',          │         To: cliente · Cc: representante
   DTVC >= hoje-7)                            │
                                              ├─ dedup: already_sent() consulta cobranca_envios_log (UNIQUE document_id)
                                              ├─ sucesso → cobranca_envios_log  (+ limpa erros antigos do título)
                                              ├─ falha   → cobranca_erros_log   →  UI /cobranca/erros
                                              └─ ao fim: resumo por CC das falhas DEFINITIVAS (failure_notify)
```

**Scripts** (`skills/cobranca-vencidos/scripts/`, importados como **módulos irmãos** via
`sys.path` no próprio dir — a pasta tem hífen, inválido como pacote Python; mesmo padrão de
`server/app.py` com `read_emails`):

| Arquivo | Papel |
|---|---|
| `run.py` | Entry-point do **batch diário** (`py -3 run.py [--dry-run]`). Lê o Firebird, abre **uma `SmtpSession` por lote** e, por título, chama `send_core.send_and_log` (passando a sessão). Loop com **rede de segurança** (`_process_titulo_safe`): falha de um e-mail **nunca** trava os demais. Throttle entre envios (`COBRANCA_SEND_DELAY_SECONDS`, default 10s). **Limpa erros resolvidos:** ao enviar com sucesso (ou pular um título já enviado) que **antes tinha erro** (`fetch_error_document_ids` no início → `delete_erro_rows_by_document_id`), remove as linhas antigas dele de `cobranca_erros_log` — assim um `email_ausente` corrigido no Firebird volta ao fluxo no dia seguinte e a falha some sozinha (best-effort; vale dentro da janela `DTVC >= hoje-7`) |
| `send_core.py` | **Núcleo compartilhado** por `run.py` (batch) e `resend.py` (reenvio manual): `validate_email`, `classify_smtp_error` e `send_and_log` (render→envia→loga; sucesso→`cobranca_envios_log`, falha→`cobranca_erros_log`; **nunca propaga exceção SMTP**). Centraliza a lógica num só lugar — não duplicar entre os fluxos |
| `resend.py` | **Reenvio manual** de falhas a partir de `/cobranca/erros` (`resend_erros(ids, on_progress)`). Ver subseção "Reenvio manual" abaixo |
| `db_firebird.py` | Conexão Firebird (driver **`fdb`**, fixado em `server/requirements.txt`) + `_QUERY` (UNION das views `VW_PSQ_FIN_REC_BAN` e `_004`). Linha **sem e-mail SEGUE** o fluxo (vira `email_ausente`); só descarta linha sem `document_id` |
| `email_sender.py` | Monta e envia. **To primeiro; se o principal falhar, o Cc NÃO é enviado** (2 `sendmail` na mesma conexão). **`SmtpSession`**: conexão **reaproveitada no lote** (lazy no 1º envio; reconecta+reenvia 1× se cair). `send_cobranca` (avulso) é wrapper de compat. **Atenção:** `smtplib.SMTPException` herda de `OSError` — o catch de queda usa `(SMTPServerDisconnected, ConnectionError, TimeoutError)`, **nunca** `OSError`, para não reenviar recusa definitiva (451/5xx/auth). **Segurança §4 A-2/A-3 (não regredir):** Subject é normalizado (`_strip_crlf`) e o Cc com quebra de linha é DESCARTADO (`_safe_address`) antes do header E do envelope `sendmail` — barra header injection (CRLF) a partir de dados do Firebird |
| `supabase_log.py` | `already_sent` (dedup), `log_envio_sucesso`, `log_envio_erro`, `fetch_company_smtp`, `fetch_erro_rows` (linhas de erro para o reenvio), `delete_erro_rows`/`delete_erro_rows_by_document_id`/`fetch_error_document_ids` (limpeza de resolvidos) |
| `template.py` | HTML do e-mail de cobrança (`render_html`). **Segurança §4 A-1 (não regredir):** `customer_name`/`document_id` (do Firebird) passam por `html.escape` antes de entrar no HTML — barra HTML/script injection no e-mail do cliente. Testes em `tests/test_email_security.py` |
| `failure_notify.py` | **Notificação ao representante (CC)** das falhas **definitivas** (`DEFINITIVE_ERROR_TYPES` = email_ausente/email_invalido/smtp_bloqueio): `group_by_cc` (resumo por CC, ignora falha sem CC) + `render_failure_digest` (HTML com cliente/título/vencimento/valor/motivo) + `build_subject`. Só no batch (`run.py`) |

**SMTP (não óbvio — não regredir):** remetente (`From`) = `company.email` (`sk_company=1` =
`financeiro@otimotex.com.br`). **Desde 2026-06-25 o envio usa o SMTP transacional da Locaweb**
(`smtplw.com.br`, produto de alto volume — credencial/token PRÓPRIA do painel, **não** a senha
do mailbox): `.env` tem `SMTP_HOST=smtplw.com.br` · `SMTP_PORT=587` (STARTTLS) · `SMTP_USER=otimotex1`
(usuário do painel, não o e-mail) · `SMTP_PASSWORD=<token>`. `_load_smtp_config` dá **prioridade às
`SMTP_*` sobre as `IMAP_*`** — a virada foi **só `.env`**, sem mudança de código. O domínio
`otimotex.com.br` precisa estar autorizado no painel (Domínio de Remetente). **Fallback** (sem
`SMTP_*`): caminho legado pelo mailbox IMAP — host `IMAP_HOST` (**`email-ssl.com.br`** —
`smtp.locaweb.com.br` dá timeout nesta conta) + senha `IMAP_PASS`, porta 587 STARTTLS.
`fetch_company_smtp` só lê colunas existentes (`email,legal_name,trade_name`) — a tabela `company`
**não** tem colunas `smtp_*`. A conexão é **reaproveitada no lote** (`SmtpSession`) — não mais uma
conexão por e-mail — para aliviar a pressão sobre o relay (`451 queue file write error`).

**Classificação de falha (regra de negócio):** `smtp_falha` = **instabilidade** (timeout,
queda, 450/451/452) → o próximo run **retenta**; `smtp_bloqueio` = **negação** (auth 535, 421,
5xx, destinatário recusado) → exige **ação humana** (limite de envios / conta bloqueada na
Locaweb). `_classify_smtp_error` decide pelo código/exceção. Mensagens em `error_message` são
**leigas** (coluna "Motivo" da UI); o técnico vai em `error_detail`.

**Exit code do batch (`run.py` — tarefa verde/vermelha no Agendador, não regredir):** `main()`
**retorna** o exit code (não chama `sys.exit` no meio; `__main__` faz `sys.exit(main())`).
`compute_exit_code(error_types)` decide: erros de **DADO** do cliente (`DATA_ERROR_TYPES` =
email_ausente/email_invalido — cliente sem e-mail no Firebird) **NÃO** reprovam a tarefa (são
logados em `cobranca_erros_log` e notificados ao CC, mas o run cumpriu seu papel); só erros
**OPERACIONAIS** (smtp_falha/smtp_bloqueio/supabase_falha/erro_inesperado/firebird_falha) fazem
sair `!= 0` → o `run_cobranca.ps1` marca "CRASH / ERRO" + Event Log e o Agendador mostra `0x1`.
Antes, **qualquer** erro (`counts["error"] > 0`) saía 1, então um run 100% OK com clientes sem
e-mail aparecia como falha (`0x1`). O resumo separa: `erros=N (sem e-mail/inválido=X · operacionais=Y)`.
O loop do lote vive em `_run_batch` (uma `SmtpSession` por lote, sempre fechada no `finally`);
`_record_result` contabiliza counts/error_types/limpeza/falhas-definitivas. Testes:
`tests/test_run_exit_code.py` (+ `test_run_notify`/`test_run_cleanup` atualizados — `main()`
agora **retorna** o código, não levanta `SystemExit`).

**Notificação ao representante (CC) — só batch:** ao fim do `run.py`, as falhas **definitivas**
(`DEFINITIVE_ERROR_TYPES`: email_ausente/email_invalido/smtp_bloqueio — exigem ação humana) são
agrupadas por **CC** (representante do título, `CV_EMAIL` do Firebird) e cada CC recebe **um
resumo** (`failure_notify`) com cliente/título/vencimento/valor/motivo dos seus títulos que
falharam. Transitórias (`smtp_falha`/timeout) **não** notificam (re-tentam sozinhas). Falha sem
CC não tem para quem notificar (logada). `send_and_log` retorna **`SendResult`** (status +
error_type + motivo) para o `run.py` filtrar as definitivas sem reclassificar. Envio best-effort
(falha na notificação não derruba o run) e reusa a `SmtpSession` do lote (respeita DEV_MODE). O
reenvio manual (`resend.py`) **não** notifica (o usuário já vê os erros na tela).

**`.env` (raiz):** `FB_HOST/FB_PORT/FB_DATABASE/FB_USER/FB_PASSWORD/FB_CHARSET`;
**SMTP transacional Locaweb** (ATIVO desde 2026-06-25) — `SMTP_HOST=smtplw.com.br` ·
`SMTP_PORT=587` · `SMTP_USER=otimotex1` (usuário do PAINEL, não o e-mail) · `SMTP_PASSWORD=<token>`
(prioridade sobre `IMAP_*` em `_load_smtp_config`; sem o bloco, cai no fallback IMAP
`email-ssl.com.br`); `DEV_MODE=true` + `DEV_OVERRIDE_EMAIL` (To de teste) + `DEV_OVERRIDE_CC_EMAIL`
(Cc de teste); `COBRANCA_SEND_DELAY_SECONDS` (throttle anti-bloqueio Locaweb, default 10s, `0`
desliga). Em **DEV_MODE** todos os envios vão para as caixas de teste (To→`DEV_OVERRIDE_EMAIL`,
Cc→`DEV_OVERRIDE_CC_EMAIL`); em produção, To/Cc reais do Firebird. **Em produção desde 2026-06-22
(`DEV_MODE=false`): envia para os clientes reais (To/Cc do Firebird).** As variáveis
`DEV_OVERRIDE_*` ficam **comentadas** no `.env` (desativadas) — para um teste pontual, defina
`DEV_MODE=true` e descomente ambas. Spec completa: `skills/cobranca-vencidos/references/env_reference.md`.

**Entregabilidade (DNS, fora do código):** SPF ✅ (`include:_spf.locaweb.com.br`); DMARC ⚠️
`p=none`; **DKIM ❌ a configurar** no painel Locaweb (melhora caixa-de-entrada em Gmail/Outlook).
O envio **funciona** sem DKIM (SPF já autentica); é melhoria, não pré-requisito.

**Reenvio manual de falhas (tela `/cobranca/erros`):** o usuário **seleciona** linhas de erro
(1 ou em lote) e reenvia **sem depender do Firebird** — `resend.py` (`resend_erros(ids)`)
reconstrói o e-mail a partir dos campos **já gravados** em `cobranca_erros_log` (via
`fetch_erro_rows`) e reusa `send_core.send_and_log` (mesma dedup, throttle e classificação de
erro do batch). Teto `MAX_IDS=500`; throttle `COBRANCA_SEND_DELAY_SECONDS` (default **10s** no
reenvio — ver memória `cobranca-smtp-bottleneck`) só **entre envios reais** (não após skip/
no_email nem após o último). Status por título (consumido pela UI): `sent` (enviado agora) ·
`skipped` (já em `cobranca_envios_log` — dedup, **não** reenvia) · `no_email` (sem e-mail/
inválido → novo registro de erro) · `error` (falha SMTP → novo registro).

**Endpoints Flask (assíncronos, **um job por vez** — dict + lock em `server/app.py`):**
`GET /api/cobranca/resend/health` (prontidão: `resend_ready()` checa Supabase + SMTP/IMAP +
DEV_MODE/override → a UI **desabilita o botão** quando `ready=false`, com o motivo no `title`) ·
`POST /api/cobranca/resend/start` (dispara em **thread**, responde na hora) ·
`GET /api/cobranca/resend/progress` (poll do progresso).

**Guarda CSRF dos endpoints de DISPARO (segurança §4 M-1 — não regredir):** os POST que
disparam leitura (`/api/emails/read`, `/api/emails/read/start`) e reenvio
(`/api/cobranca/resend/start`) passam por `_reject_trigger_request` (`server/app.py`): exigem
`Content-Type: application/json` (→ `415` caso contrário, quebrando o CSRF "simples" do
navegador) e, se `FLASK_TRIGGER_TOKEN` estiver no `.env`, o header `X-Trigger-Token` (→ `401`).
O frontend e a ponte Next já enviam `application/json`. A barreira primária continua sendo o
bind em `127.0.0.1`; isto é defesa em profundidade para quando o Flask for exposto numa VM.
Teste: `tests/test_flask_csrf_guard.py`.

**Frontend:** rotas lazy `/cobranca/envios` e `/cobranca/erros` (`App.tsx`), páginas
`pages/cobranca/CobrancaEnvios.tsx` + `CobrancaErros.tsx` sobre o **`DataGrid` do projeto**
(colunas em `cobrancaColumns.ts` no `ColumnDef<T>` de `useGridColumns`, **não** o do TanStack),
serviço `services/cobrancaService.ts` (REST direto, paginado; + `startResend`/`getResendProgress`/
health do reenvio), tipos `types/cobranca.ts` (`ErrorType` + `ERROR_TYPE_LABEL` — **não** ficam
em `@sheild/shared`). O grid de `/cobranca/erros` liga **seleção** + a ação
`organisms/ResendErrosAction.tsx` (botão "Reenviar e-mails (N)" na barra de seleção;
**confirmação inline** antes de disparar — são e-mails reais; poll de progresso a cada 1,5s;
**desabilitado** quando o backend não está pronto). Sidebar: grupo **Envios**. **Ordenação
padrão de `/cobranca/envios`: `sent_at` desc** (data de envio, mais recentes no topo) — o ciclo
de clique no cabeçalho volta a esse padrão no 3º clique.

## Pipeline de backup do Supabase (skill `backup-supabase`)

Terceiro pipeline (infra) — **backup diário e automático do Supabase**, independente do
Flask/Next (mesmo padrão de `email-reader`/`cobranca-vencidos`). **Em produção desde
2026-07-03** (`C:\Sheild\API\Pagamentos`, tarefa "Pagamentos - Backup Supabase" na pasta
`\Sheild\` do Agendador, 02:00 diário; 1º backup real: 381 arquivos / ~52 MB, exit 0).

```
Windows Task Scheduler (02:00 diário)
        │
        ▼
scheduler/run_backup.ps1  ──►  skills/backup-supabase/scripts/run.py
        │
        ├── pg_dump (subprocess, native exe) ──► Supabase Postgres (SUPABASE_DB_URL)
        │       └── backups/<ts>/db/db_postgres_public.dump   (formato custom, pg_restore)
        │
        ├── Storage REST (urllib) ──► bucket attachments (SUPABASE_SERVICE_KEY)
        │       └── backups/<ts>/storage/attachments/<arquivos>
        │
        ├── backups/<ts>/manifest.json   (resumo: contagens, tamanhos, versões, status)
        └── retenção: remove backups/<ts> além de BACKUP_RETENTION_DAYS dias (padrão 30)
```

**Estrutura** (`skills/backup-supabase/`): `scripts/run.py` (entry-point/orquestrador —
Task Scheduler aponta aqui) + `config.py` (.env, caminhos, **detecção do `pg_dump`**) +
`backup_db.py` (`pg_dump`; senha via `PGPASSWORD`, **fora do argv/log**) + `backup_storage.py`
(list + download do bucket via `urllib`, item que falha é NÃO-fatal) + `retention.py` (remove
backups > N dias, só pastas com nome de carimbo `YYYY-MM-DD_HHMMSS`). Docs em `SKILL.md` +
`references/env_reference.md`. Wrappers `scheduler/run_backup.ps1` + `setup-backup-task.ps1`.

**Pontos NÃO óbvios (não regredir):**
- **`pg_dump` ≥ 17 é requisito externo** (servidor é PG 17). `config.find_pg_dump` procura
  `PG_DUMP_PATH` no `.env` → PATH → `C:\Program Files\PostgreSQL\*\bin\pg_dump.exe` → pgAdmin
  (`...\pgAdmin 4\runtime\pg_dump.exe`, **com e sem** subpasta de versão). Em dev veio do pgAdmin
  standalone (18.2); em produção, do **PostgreSQL 18 completo** (`...\PostgreSQL\18\bin\`).
- **`SUPABASE_DB_URL`** (novo no `.env`) = a **MESMA** connection string do pgAdmin (**Session
  pooler**, IPv4, porta **5432** — a 6543/Transaction NÃO funciona com `pg_dump`). Senha
  **URL-encoded** (`@`→`%40`, etc.); `backup_db._parse_db_url` faz `unquote`. `SUPABASE_URL`/
  `SUPABASE_SERVICE_KEY` (Storage) já existem. Sem dependência Python nova (stdlib + `dotenv`).
- **Backup é COMPLETO todo dia** (re-baixa todo o bucket) — não incremental. Disco ≈
  (dump + Storage) × retenção; baixar `BACKUP_RETENTION_DAYS` se o disco apertar.
- **Exit code**: 0 = OK; ≠ 0 = falha operacional (banco ou Storage) → `run_backup.ps1` marca a
  tarefa vermelha + Event Log (`Pagamentos-Backup`, EventId 1003). Os logs `INFO` do Python saem
  pelo **stderr** (padrão do `logging`), então aparecem sob `--- STDERR ---` no log do wrapper
  **mesmo em sucesso** — não é erro (igual reader/cobrança); o sinal de erro é o exit ≠ 0.
- **Restaurar**: `pg_restore --no-owner --no-privileges --clean --if-exists` do `.dump`; Storage =
  re-upload dos arquivos (o nome do arquivo é a chave do objeto no bucket).

Variáveis do `.env` em `references/env_reference.md`. Deploy em produção: ver "Deploy manual do
Backup do Supabase em produção".

## Pipeline de baixa automática (skill `baixa-automatica`)

Quarto pipeline (reconciliação) — marca como **`pago`** as contas a pagar já quitadas,
independente do Flask/Next (mesmo padrão de `email-reader`/`cobranca-vencidos`/`backup-supabase`).

**Regra de negócio (fonte única):** uma conta em `financial_account_control` vira `pago`
(`status_id = 8`) quando **todas** valem: `has_invoice = true` **e** `has_bank_slip = true`
**e** `due_date <= hoje` (data local) **e** `status_id ∈ {1,2,3}` (pendente/vencido/a vencer —
**em aberto**). Situações **fechadas** (cancelado/baixado/protestado/cartório/prorrogado/já
pago) são **preservadas** — nunca reabre nem sobrescreve. A regra **não** reverte (desmarcar
NF/BOL depois não desfaz o `pago`).

**Duas instâncias da MESMA regra:**
1. **No ato da edição (`/consulta`, frontend):** `qualifiesForAutoPago` +
   `handleToggleFlag` em `Consulta.tsx` — ao marcar a 2ª flag (NF/BOL) de uma conta vencida
   e em aberto, grava `status_id = 8` na hora (best-effort; ver "Baixa automática no ATO da
   edição" na seção de RLS/grants).
2. **Batch diário (esta skill):** cobre as contas cujo `due_date` "passa" com o tempo sem
   nenhuma edição disparar a baixa. Roda **1x/dia às 06:00** na máquina de produção
   (`scheduler/run_baixa.ps1`).

**Mecânica (`skills/baixa-automatica/scripts/run.py`):** um único
`PATCH /rest/v1/financial_account_control` filtrado (as 4 condições, `build_filter`) com
`{status_id: 8}`, escrita via **`SUPABASE_SERVICE_KEY`** (service_role ignora RLS). Setar 8
explicitamente é seguro — a trigger `fn_set_status_from_due_date` só recalcula quando
`status_id ∈ {1,2,3}`, então não sobrescreve o 8 (é o mesmo caminho da baixa manual pelo
`StatusSelectCell`). `--dry-run` faz um `GET` com `Prefer: count=exact` e só reporta o total,
sem gravar. **Sem dependência Python nova** — `urllib` (stdlib) + `python-dotenv`. Exit code
`0` = sucesso; `≠ 0` = falha → o wrapper marca a tarefa vermelha + Event Log. `.env`: reusa
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (já presentes para o reader). Teste:
`tests/test_baixa_automatica.py` (construtor do filtro + ids em aberto). **Isolamento do teste
(não regredir):** o teste carrega o `run.py` via `importlib` com nome de módulo ÚNICO
(`baixa_automatica_run`), **não** `import run` via `sys.path` — várias skills têm `run.py`
(`cobranca-vencidos`, `backup-supabase`), e importar o nome `run` colidiria em `sys.modules`,
poluindo a suíte (quebrava os testes da cobrança). **Nenhum passo de
banco** (colunas e grants já existem — migrations 033/068).

**Backfill inicial aplicado (2026-07-10):** a 1ª execução real do batch marcou **15 contas**
que já se enquadravam na regra (NF + Boleto + vencidas + em aberto) como `pago`; o `--dry-run`
seguinte reportou `0` (idempotente). Como dev e produção compartilham a **mesma Supabase**, as
15 baixas já valem para os dois ambientes — não repetir a aplicação após o deploy dos scripts.

```powershell
py -3 skills\baixa-automatica\scripts\run.py --dry-run   # quantas contas SERIAM baixadas (não grava)
py -3 skills\baixa-automatica\scripts\run.py             # aplica a baixa
```

## Windows Task Scheduler

Quatro tarefas agendadas na pasta `\Sheild\` do Agendador (produção
`C:\Sheild\API\Pagamentos`): **Email Reader** (leitura, 5 min), **Cobrança Vencidos**
(envios, 08:00), **Backup Supabase** (02:00 diário — ver seção acima) e **Baixa Automática**
(reconciliação de pagos, 06:00 diário — ver "Pipeline de baixa automática").

`scheduler/run_reader.ps1` — intervalo de 5 min (`$INTERVAL_MIN` em
`scheduler/setup-task.ps1`). Detecta Python com `pdfplumber` (ordem: `py -3.12`,
`-3.13`, `-3.11`, `-3.10`, `-3`, PATH). Logs em
`logs/scheduler/reader_YYYYMMDD.log`, retidos 30 dias. Instalação em outra
máquina: `scheduler/INSTALL.md` (setup detecta executor `pwsh.exe`/`powershell.exe`
e checa o `.env`).

O backup usa `scheduler/run_backup.ps1` + `setup-backup-task.ps1` (mesmo padrão do runner da
cobrança: detecção de Python, log diário em `logs/backup/`, Event Log em falha). A baixa
automática usa `scheduler/run_baixa.ps1` + `setup-baixa-task.ps1` (log diário em `logs/baixa/`,
Event Log `Pagamentos-Baixa` em falha).

Checkout de **desenvolvimento**: `C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos`
(branch `Features`, sincronizado com `main`) — clone git completo onde todo o trabalho acontece.

**Produção dos recebimentos (outra máquina):** o scheduler roda de
`C:\Sheild\API\Pagamentos`, um **deploy mínimo** (NÃO é clone git) com apenas o
necessário para o pipeline de leitura: `scheduler\` + `skills\` + `.env` + `data\` +
`logs\`. Não tem `apps\`, `server\`, `supabase\`, `packages\` nem `.git`. Como os
scripts `.ps1` usam caminhos relativos a `$PSScriptRoot`, funcionam nesse caminho sem
ajuste. **Atualizar produção = copiar manualmente** os arquivos alterados (ex.: os 2
scripts de `scheduler\`) — não há `git pull` lá. Requer Python 3.12 + `pdfplumber`
instalados na máquina. Guia: `scheduler/INSTALL.md`.

### Deploy manual do Email Reader em produção (caso específico — não regredir)

O usuário **prefere atualizar/validar a produção manualmente** (cópia de arquivos + comando
de validação), **não** pelo `scheduler/deploy-prod.ps1`. Ao orientar, dê o passo a passo
manual direto. Dois cuidados **não óbvios** ao copiar o pipeline de leitura:

- **Caminho correto = `skills\email-reader\scripts\`, NÃO `scheduler\`.** O `run_reader.ps1`
  executa `$PROJECT_ROOT\skills\email-reader\scripts\read_emails.py` (variável `$SCRIPT`).
  Copiar `read_emails.py` para `scheduler\` deixa o código **antigo** rodando.
- **São 2 arquivos INTERDEPENDENTES — copiar só um quebra a extração.** O `read_emails.py`
  novo chama `extract_pdf.extract_to_csv()` (extração **in-process**), função que só existe
  na versão nova de `extract_pdf.py`. Com o `extract_pdf.py` antigo → `AttributeError` →
  toda extração de PDF falha.

| De (dev/bundle) | Para (produção) |
|---|---|
| `skills\email-reader\scripts\read_emails.py` | `C:\Sheild\API\Pagamentos\skills\email-reader\scripts\read_emails.py` |
| `skills\pdf-contas-pagar\scripts\extract_pdf.py` | `C:\Sheild\API\Pagamentos\skills\pdf-contas-pagar\scripts\extract_pdf.py` |

> O **suporte a anexo de imagem** (Claude Vision → `image_vision`) vive exatamente nesses 2
> arquivos — copiar os dois cobre a feature. O CHECK do banco (migration 061) usa a **mesma
> Supabase** de dev e prod, então **já está aplicado** para produção (nenhum passo de banco
> extra). Nenhuma dependência Python nova (a imagem usa o mesmo `anthropic` já instalado).

Validar (com o Python que o scheduler usa) — esperado `True True`:

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails; print('subprocess' not in dir(read_emails), hasattr(read_emails,'is_ignored_sender'))"
```

**Não precisa reiniciar nada**: a tarefa agendada inicia um processo novo a cada execução e
lê os arquivos do disco.

> **DEPENDÊNCIA NOVA — `pypdf` (desde 2026-06-29):** a descriptografia de boletos com senha e o
> split de carnê (1 boleto/página) usam **`pypdf`**. Ao atualizar a produção, instale-o na
> máquina do scheduler: `py -3 -m pip install "pypdf~=6.13"` (ou
> `pip install -r server/requirements.txt`). Sem `pypdf`, o `import extract_pdf` falha e a
> extração para. Valide com o comando de import acima (que importa `read_emails` → `extract_pdf`).

> **DEPLOY 2026-07-06 — cartório + classificação contábil forçada (FEITO e validado em produção):**
> o `document_type` **cartório** e as regras de **classificação contábil FORÇADA por tipo de
> documento** (IRRF/DUIMP/ICMS Importação/transporte/DAM-DUAM/GNRE-ST — ver "Classificação contábil
> FORÇADA por tipo de documento") vivem no `read_emails.py` (+ o mapeamento cartório no
> `extract_pdf.py`). Deploy = copiar os **2 arquivos** (tabela acima) **e** acrescentar
> `cartório,cartorio,tabelionato` ao **`EMAIL_KEYWORDS` do `.env` de produção** (é item de `.env`,
> como o bloco SMTP da cobrança — o `.env` **não** é versionado). **Nenhum passo de banco:** a
> migration 066 está na mesma Supabase de dev/prod, já aplicada. **Estado:** aplicado e validado em
> `C:\Sheild\API\Pagamentos` (read_emails/extract_pdf novos · `pypdf 6.13.0` · `EMAIL_KEYWORDS` com
> 61 termos incluindo cartório · tarefa "Pagamentos - Email Reader" **Ready** · dry-run com
> IMAP+Supabase OK). **Produção roda Python 3.14.5** (o `py -3` resolve p/ 3.14; o `run_reader.ps1`
> tenta `py -3.12` primeiro e cai p/ `-3` — funciona, mas manter um **3.12** instalado como fallback
> estável é desejável). Validação ampliada (esperado `True True True`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print(hasattr(R,'apply_forced_classification'), hasattr(R,'resolve_forced_classification'), 'cartorio' in R.KEYWORDS_DEFAULT)"`

> **DEPLOY 2026-07-06 (posterior) — ignorar confirmação de pagamento (PENDENTE de re-cópia p/ prod):**
> a regra `subject_is_payment_confirmation` (ver "Confirmação de pagamento → `ignorado`") foi
> acrescentada ao `read_emails.py` **depois** do deploy acima, então a produção precisa de uma
> **RE-CÓPIA do `read_emails.py`** para recebê-la (`extract_pdf.py` **não** muda nesta; sem `.env`
> nem banco extra). A **limpeza retroativa** (hard delete de 10 contas de confirmação + `email_control`
> → `ignorado`) já valeu para dev **e** prod (mesma Supabase), então só falta o arquivo. Validação
> (esperado `True`): `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import
> read_emails as R; print(hasattr(R,'subject_is_payment_confirmation'))"`

> **DEPLOY 2026-07-10 — `pix` deixa de ser tipo de documento (PENDENTE de cópia p/ prod):** PIX é só
> forma de pagamento; `document_type='outro'` quando não há tipo claro (migration 075 + `extract_pdf.py`
> sem `apply_pix_override` + ramo `has_pix` do corpo em `read_emails.py`). Deploy = copiar os **2
> arquivos** (`read_emails.py` **e** `extract_pdf.py`, interdependentes — o sintético `pix_valor` vive
> nos dois). **Sem `.env`.** A **migration 075** (backfill `pix`→`outro` + CHECK) já rodou na Supabase
> compartilhada → **vale para prod sem passo extra de banco**. Nº doc sintético de PIX+`outro` passou de
> `PIX_valor` para **`pix_valor`** (minúsculo, do `payment_method`). Validação (esperado `False`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/pdf-contas-pagar/scripts'); import extract_pdf as e;
> print(hasattr(e,'apply_pix_override'))"`

> **DEPLOY 2026-07-10 — autoria `created_by` na extração (PENDENTE de cópia p/ prod):** a Etapa 1 de
> visibilidade por dono (migration 076) faz o pipeline gravar o DONO da conta a partir do remetente.
> Deploy = copiar **só** `read_emails.py` (novos `SupabaseControl.resolve_user` + injeção de `created_by`
> no `register_financial`; `extract_pdf.py` NÃO muda nesta). **Sem `.env`.** A **migration 076** já rodou
> na Supabase compartilhada (coluna + backfill + RPC `resolve_user_for_account` + RLS) → **vale para prod
> sem passo de banco**. O Next API/frontend saem pelo Vercel no merge. Validação (esperado `True`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R;
> print(hasattr(R.SupabaseControl,'resolve_user'))"`
> **Etapa 2 (auditoria de autor, migration 077) NÃO muda o Python** — só migration (já aplicada) +
> Next API/frontend (Vercel). A cópia pendente do `read_emails.py` é só a da Etapa 1 (mesma).

> **DEPLOY 2026-07-15 — vínculo do anexo do e-mail (PENDENTE de cópia p/ prod):** a migration 079
> (anexos múltiplos) faz o reader REGISTRAR em `financial_account_attachment` o anexo que já sobe ao
> Storage. Deploy = copiar **só** `read_emails.py` (`register_financial` agora devolve o **id** da
> conta via `return=representation`, + `SupabaseControl.register_attachment` + o vínculo no Passo 2;
> `extract_pdf.py` NÃO muda). **Sem `.env`, sem dependência nova.** A **migration 079** já rodou na
> Supabase compartilhada (tabela + RLS + backfill dos `source_file` históricos) → **vale para prod sem
> passo de banco**. Next API/frontend saem pelo Vercel no merge. **Degrada com segurança:** o registro
> é não-fatal e a UI tem o fallback `legacySourceFile`, então produção com o `read_emails.py` ANTIGO
> segue funcionando (só não cria a linha do anexo para contas novas). Esta cópia **substitui** a
> pendência de 2026-07-10 (Etapa 1) — o mesmo arquivo carrega as duas. Validação (esperado
> `True True`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R;
> print(hasattr(R.SupabaseControl,'register_attachment'), hasattr(R.SupabaseControl,'resolve_user'))"`

> **DEPLOY 2026-07-16 — contato do fornecedor na extração (PENDENTE de cópia p/ prod):** o reader passa
> a detectar telefone/WhatsApp/chave PIX no corpo e gravar em `supplier` (write-back, 2 slots — ver
> "Contato do fornecedor"). Deploy = copiar **só** `read_emails.py` (novos `parse_supplier_contacts`,
> `apply_contact_writeback`, `SupabaseControl.update_supplier_contact`; `extract_pdf.py` NÃO muda —
> detecção é só do corpo). **Sem `.env`, sem dependência nova.** A **migration 082** (8 colunas +
> REVOKE) já rodou na Supabase compartilhada → **vale para prod sem passo de banco**. Next API/frontend
> (form) saem pelo Vercel no merge. **Degrada com segurança:** o write-back é best-effort e não toca no
> payload da conta, então o `read_emails.py` ANTIGO segue funcionando (só não popula os contatos). Como
> os deltas de `read_emails.py` são cumulativos, esta cópia **carrega junto** as pendências anteriores
> (Etapa 1 `created_by` de 2026-07-10 e vínculo de anexo de 2026-07-15). Validação (esperado
> `True True`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R;
> print(hasattr(R,'parse_supplier_contacts'), hasattr(R.SupabaseControl,'update_supplier_contact'))"`

> **DEPLOY 2026-07-16 — Beneficiário Final vence Beneficiário/Cedente (PENDENTE de cópia p/ prod):** em
> boleto securitizado, o fornecedor passa a ser o **Beneficiário Final** (não o cedente/cobrança) — ver
> "Beneficiário Final vence Beneficiário/Cedente". Deploy = copiar **só** `extract_pdf.py` (novos
> `extract_beneficiario_final`/`apply_beneficiario_final` + chamada em `build_record`; **`read_emails.py`
> NÃO muda** nesta). **Sem `.env`, sem dependência nova, sem passo de banco.** **Degrada com segurança:**
> o override só atua quando o rótulo "Beneficiário Final" existe no texto do PDF; o `extract_pdf.py`
> ANTIGO segue funcionando (só não corrige o securitizado). Validação (esperado
> `('INORGAN INDUSTRIA QUIMICA LTDA', '56879838000151')` ou similar / `True`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/pdf-contas-pagar/scripts'); import extract_pdf as E;
> print(hasattr(E,'apply_beneficiario_final'))"`

> **DEPLOY 2026-07-16 — dedup por NOSSO NÚMERO (PENDENTE de cópia p/ prod):** a dedup ganhou a impressão
> **1b** (`sk_supplier` + `nosso_numero`) para pegar reemissão/2ª via/aviso de vencimento que muda valor
> (juros) E vencimento — ver "Impressão 1b". Deploy = copiar **só** `read_emails.py` (novos
> `_is_real_nosso_numero` + impressão 1b em `find_financial_duplicate`; **`extract_pdf.py` NÃO muda**
> nesta). **Sem `.env`, sem dependência nova, sem passo de banco.** **Degrada com segurança:** a 1b só
> atua com nosso número real (≥8 díg.); o `read_emails.py` ANTIGO segue funcionando (só não pega esse
> caso de reemissão). Correção de dados (delete do 560) já valeu para dev+prod (mesma Supabase).
> Validação (esperado `True`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R;
> print(hasattr(R,'_is_real_nosso_numero'))"`

> **DEPLOY 2026-07-17 — `sk_company` como chave de relacionamento (CONCLUÍDO — migration + cópia
> + merge feitos):** a `company` passou a ter `sk_company` (PK IDENTITY, chave única de
> relacionamento) e `financial_account_control` referencia a empresa por `sk_company` (não mais
> `company_id`) — ver "Banco de dados" / migration 083. Estado do rollout:
> - **Migration 083 APLICADA** (via psql, 2026-07-17) na Supabase compartilhada dev+prod →
>   **nenhum passo de banco** em produção.
> - **Os 2 arquivos Python COPIADOS** para `C:\Sheild\API\Pagamentos\` (ambos passaram a ler
>   `company?sk_company=eq.1` no lugar de `company_id=eq.1`):
>   `skills/email-reader/scripts/read_emails.py` (método `company_cnpj()`; `extract_pdf.py` NÃO
>   muda) e `skills/cobranca-vencidos/scripts/supabase_log.py` (função `fetch_company_smtp()`).
> - **Frontend** (getCompanyEmail + schema) publicado pelo Vercel no merge do **PR #139**.
>
> **Sem `.env`, sem dependência nova.** **Degradou com segurança:** `company_id` foi preservado
> (NOT NULL UNIQUE), então o código ANTIGO seguiu funcionando entre a migration e a cópia.
> Os dois leitores foram validados contra o banco migrado (CNPJ da OTIMOTEX `47273917000123` e a
> linha SMTP). Revalidar (exige `.env` carregado):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print(R.SupabaseControl().company_cnpj())"`
>
> **Único item que depende da máquina de PRODUÇÃO:** reabilitar a task
> `Enable-ScheduledTask -TaskName "Pagamentos - Email Reader" -TaskPath "\Sheild\"` (foi pausada
> para o rollout). A máquina de dev (SHE-DEV) não a enxerga.

> **DEPLOY 2026-07-17 — regra LEBIANCO da empresa pagadora (PENDENTE de cópia p/ prod):** o reader
> passa a gravar `sk_company` (1=OTIMOTEX / 2=LEBIANCO) pela referência a "lebianco" — ver "Empresa
> pagadora (`sk_company`) — regra LEBIANCO". Deploy = copiar **só** `read_emails.py` (novos
> `resolve_sk_company`/`apply_sk_company`/`_has_lebianco_reference`/`_subject_has_lebianco`/
> `_pdf_mentions_lebianco`; **`extract_pdf.py` NÃO muda**). **Sem `.env`, sem dependência nova**
> (pdfplumber já é usado). A **migration 084** (fix do trigger + backfill de 55 contas) já rodou na
> Supabase compartilhada dev+prod → **nenhum passo de banco** em produção.
> **ATENÇÃO — a ordem importa:** a 084 já está aplicada, então o trigger **já** respeita
> `sk_company` explícito; enquanto o `read_emails.py` ANTIGO estiver em produção, ele **não** envia
> `sk_company` → o trigger resolve pelo CNPJ → **fallback 1 (OTIMOTEX)**. Ou seja, degrada com
> segurança (contas novas da Lebianco entram como Otimotex até a cópia; corrigíveis re-rodando o
> backfill da 084, que é idempotente). Validação (esperado `2 1`):
> `py -3 -c "import sys; sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R; print(R.resolve_sk_company(sender_email='ana@lebianco.com.br'), R.resolve_sk_company(subject='PAGAMENTO BOLETO DAMSP'))"`

### Deploy manual da Cobrança de vencidos (envios) em produção (caso específico — não regredir)

Mesma máquina/pasta dos recebimentos (`C:\Sheild\API\Pagamentos`); o scheduler de **envios**
executa `skills\cobranca-vencidos\scripts\run.py` (`run_cobranca.ps1` `$SCRIPT`).

> **PREFERÊNCIA DO USUÁRIO (não regredir):** atualização de produção é **cópia manual dos
> arquivos + validação manual** — **NÃO** propor nem usar scripts de deploy (o `scheduler\
> deploy-prod.ps1` existe, mas o usuário NÃO quer usá-lo; só executar se ele pedir
> explicitamente). Fluxo preferido: (1) backup do que será sobrescrito; (2) copiar os arquivos
> `.py` alterados; (3) validar com `Select-String` (confirmar que o código novo chegou) +
> `import ...` + `run.py --dry-run`. Mesmos cuidados do reader:

**O QUE COPIAR para produção (regra geral — vale p/ reader e cobrança):**

| Mudou… | Copiar | Re-registrar tarefa? |
|---|---|---|
| **Lógica do pipeline** (`.py` em `skills\…\scripts\`) | os `.py` alterados (conjunto interdependente) | Não |
| **Wrapper/agendador funcional** (`.ps1` em `scheduler\` — horário, timeout, runner) | o `.ps1` alterado | Só se mudou `setup-*.ps1` (rodar como Admin) |
| **Só comentário/doc** (`.ps1`/`.md` sem efeito funcional) | nada | Não |

> Cada **caso de atualização** (esta sessão, p.ex.) deve dizer explicitamente de quais pastas
> copiar. Ex.: mudança que mexe só em `skills\cobranca-vencidos\scripts\` **não** exige tocar em
> `scheduler\`. A tarefa agendada lê o disco a cada execução — nunca precisa "reiniciar".

- **Caminho correto = `skills\cobranca-vencidos\scripts\`, NÃO `scheduler\`.**
- **7 scripts INTERDEPENDENTES — copiar só um quebra.** `run.py` (batch) **e** `resend.py`
  (reenvio) dependem de **`send_core.py`** (`from send_core import send_and_log, validate_email`
  — dependência **nova** do `run.py`); `send_core.py` → `email_sender`/`supabase_log`/`template`.
  Copiar `run.py`/`resend.py` sem `send_core.py` → `ImportError`. **`run.py` também importa
  `failure_notify.py`** (`from failure_notify import ...` — notificação ao CC), então ele entra
  no conjunto. **Na dúvida, copie o conjunto inteiro** (8 arquivos): `db_firebird.py`,
  `email_sender.py`, `failure_notify.py`, `resend.py`, `run.py`, `send_core.py`,
  `supabase_log.py`, `template.py`.
- **Pré-requisitos da máquina (diferente do reader):** driver Firebird **`fdb`** (fallback
  `firebirdsql`) instalado; `.env` com **`FB_HOST/FB_PORT/FB_DATABASE/FB_USER/FB_PASSWORD/
  FB_CHARSET`** (Firebird) + **SMTP transacional** (`SMTP_HOST=smtplw.com.br` · `SMTP_PORT=587` ·
  `SMTP_USER=otimotex1` · `SMTP_PASSWORD=<token>` — sem o bloco, cai no fallback IMAP
  `email-ssl.com.br`, que tem o gargalo `451`) + `COBRANCA_SEND_DELAY_SECONDS` (throttle, **10s**
  em produção — ver `cobranca-smtp-bottleneck`) + `DEV_MODE`/`DEV_OVERRIDE_EMAIL`/`DEV_OVERRIDE_CC_EMAIL`.
  > **Virada do SMTP transacional (2026-06-25):** o bloco `SMTP_*` foi adicionado ao `.env` de
  > **dev**; o `.env` de **produção** (`C:\Sheild\API\Pagamentos\.env`, máquina separada) precisa
  > receber as mesmas 4 linhas `SMTP_*` **manualmente** — é só `.env`, nenhum `.py` muda. Sem elas,
  > a tarefa agendada segue no caminho IMAP antigo.

Validar (esperado: `imports OK`):

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/cobranca-vencidos/scripts'); import send_core, run, resend; print('imports OK')"
```

Ou melhor — `py -3 skills\cobranca-vencidos\scripts\run.py --dry-run` valida imports **e** a
conexão Firebird **sem enviar e-mail**. **Não precisa reiniciar nada** (a tarefa inicia processo
novo). A cobrança está **em produção** (`DEV_MODE=false` — envia para clientes reais); ainda
assim, rode um `--dry-run` após alterar o pipeline antes de confiar na próxima execução real.

### Deploy manual do Backup do Supabase em produção (caso específico — não regredir)

Terceiro pipeline agendado (**skill `backup-supabase`**, criada e **posta em produção em
2026-07-03** — 1º backup OK: 381 arquivos / ~52 MB, exit 0; ver memória
[[backup-supabase-skill]]). Mesma máquina/pasta dos outros dois (`C:\Sheild\API\Pagamentos`);
o scheduler executa `skills\backup-supabase\scripts\run.py` (`run_backup.ps1` `$SCRIPT`), 1x/dia
às **02:00**. A tarefa "Pagamentos - Backup Supabase" já está registrada e validada em produção
(usar este roteiro apenas para **atualizar** os scripts, não para o setup inicial). Faz `pg_dump` do banco (formato custom, schema `public`) + download do bucket
`attachments` (REST/`urllib` com `SUPABASE_SERVICE_KEY`) para `backups\<ts>\`; retenção 30 dias;
`manifest.json` por execução. Mesma **preferência do usuário**: atualização de produção é **cópia
manual + validação** (nunca `deploy-prod.ps1`).

**O QUE COPIAR para produção:**

| De (dev) | Para (produção) |
|---|---|
| `skills\backup-supabase\` (pasta inteira) | `C:\Sheild\API\Pagamentos\skills\backup-supabase\` |
| `scheduler\run_backup.ps1` | `C:\Sheild\API\Pagamentos\scheduler\` |
| `scheduler\setup-backup-task.ps1` | `C:\Sheild\API\Pagamentos\scheduler\` |

- **5 scripts Python** (`config.py`, `backup_db.py`, `backup_storage.py`, `retention.py`,
  `run.py`) são **módulos irmãos** (`sys.path.insert(0, <dir do run.py>)` — mesmo padrão da
  cobrança). Copiar a pasta inteira evita `ImportError`.
- **Pré-requisito NÃO ÓBVIO — `pg_dump` ≥ 17 na máquina de produção.** O servidor é PG 17; um
  `pg_dump` 16 aborta com "server version mismatch". Produção pode **não ter pgAdmin** (que em dev
  fornece o `pg_dump` 18.2 em `C:\Program Files\pgAdmin 4\runtime\pg_dump.exe`, **sem** subpasta de
  versão — o glob de detecção de `config.py` cobre com e sem subpasta). Se faltar, instale o
  **PostgreSQL 17+ client** ("Command Line Tools") e, se não ficar no PATH, defina
  `PG_DUMP_PATH=C:\Program Files\PostgreSQL\17\bin\pg_dump.exe` no `.env`.
- **`.env` de produção precisa de `SUPABASE_DB_URL`** (a MESMA connection string do pgAdmin —
  Session pooler, IPv4, porta 5432; senha URL-encoded, ex.: `@`→`%40`). `SUPABASE_URL`/
  `SUPABASE_SERVICE_KEY` já existem (o reader usa). É só `.env`, nenhum `.py` muda. Opcionais têm
  padrão: `BACKUP_DB_SCHEMAS=public`, `BACKUP_STORAGE_BUCKET=attachments`, `BACKUP_RETENTION_DAYS=30`.
- **Sem dependência Python nova** (stdlib + `python-dotenv`, já presente). A Supabase é a mesma de
  dev — o backup rodando em produção protege o mesmo banco/Storage; a máquina de produção fica
  ligada 24/7, ideal para o disparo das 02:00.
- **Espaço em disco:** backup é **completo todo dia** (re-baixa todo o bucket) × retenção 30 dias.
  Se o disco de produção for apertado, reduzir `BACKUP_RETENTION_DAYS` no `.env` de lá.

Validar (esperado: `imports OK` + Storage listado; o `--dry-run` detecta `pg_dump` e confere a
`SUPABASE_DB_URL`, **sem gravar** — mas NÃO testa a senha, só a presença da variável):

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/backup-supabase/scripts'); import config, backup_db, backup_storage, retention, run; print('imports OK')"
py -3 skills\backup-supabase\scripts\run.py --dry-run
```

Para validar a **senha** de verdade, rode um dump real só do banco (rápido, não baixa o Storage):
`py -3 skills\backup-supabase\scripts\run.py --skip-db` (só Storage) / `--skip-storage` (só banco).
Registrar a tarefa (uma vez, **PowerShell como Administrador**):
`.\scheduler\setup-backup-task.ps1` → cria **"Pagamentos - Backup Supabase"** na pasta `\Sheild\`.
**Não precisa reiniciar nada** (a tarefa inicia processo novo a cada disparo).

### Deploy manual da Baixa automática em produção (caso específico — não regredir)

Quarto pipeline agendado (**skill `baixa-automatica`**). Mesma máquina/pasta dos outros
(`C:\Sheild\API\Pagamentos`); o scheduler executa `skills\baixa-automatica\scripts\run.py`
(`run_baixa.ps1` `$SCRIPT`), 1x/dia às **06:00**. Marca como `pago` as contas com NF + Boleto
confirmados, vencimento <= hoje e em aberto (um `PATCH` via `service_role`). Mesma **preferência
do usuário**: atualização de produção é **cópia manual + validação** (nunca `deploy-prod.ps1`).

**O QUE COPIAR para produção:**

| De (dev) | Para (produção) |
|---|---|
| `skills\baixa-automatica\` (pasta inteira) | `C:\Sheild\API\Pagamentos\skills\baixa-automatica\` |
| `scheduler\run_baixa.ps1` | `C:\Sheild\API\Pagamentos\scheduler\` |
| `scheduler\setup-baixa-task.ps1` | `C:\Sheild\API\Pagamentos\scheduler\` |

- **Sem dependência Python nova** — usa `urllib` (stdlib) + `python-dotenv` (já presente). O
  `run.py` é um módulo isolado (não importa irmãos), então basta a pasta da skill.
- **`.env` de produção já tem as chaves** (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY` — o reader
  depende delas). Nenhuma variável nova, nenhum passo de banco (as colunas
  `has_invoice`/`has_bank_slip`/`status_id` e os grants já existem — migrations 033/068; a
  Supabase é a mesma de dev/prod).
- **Regra espelhada no frontend** (`qualifiesForAutoPago` em `Consulta.tsx`, deploy pelo
  Vercel) e no batch — as duas instâncias usam as **mesmas 4 condições**. Ao mudar a regra,
  ajustar os **dois** lados.

Validar (esperado: `imports OK`; o `--dry-run` reporta a contagem sem gravar):

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/baixa-automatica/scripts'); import run; print('imports OK')"
py -3 skills\baixa-automatica\scripts\run.py --dry-run
```

Registrar a tarefa (uma vez, **PowerShell como Administrador**):
`.\scheduler\setup-baixa-task.ps1` → cria **"Pagamentos - Baixa Automática"** na pasta `\Sheild\`.
**Não precisa reiniciar nada** (a tarefa inicia processo novo a cada disparo).

