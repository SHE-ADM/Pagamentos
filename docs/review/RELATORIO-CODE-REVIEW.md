# RELATÓRIO DE CODE REVIEW — pré-produção (`pagamentos`)

> Data: 2026-07-08 · Branch: `Features` · Modelo: claude-opus-4-8 (1M) · Migrations no repo: 001→071
> Spec seguida: `docs/prompts/code-review-producao-spec.md` (ajustada pelo orquestrador para 001→071;
> migration nova exigida pela Fase 2 numera a partir de **072**).
> Sessão READ-ONLY no código de produção — só este relatório + `docs/review/prompts/*` foram escritos.

---

## 0. Sumário executivo

**Veredito de produção: PASSA COM RESSALVAS.** O gate está **100% verde** (lint, typecheck, test,
prune, pytest, vulture) e **não há nenhum achado BLOCKER ou CRÍTICO**. Nenhum defeito de code review
impede o go-live por si só. Há **1 achado ALTO** (contraste AA reprovado em botões `text-white`/`bg-brand`)
e **6 MÉDIO** recomendados antes ou logo após o go-live; o restante é BAIXO (higiene/consistência).

> ⚠️ O **bloqueador de produção real** estava no BLOCO B (segurança): o achado **[ALTO] S2** (RPCs
> `SECURITY DEFINER` de fornecedor com `EXECUTE` para PUBLIC) exigia a **migration 072** antes do go-live.
> **FECHADO na Fase 2 (2026-07-08)** — 072 aplicada e vetor verificado; o veredito de segurança virou
> **PASSA**. Ver `docs/review/seguranca/RELATORIO-SEGURANCA.md`.

### Status de aplicação (Fase 2 — 2026-07-08, branch `Features`)

| Achado(s) | Commit |
|---|---|
| A1-1..5, A2-1/A2-2, A3-1..8 | `466aa35` (delete 409 FK 058, failFromError, 23503, matcher, contraste brand-dark, tokens status-*, órfãos, aria-label, e2e Dashboard) |
| A6-1/A6-3/A6-4 + A7-1 | `5dc1e24` (formatadores em lib/format, Pillow, testes loadMore/bulk) — A6-2 já em `466aa35` |
| A4-1 (IMAP dos reprocessadores) | `52f6c67` |
| A5-1 (doc 055) + A5-2 (seed grupo 1 — migration **073** aplicada) | `52f6c67` |
| **Pendentes (BAIXO, cobertura de teste)** | A7-2 (a11y Dashboard), A7-3 (ResetPasswordForm funcional), A7-4 (Erros/CobrancaErros), A7-5 (pytest is_processed) — prompt `07-test-coverage.md` |

### Contagem por severidade (code review)

| Severidade | Qtde |
|---|---|
| BLOCKER | 0 |
| CRÍTICO | 0 |
| ALTO | 1 |
| MÉDIO | 6 |
| BAIXO | 20 |

### Achados por área

| Área | ALTO | MÉDIO | BAIXO | Prompt Fase 2 |
|---|---|---|---|---|
| Next API CRUDs | 0 | 2 | 3 | `01-next-api-cruds.md` |
| Frontend grid/forms | 0 | 0 | 2 | `02-frontend-grid-forms.md` |
| Design / a11y | 1 | 2 | 5 | `03-frontend-design-a11y.md` |
| Pipeline Python | 0 | 0 | 1 | `04-python-pipeline.md` |
| SQL / migrations | 0 | 0 | 2 | `05-sql-migrations.md` |
| Código morto / deps | 0 | 1 | 3 | `06-dead-code-deps.md` |
| Cobertura de testes | 0 | 1 | 4 | `07-test-coverage.md` |

---

## 1. Resultado das validações (saída real)

Todos os comandos rodados na raiz em 2026-07-08. **Gate 100% verde.**

| Comando | Resultado | Observação |
|---|---|---|
| `npm run lint` | **exit 0 — 0 erro / 0 warning** | 4 workspaces (api-backend, frontend-vite, portal-next, @sheild/shared) sem saída de erro |
| `npm run typecheck` | **exit 0 — 0 erro** | `tsc --noEmit` limpo nos 4 workspaces |
| `npm test` | **exit 0 — 591 testes** | api-backend 235 (35 files) · frontend-vite 354 (98 files) · portal-next 2 (1 file) — 0 falha |
| `npm run prune` | **1 linha** | `apps/api-backend/lib/auth.ts:13 - ADMIN_GROUP_ID (used in module)` — export órfão (ver §6 / achado A6-2) |
| `py -3 -m pytest tests/ -q` | **exit 0 — 423 passed** (14.84s) | 0 falha |
| `py -3 -m vulture server/ skills/ scripts/ --min-confidence 60` | **7 linhas** | Todas rotas Flask `@app.get/@app.post` — **falsos positivos conhecidos** (ver §8) |
| `py -3 skills\cobranca-vencidos\scripts\run.py --dry-run` | **exit 0** | 58 títulos: enviados=52 · pulados=0 · erros=6 (sem e-mail/inválido=6 · operacionais=0). Erros de DADO não reprovam — exit code correto |

Nenhuma falha ou warning entra no gate. A única linha do `prune` é tratada como achado **BAIXO** (A6-2),
não como falha de gate (é ruído "used in module", não erro).

---

## 2. Auditoria dos CRUDs (Next API)

Legenda: **OK** = conforme; **ACHADO** = defeito (com id e severidade).

| Recurso | Contrato REST | Camadas | Zod↔CHECK | Mass-assign | Dual-mode | Delete/409 | Write-back | Race |
|---|---|---|---|---|---|---|---|---|
| suppliers | OK | OK | OK | OK | — | OK (soft+409) | OK | OK (doc) |
| contas | OK | OK | OK (pós-069/071) | OK | — | OK (sem DELETE) | OK | OK |
| cost-centers | OK | OK | OK | OK | OK | OK (hard+409+sent.0) | — | OK (doc) |
| banks | OK | OK | OK | OK | OK | OK | — | OK (doc) |
| financial-accounts | OK | OK | **ACHADO A1-4** | OK | OK | OK | — | OK |
| chart-accounts | OK | OK | OK | OK | OK | OK | — | OK (doc) |
| chart-account-groups | OK | OK | OK | OK | OK | **ACHADO A1-1** | — | OK (doc) |
| chart-account-subgroups | OK | OK | OK | OK | OK | OK | — | OK (doc) |
| users/auth | **ACHADO A1-2** | OK | OK | OK | — | — | — | — |

### Achados

**[MÉDIO] A1-1 — Delete de grupo do plano de contas não cobre a FK direta 058 → retorna 500 em vez de 409.**
`apps/api-backend/lib/chart-account-groups.ts:20` (loop em `:169-175`). `REFERENCING_TABLES` só lista
`financial_chart_of_account_subgroup`, mas a migration `058_chart_account_group_fk.sql:15-17` criou a FK
direta `financial_chart_of_account.chart_account_group_id → financial_chart_of_account_group`
(`ON DELETE NO ACTION`). Um grupo referenciado *diretamente* por um plano de contas passa na checagem da
app, cai no `.delete()`, o Postgres rejeita com 23503 e `remove()` lança `...(error.message, 500)` →
`failFromError` mascara para **500 "Erro interno"**. O banco protege o dado (não vira órfão), mas o
contrato quebra: deveria ser **409 "Grupo em uso"**. **Correção:** incluir `'financial_chart_of_account'`
em `REFERENCING_TABLES` (a coluna de FK `chart_account_group_id` já é o `REF_COLUMN`).

**[MÉDIO] A1-2 — `POST /api/users` reintroduz `fail(e.message, 500)` (antipadrão proibido).**
`apps/api-backend/app/api/users/route.ts:26`: `return fail(e instanceof Error ? e.message : 'Erro inesperado', 500)`.
Contraria `CLAUDE.md:469-473` (§3 M-2: "Não reintroduzir `fail(e.message, 500)`"). Erros não-`UserServiceError`
(ex.: `getSupabaseAdmin()` sem env configurada, erro interno do SDK Auth) vazam `e.message` cru. Exposição
limitada porque a rota é `requireAdmin`. **Correção:** `catch (e) { return failFromError(e, 'users'); }`
(remove o import agora inútil de `UserServiceError`). *Cross-ref: também visto em segurança S3 (INFO).*

**[BAIXO] A1-3 — `contas.ts` não mapeia 23503 (FK) → retorna 422 com mensagem crua do Postgres.**
`apps/api-backend/lib/contas.ts:191-195` e `:210-215`: só 23505 é mapeado (→409); qualquer outro erro vira
`ContaServiceError(error.message, 422)`. Uma violação de FK (23503) em `sk_supplier`/`cost_center_id`/
`chart_account_id`/`status_id` (ex.: PATCH `status_id=999`) retorna 422 com o nome de constraint/tabela do
Postgres, que `failFromError` ecoa (<500). Inconsistente com `financial-accounts.ts:67-75` e
`chart-account-subgroups.ts:69-72` (têm `mapWriteError`). **Correção:** adicionar `mapWriteError` 23503→422
com mensagem curada.

**[BAIXO] A1-4 — `financial-account.schema.ts` usa `.min(0)` com mensagem "é obrigatório".**
`packages/shared/src/schemas/financial-account.schema.ts:42-43`: `bank_id`/`payment_type_id` são
`z.number().int().min(0, '… é obrigatório')`. Com `.min(0)`, o valor 0 (sentinela "não informado") passa
na validação, então a mensagem "obrigatório" nunca dispara — divergente do padrão `.min(1)` documentado
(`CLAUDE.md:338-340`) e usado no `status_id` do mesmo bloco. **Correção:** decidir — se obrigatório usar
`.min(1)`; se opcional, ajustar/remover o texto de obrigatoriedade.

**[BAIXO] A1-5 — Matcher do middleware sem âncora de segmento (latente).**
`apps/api-backend/middleware.ts:19`: `'/api/((?!health|auth/login).*)'`. O lookahead casa por prefixo — uma
rota futura como `/api/health-detail` ou `/api/auth/login-audit` ficaria pública sem intenção. Hoje sem
impacto (só existem `/api/health` e `/api/auth/login`). **Correção:** ancorar por fim de segmento
(`'/api/(?!health$|auth/login$).*'`). *Cross-ref: também reportado em segurança S1-2.*

---

## 3. Frontend — qualidade e desperdício

Confirmações OK (sem achado): **embeds nos dois caminhos de leitura** (`SELECT_WITH_EMBEDS` em
`services/supabase.ts:202-212` e `SELECT_WITH_SUPPLIER` em `api-backend/lib/contas.ts:33-41` mesclado
in-place por `Consulta.tsx:377-380`) trazem grupo/subgrupo aninhados — a célula "Plano de contas" não
fica parcial após salvar; **cascata centro→plano CONTROLADA** (`CostCenterSelect.tsx:44-46`,
`ChartAccountSelect.tsx:47-49` espelham `value` no render; `prefillNonce` removido — regressão não voltou);
**`__select__` não vaza para prefs**; **measureElement + auto-recuperação de scrollRect** presentes;
**debounce 350ms + `loadingMoreRef` + `applyingBulk`** contra duplo-fire; **React Compiler** sem memo manual;
**helpers de formato = fonte única** em `lib/format.ts`.

### Achados

**[BAIXO] A2-1 — Filtro de intervalo de datas malformado em `cobrancaService.ts` (latente).**
`apps/frontend-vite/src/services/cobrancaService.ts:93-94`: `params['occurred_at'] = 'gte.${dateFrom},lte.${dateTo}...'`
— a vírgula vira parte do valor do operador `gte` (sintaxe PostgREST inválida → 400/resultado errado). Hoje
**inalcançável** (`CobrancaErros.tsx:65-70` nunca envia `dateFrom`/`dateTo`). Defeito latente: quebra se um
filtro de período for ligado. **Correção:** usar `and=(occurred_at.gte.X,occurred_at.lte.Y)` como em
`fetchEnviosLog` (`:74-79`).

**[BAIXO] A2-2 — `new Date()` no corpo de render (impuro) em `Dashboard.tsx`.**
`apps/frontend-vite/src/pages/Dashboard.tsx:36`: `const now = new Date()` no render, contrariando o padrão do
próprio projeto (`Consulta.tsx:164-219` usa `useState(() => …)` lazy) e o §5. Sem bug funcional (só alimenta
estado inicial). **Correção:** `useState(() => new Date().getMonth())` / `getFullYear()`.

> Os KPIs de `Erros.tsx` com cor default do Tailwind foram consolidados no achado **A3-3** (design/a11y).

---

## 4. Pipeline Python — robustez (não-regressão)

**As 8 proteções não-regressão do CLAUDE.md estão presentes e corretas** (confirmação com arquivo:linha):

| Proteção | Local |
|---|---|
| (a) Extração IN-PROCESS (sem subprocess de extract_pdf.py) | `read_emails.py:2862` `run_extraction`→`extract_pdf.extract_to_csv`; nenhum `subprocess.run([...extract_pdf.py])` no repo |
| (b) IMAP com timeout | `read_emails.py:3530,3549` (`IMAP_TIMEOUT_SECONDS`) |
| (c) IMAP retry/backoff + logout em try/finally | `_connect_and_search:3566-3604` + `run_reader` finally `3785-3790` |
| (d) Claude API timeout (3 instâncias) | `extract_pdf.py:595,742,765` |
| (e) `_rfc822_from_fetch` | `read_emails.py:3349-3362` (usado em `3374`, `3706`) |
| (f) Dedup por message_id | `register:296` (`Prefer: ignore-duplicates`) + `is_processed:248` |
| (g) Dedup de conteúdo por sk_supplier | `find_financial_duplicate:446-534` (`if not sk_supplier: return None`) |
| (h) `_finalize_supplier` antes do INSERT + bloqueio de domínio interno | `_finalize_supplier:1311` (chamado em `3052`/`3179`); bloqueio interno na RPC do banco (mig 046) |

`status_for_result` (`3324-3346`), exit code da cobrança (`compute_exit_code:84-93` — dado não reprova,
operacional reprova; `main()` retorna o código), `SmtpSession` reusada com catch `(SMTPServerDisconnected,
ConnectionError, TimeoutError)` (nunca `OSError`) e fonte única `run_reader()` — **todos corretos**. Os
`except Exception` amplos revisados são best-effort documentados (não engolem falha da gravação principal).

### Achado

**[BAIXO] A4-1 — 3 scripts de reprocessamento abrem IMAP sem timeout/retry.**
`scripts/reprocess_body_emails.py:146`, `scripts/reprocess_link_emails.py:150`, `scripts/reprocess_message.py:116`
usam `imaplib.IMAP4_SSL(host, port)` cru, divergindo do helper canônico `read_emails._connect_imap()` (que
`reprocess_ignored_emails.py:133` e `backfill_received_at.py:104` já reusam). Um `fetch` que estanca trava o
reprocessamento manual. Mitigado por serem ferramentas de operador (não o pipeline agendado). **Correção:**
trocar as 3 aberturas cruas por `mail = R._connect_imap()`.

> Nota de doc (não-achado): a proteção (h) cita `_is_internal_email`, função que **não existe** em Python — o
> bloqueio de e-mail interno é imposto na RPC `resolve_supplier_for_account` (mig 046). Ajuste documental
> tratado no bloco de segurança S4 (INFO).

---

## 5. SQL / migrations

Confirmações OK: **RLS sem default-deny acidental** (o buraco pré-049 foi fechado em `049`); **GRANTs por
coluna** exatos (`financial_account_control` gravável por `authenticated` só em `has_invoice`/`has_bank_slip`/
`status_id`; `email_control` só `reviewed_at`); **CHECK ↔ z.enum alinhados 1:1** no estado atual
(`document_type` 31 valores/`066`, `payment_method` 16/`071` com `débito automático`, `extraction_source`
5/`061` com `image_vision`, `status_id` 1..10/`035`); **FKs + sentinela id 0** consistentes; **funções
`SECURITY DEFINER` com `search_path` fixado**; **triggers de status/supplier** sem efeito colateral.

### Achados

**[BAIXO] A5-1 — Afirmação de idempotência da migration 055 ficou desatualizada pós-069.**
`055_doc_idempotency_guards.sql:31` faz `COMMENT ON COLUMN financial_account_control.status`, mas a
`069_drop_status_text.sql:48-49` dropou a coluna `status`. Reaplicar a 055 após a 069 aborta ("column status
does not exist"), contradizendo a própria 055 e o `README.md` que a declaram "idempotente/re-executável".
Falha segura (não corrompe dado), mas a doc está estale. **Correção (sem migration):** atualizar o cabeçalho
da 055 e a nota do README para "idempotente **até a 069**; após o drop da coluna `status`, não reaplicar".

**[BAIXO] A5-2 — Seed do `group_id = 1` exigido pela 065 não é versionado.**
`065_create_user_profile.sql:80-86` faz `UPDATE user_profile SET group_id = 1` (FK → `user_group`), mas a
`063_create_user_group.sql:34-36` só semeia o sentinela id 0. O grupo 1 ("Administrador") é criado fora do
versionamento (`GENERATED ALWAYS AS IDENTITY`). Em aplicação limpa e em ordem, se o grupo 1 ainda não existir,
o UPDATE viola a FK e a 065 aborta. **Correção (migration 072 ou na própria 065):**
`INSERT INTO user_group (group_id, group_name) OVERRIDING SYSTEM VALUE VALUES (1,'Administrador') ON CONFLICT DO NOTHING;`
antes da Seção 5.

> INFO (não-achado): `trg_supplier_mirror_id` (042) é a única trigger sem `SECURITY DEFINER`/`search_path` —
> benigno (só `NEW.supplier_id := NEW.sk_supplier`, sem acesso a objeto por nome). `normalize_search()` não é
> versionada (bootstrap manual) — tratado em segurança S2 (INFO).

---

## 6. Código morto, redundância e dependências

### Achados

**[MÉDIO] A6-1 — Formatadores duplicados em `cobrancaColumns.ts` (viola "fonte única em lib/format.ts").**
`apps/frontend-vite/src/pages/cobranca/cobrancaColumns.ts:12,18,29`: `fmtDate` (`:12-16`), `fmtDateTime`
(`:18-27`, idêntico byte-a-byte a `format.ts:12-21`) e `fmtCurrency` (`:29-30`, idêntico a `fmtMoney`
`format.ts:24-25`). O cabeçalho de `format.ts:2-4` alerta esse risco de drift. **Correção:** importar
`fmtDate`/`fmtDateTime`/`fmtMoney` de `../../lib/format` e eliminar as cópias.

**[BAIXO] A6-2 — `ADMIN_GROUP_ID` export órfão (único hit do ts-prune).**
`apps/api-backend/lib/auth.ts:13`: `export const ADMIN_GROUP_ID = 1` só é usado no próprio módulo (`:121`); o
frontend tem cópia independente em `AuthContext.tsx:22` (não importa cross-package). **Correção:** remover o
`export` (vira `const` local) → zera o ts-prune. O espelhamento documentado é de valor, não de import.

**[BAIXO] A6-3 — `fmtDt` local redundante em `Erros.tsx`.**
`apps/frontend-vite/src/pages/Erros.tsx:11`: formatador de data/hora local redundante com `fmtDateTime` de
`lib/format.ts`. **Correção:** usar `fmtDateTime`.

**[BAIXO] A6-4 — `Pillow` sem import direto + comentário enganoso em `requirements.txt`.**
`server/requirements.txt:13`: `Pillow~=12.2` não tem `import PIL` em nenhum `.py` (a imagem é montada por
base64 puro); entra como transitivo de `pdfplumber`. O comentário atribui a ele a descriptografia/split de
carnê, que é trabalho do `pypdf`. **Correção:** remover o pin explícito (confiar no transitivo) ou corrigir o
comentário mantendo o pin.

Confirmações OK: CVA variants todas consumidas; deps frontend/api/python todas com uso real (exceto Pillow);
**sem lógica CRUD duplicada entre Flask e Next** (o Flask só expõe ações de pipeline, o CRUD vive na Next API).

---

## 7. Cobertura de testes

Contratos de rota **100% cobertos**: os 21 `route.ts` têm `route.test.ts` co-locado (201/200/400/401/404/409/422);
service-level de 409 (FK/em-uso + código único) coberto nos `lib/*.test.ts`; pytest cobre `status_for_result`,
`_rfc822_from_fetch`, `compute_exit_code`, dedup de conteúdo e classificação forçada/doc_type.

### Achados (lacunas reais)

**[MÉDIO] A7-1 — `bulk status` e `loadMore` do DataGrid/Consulta sem teste.**
`DataGrid.test.tsx` cobre render/sort/rowClick/detalhe/virtualização/seleção+export, mas **não** o scroll
infinito (`onLoadMore`/`hasMore`) nem a barra de status em lote (`bulkStatusOptions`/`onBulkStatusChange`). Em
`Consulta.tsx`, nem `loadMore` (`:280`, guarda `loadingMoreRef`) nem `handleBulkStatusChange` (`:359` →
`setFinancialAccountStatusBulk`) são exercitados. São as duas ações-chave do `/consulta` (volume + ação em
massa). **Correção:** testar loadMore idempotente (guarda contra duplo-fire) e bulk status (PATCH `id=in.(…)`
+ update otimista).

**[BAIXO] A7-2 — `Dashboard.tsx` sem `*.a11y.test.tsx`** (única page de dados sem teste axe; viola regra 6).

**[BAIXO] A7-3 — `ResetPasswordForm.tsx` só tem a11y, sem teste funcional** (submit/validação/`updateUser`+`signOut`
não exercitados; assimétrico com Login/Forgot/ChangePassword).

**[BAIXO] A7-4 — `Erros.tsx` e `cobranca/CobrancaErros.tsx` só têm a11y, sem teste de página** (interação de
reprocessar/filtrar não testada; mitigado parcialmente pelo teste do organism `ResendErrosAction`).

**[BAIXO] A7-5 — dedup por `message_id` (`is_processed`, `read_emails.py:248`) sem pytest** (dedup de conteúdo
está bem coberta; falta o guarda de existência por message_id, stubável no padrão `FakeCtrl`).

---

## 8. Falsos positivos esperados (NÃO corrigir)

- **vulture — 7 rotas Flask** (`server/app.py` `health`, `cobranca_resend_*`, `read_emails_*`): funções
  decoradas `@app.get`/`@app.post`; o vulture não enxerga o registro via decorator.
- **ts-prune — `packages/shared`**: barrel sem prune por design (reportaria toda export pública como órfã).
- **Race no "código único" app-level** (cost-centers/banks/…): TOCTOU documentado como aceitável
  (`CLAUDE.md:219`, cadastros de baixíssima concorrência).
- **Soft vs hard delete / contas sem DELETE**: escopo documentado (`CLAUDE.md:276-277`).
- **`status_id` sem enum/range no schema**: proposital — é FK à dimensão `status`; valor inválido barrado pela FK.
- **`void load()` em effects de fetch-on-change** e **bail-out do React Compiler no `useReactTable`**: padrões
  aceitos no CLAUDE.md (§5 e §"React Compiler").
- **`manualChunks` como função no Vite 8**, **carve-out ESLint 9/10**: decisões documentadas.
- **`style={{}}` inline com valores dinâmicos** (larguras %, `conic-gradient` do donut): sem equivalente de
  classe estática.
- **`normalize_search`/`resolve_company_id` "sem definer"**: superado por redefinições posteriores (`010`).

---

## Plano de ataque priorizado (Fase 2)

| # | Sev | Achado | Esforço | Prompt |
|---|---|---|---|---|
| 1 | ALTO | A3-1 contraste `text-white`/`bg-brand` (Dashboard/Consulta) + guard | S | `03-frontend-design-a11y.md` |
| 2 | MÉDIO | A1-1 delete de grupo 409 (FK 058) | S | `01-next-api-cruds.md` |
| 3 | MÉDIO | A1-2 `users/route.ts` → `failFromError` | S | `01-next-api-cruds.md` |
| 4 | MÉDIO | A3-2 gradiente `btn-primary` contraste | S | `03-frontend-design-a11y.md` |
| 5 | MÉDIO | A3-3 KPIs de `Erros.tsx` → tokens `status-*` | S | `03-frontend-design-a11y.md` |
| 6 | MÉDIO | A6-1 formatadores duplicados `cobrancaColumns.ts` | S | `06-dead-code-deps.md` |
| 7 | MÉDIO | A7-1 testes loadMore + bulk status | M | `07-test-coverage.md` |
| 8 | BAIXO | A1-3/A1-4/A1-5 (23503 map, `.min`, matcher) | S | `01-next-api-cruds.md` |
| 9 | BAIXO | A2-1/A2-2 (filtro data, `new Date()`) | S | `02-frontend-grid-forms.md` |
| 10 | BAIXO | A3-4..8 (tokens órfãos, `text-[10px]`, aria-label, e2e Dashboard) | S | `03-frontend-design-a11y.md` |
| 11 | BAIXO | A4-1 IMAP nos reprocessadores | S | `04-python-pipeline.md` |
| 12 | BAIXO | A5-1/A5-2 (idempotência 055, seed grupo 1) | S | `05-sql-migrations.md` |
| 13 | BAIXO | A6-2/A6-3/A6-4 (export, fmtDt, Pillow) | S | `06-dead-code-deps.md` |
| 14 | BAIXO | A7-2..5 (a11y Dashboard, testes ResetPassword/Erros/is_processed) | M | `07-test-coverage.md` |

Nenhuma migration nova é obrigatória para o code review (A5-2 é a única candidata; se criada, numerar **072**
— mas coordene com a migration 072 de segurança para não colidir a numeração).
