# Relatório de Code Review — Gate de Produção (`pagamentos`)

> **Fase 1 — Diagnóstico.** Sessão read-only: nenhum arquivo de produção foi alterado.
> Branch `Features`. Data: 2026-06-26. Modelo: claude-opus-4-8 (1M).
> Fonte de verdade das convenções: `CLAUDE.md`. Decisões já documentadas não são bug.
> Todas as afirmações citam `arquivo:linha` verificado por leitura real.

---

## 0. Sumário executivo

**Veredito de produção: PASSA (com ressalvas de qualidade/escala).**

O **gate automatizado está 100% verde**: `lint`, `typecheck`, `test` (Vitest + pytest),
`prune` e `vulture` passam sem erro. **Nenhum achado BLOCKER ou CRÍTICO** em nenhuma das
cinco camadas. O único achado do `vulture` é uma variável morta cosmética
(`SUPPLIER_INPUT_FIELDS`). Os demais achados são melhorias de **escala, desperdício de
requisições, dívida de manutenção e robustez operacional** — nenhum impede o deploy, mas
vários valem corrigir cedo para o app ficar "à prova de falhas".

### Contagem por severidade

| Severidade | Total |
|---|---|
| BLOCKER | 0 |
| CRÍTICO | 0 |
| ALTO | 1 |
| MÉDIO | 16 |
| BAIXO | 14 |

### Área × severidade

| Área | BLOCKER | CRÍTICO | ALTO | MÉDIO | BAIXO |
|---|---|---|---|---|---|
| 1. Validações / cross-cutting | 0 | 0 | 0 | 0 | 2 |
| 2. Next API (CRUDs + infra) | 0 | 0 | 0 | 5 | 4 |
| 3. Frontend (Vite) | 0 | 0 | 0 | 6 | 3 |
| 4. Pipeline Python | 0 | 0 | 0 | 2 | 2 |
| 5. SQL / migrations | 0 | 0 | 1 | 3 | 3 |
| **Total** | **0** | **0** | **1** | **16** | **14** |

---

## 1. Resultado das validações

Executados na raiz do monorepo. Saída real resumida; logs completos no scratchpad da sessão.

| Comando | Exit | Resultado |
|---|---|---|
| `npm run lint` | **0** | Limpo nos 4 workspaces (frontend-vite, api-backend, portal-next, @sheild/shared). 0 erro / 0 warning. |
| `npm run typecheck` | **0** | `tsc --noEmit` limpo nos 4 workspaces. |
| `npm test` | **0** | Vitest: **493 testes** — api-backend 200 (34 arquivos) · frontend-vite 291 (90) · portal-next 2 (1). Todos passam. |
| `py -3 -m pytest tests/ -q` | **0** | **214 testes** passam em 6,47s. |
| `npm run prune` | **0** | ts-prune limpo nos 3 apps (0 órfãos). |
| `py -3 -m vulture server/ skills/ scripts/ --min-confidence 60` | **0** | 7 rotas Flask (falsos positivos conhecidos) **+ 1 achado real**: `SUPPLIER_INPUT_FIELDS` morto. |

**Saída do `vulture` (única não-FP em destaque):**

```
server\app.py:111,140,171,200,213,234,264   -> 7 rotas Flask (FALSO POSITIVO — decoradores @app.get/@app.post)
skills\email-reader\scripts\read_emails.py:784: unused variable 'SUPPLIER_INPUT_FIELDS' (60% confidence)   <-- REAL
```

**Conclusão da seção:** o gate definido no spec (lint + typecheck + test + prune + vulture
todos limpos) está atendido, à exceção de **uma** variável morta trivial — ver §6.1.
Esse achado **não** reprova o gate (vulture sai 0), mas a política `no-dead-code` pede a
remoção.

---

## 2. Auditoria dos CRUDs (Next API)

Revisados `apps/api-backend/lib/*.ts`, `app/api/**/route.ts`, `middleware.ts`, `lib/auth.ts`,
`lib/response.ts`, `lib/supabase-admin.ts` e os schemas Zod de `packages/shared`. Camadas
Repository → Service → Route, envelope `{success,...}`, status codes, dual-mode, delete,
write-back e isolamento de `service_role` foram conferidos contra os testes co-locados.

### suppliers — OK
`201` no create (`lib/suppliers.ts`/`route.ts:47`); `400` para sk não-positivo
(`[sk]/route.ts:13-17`); `23505`→`409` distinguindo CNPJ/CPF (`:188/209`); `404` (`:168/213`);
Zod→`422` (`:183/204`). **Soft delete** com bloqueio por contas vinculadas → `409` antes de
marcar `deleted_at` (`:226-238`) — preserva o fornecedor, conforme CLAUDE.md.
- **BAIXO** `lib/suppliers.ts:206` — no update, o mapeamento `23505`→`409` ocorre antes do
  check `!data`→`404`. Combinação inalcançável (uma linha inexistente não gera UNIQUE);
  apenas ordenação teórica, sem janela de corrupção.

### contas — 1 MÉDIO
`201` no create (`route.ts:45`); `400` id inválido (`[id]/route.ts:13-16`); **sem DELETE**
("remoção" = `PATCH status='cancelado'`, conforme regra de preservação). `23505`→`409`,
`404`, Zod→`422`. **Write-back** (`lib/contas.ts:125-133`) exatamente conforme spec: só quando
`sk && cc && ca` (sentinela 0 pula), em `try/catch` best-effort que loga e **não** derruba a
resposta, e só no caminho do service (a extração Python não chama `contaService`). Coberto por
`contas.test.ts:87-116`.
- **MÉDIO** `lib/contas.ts:174` (via `financial-account-control.schema.ts:238`) — o
  `financialAccountControlCreateSchema` **deixa `status` definível no create**. Um
  `POST /api/contas { sk_supplier, amount, status: 'pago' }` cria a conta já em estado fechado
  (`pago`/`cancelado`/`baixado`), curto-circuitando o ciclo `pendente`/trigger
  (`fn_set_status_from_due_date` só sobrescreve quando o status está em aberto). Não é crash
  nem falha de segurança, mas fura o ciclo de vida na borda do contrato. **Recomendação:** omitir
  `status` do schema de criação (como `status_id` já é omitido) se o lançamento manual deve
  sempre nascer `pendente`.
- **BAIXO** Chaves derivadas (`id`, `created_at`, `status_id`) enviadas no corpo são
  **descartadas** pelo Zod (sem `.strict()`), não rejeitadas — nunca chegam ao banco.
  Aceitável (rejeição efetiva por stripping).

### cost-centers — OK
Dual-mode correto (`route.ts:55`): `?page`→CRUD (`lib/cost-centers`), sem page→lookup
(`lib/lookups`, intocado). `201` (`:71`). **Sentinela id 0 protegido** em todo caminho
(`[id]/route.ts:15` + guards `:151/180/202`). **Hard delete** com as **3 FKs** verificadas
(`lib/cost-centers.ts:26` — `financial_account_control`, `financial_chart_of_account`,
`supplier`) → `409`; código único na app → `409` (`:231`). Confere com CLAUDE.md.

### banks — 1 MÉDIO
`201` (`route.ts:62`); `400` sentinela/parse; FK-em-uso (`financial_account`)→`409` (`:168`);
código único→`409` (`:180`); `404`.
- **MÉDIO** `lib/banks.ts:104` — no modo **lookup**, a rota pede `list({ limit: 1000 })`
  (`route.ts:11/35`), mas o service **clampa `MAX_LIMIT = 100`**. O `<select>` de bancos
  retorna no máximo 100 linhas (página 1), divergindo do contrato documentado de "lista
  completa". Invisível hoje (cadastro pequeno), mas trunca silenciosamente se ultrapassar 100.
  Os lookups que passam por `lib/lookups.ts` (cost-centers, chart-accounts) clampam em 1000 e
  **não** sofrem disso.
- **BAIXO** (documentado) `lib/banks.ts:131-135` — create grava `max(bank_id)+1` (PK não
  identity); corrida concorrente teórica, mitigada por `23505`→`409`. Aceita no comentário
  `:5` por baixíssima concorrência.

### financial-accounts — OK
Sem sentinela, sem FK reversa → hard delete livre com `404` quando ausente (`:142-148`),
conforme exceção documentada. `201` (`route.ts:47`). Violação de FK (`bank_id`/`status_id`,
`23503`)→`422` com mensagem por campo (`:61-68`) — correto (FK fornecida pelo cliente, não erro
de servidor). Sem modo lookup (correto — nada seleciona este cadastro).

### chart-accounts — OK
Dual-mode correto e **cascata intocada**: o caminho sem `page` vai para `chartAccountLookup.list`
(`lib/lookups.ts:78-96`), preservando filtro `costCenterId` + `is_postable` + array vazio sem
centro; `?page` vai para o CRUD. `201` (`:69`). Hard delete bloqueado pelas duas FKs
(`financial_account_control`, `supplier`)→`409`; sentinela→`409`/`404`.

### chart-account-groups — 1 MÉDIO
- **MÉDIO** `lib/chart-account-groups.ts:101` — mesmo cap de 100 do `banks`: lookup pede
  `{ limit: 1000 }` (`route.ts:10/34`) mas o service clampa `MAX_LIMIT = 100`. O `<select>` de
  grupos (no form de subgrupo) trunca em 100.
- OK no resto — dual-mode, `201`, delete bloqueado por subgrupos→`409` (`:159`), código
  único→`409`.

### chart-account-subgroups — 1 MÉDIO
- **MÉDIO** `lib/chart-account-subgroups.ts:116` — mesmo cap de 100: lookup `{ limit: 1000 }`
  vs clamp `MAX_LIMIT = 100`. O `<select>` de subgrupos (no form de plano de contas) trunca em 100.
- OK no resto — FK `chart_account_group_id` obrigatória (`23503`→`422`), delete bloqueado por
  `financial_chart_of_account`→`409`.

### users / auth — OK
`POST /api/users` sem `requireAuth` local mas **coberto pelo matcher** (admin-only, sem
auto-registro): Zod→`422`, e-mail duplicado→`409`, `data.user` ausente→`500`; nunca devolve
`password_hash`. `POST /api/auth/login` é a exceção pública documentada, usa o cliente **anon**
(`lib/users.ts:67`), `401` genérico em credencial inválida (sem vazar campo). `GET /api/users/me`
valida token e `401` defensivo.
- **BAIXO** `lib/users.ts:90` — a resposta ecoa `name` do request, não do registro persistido.
  Inócuo (idênticos na criação).

### Infra / middleware — 1 MÉDIO
- **OK matcher** `middleware.ts:19` — `'/api/((?!health|auth/login).*)'` deixa públicos apenas
  `/api/health` e `/api/auth/login`; todo CRUD/lookup é gateado, com `requireAuth` redundante
  por handler (defesa em profundidade).
- **OK isolamento de service_role** — `getSupabaseAdmin()` (`supabase-admin.ts:14`) só é
  importado por módulos server `lib/*`; nunca alcançável em caminho público (login/me usam só o
  cliente anon). A chave service_role nunca é serializada em nenhum envelope.
- **OK mapeamento de erro de auth** — `requireAuth` (`auth.ts:54-65`): token ausente/inválido→
  `401`, falha de rede na validação→`500`. `getUser` usa a chave anon (`auth.ts:38`).
- **MÉDIO** Leituras Supabase falhas devolvem `500` em todos os services (ex.: `contas.ts:153`,
  `suppliers.ts:154`). Correto para falha de infra real, **mas** os filtros de busca interpolam
  o termo do usuário direto na string `or()` do PostgREST (`contas.ts:79/100`, `suppliers.ts:81`,
  `cost-centers.ts:73`…). `sanitizeTerm` remove `% , ( )` (cobre os metacaracteres de `or`), então
  **não é vetor de injeção**; ainda assim, um termo com token tipo-operador remanescente pode gerar
  filtro malformado → erro PostgREST → `500` em vez de resultado vazio limpo. Baixa probabilidade;
  robustez, não segurança.
- **OK parsing de corpo** — todo POST/PATCH envolve `req.json()` em try/catch com default `{}`
  (depois Zod → `422`); corpo malformado nunca vira `500` não tratado.

---

## 3. Frontend — qualidade e desperdício (`apps/frontend-vite`)

Revisados serviços, hooks, contexts, `DataGrid`, forms, molecules e páginas. As decisões
documentadas (React Compiler transform, `void load()`, debounce form-vs-applied, virtualização
spacer-row, auto-heal do `scrollRect`, `__select__` fora das prefs, flag `EMAIL_READER_ENABLED`)
foram verificadas como **corretas** e não reportadas como bug.

### Requisições / Performance
- **MÉDIO** `services/supabase.ts:168-189` (`getEmailStats`) — dispara **7 requisições** REST
  paralelas (1 total + 6 por status) só para contar; como `/emails` faz
  `Promise.all([getEmailControl, getEmailStats])` a cada `load` (mudança de filtro + a cada 5
  ticks do poll de leitura), são **8 requests por refresh**. Um único `select=status` contado no
  cliente (como `getProcessingErrorStats` já faz em `:431`) resolveria em 1 request. N+1 evitável.
- **MÉDIO** `services/supabase.ts:598,606` (`getDashboardData`) — duas leituras independentes
  (`monthRows`, `yearRows`) em `await` sequencial; `Promise.all` cortaria a latência do Dashboard
  pela metade.
- **MÉDIO** `services/supabase.ts:493-499` (`getFinancialStats`) e `getEmailStats` — usam
  `limit: 1000/2000` para "contar" no cliente; se a base crescer além do teto, os KPIs
  subnotificam **silenciosamente**. Fragilidade de escala (o `count=exact` por header já usado nas
  listagens seria mais correto).
- **BAIXO** `pages/Emails.tsx:136-144` — o effect de `getInvoiceNumbersByMessageIds` depende de
  `[rows]`; toda atualização da tabela refaz o lote (até 1000 ids em chunks de 50). Durante a
  leitura IMAP (grid recarregado a cada ~7,5s) repete o lote inteiro. Tem guarda `active` contra
  resposta obsoleta, mas sem cache por id. Maior fonte de requests repetidos da página.
- **OK** Debounce form-vs-applied corretamente cabeado (`Consulta.tsx:257-264`,
  `Emails.tsx:126-130`, `SuppliersPage.tsx:62-69`, `CrudTablePage.tsx:91-98`, com guarda
  `if (form === aplicado) return` + cleanup). Guarda de `loadMore` concorrente presente
  (`Consulta.tsx:206-208`, `DataGrid.tsx:636-639` via `loadingMoreRef`/`loadingMore`).

### Código morto / redundância
- **MÉDIO** Formatters **duplicados** entre `pages/Consulta.tsx:40-56` e
  `hooks/useGridColumns.ts:47-71`: `fmtDate`, `fmtMoney`, `fmtCnpj`, `fmtCostCenter`,
  `fmtChartAccount` têm cópias idênticas (o próprio `useGridColumns.ts:45-46` admite "cópia de
  Consulta.tsx"); `fmtDateTime` duplica o `fmt` de `Emails.tsx:18-27`. Risco de drift — extrair
  para `src/lib`.
- **OK** `__select__` injetado na ordem/fixação efetivas mas nunca gravado nas prefs
  (`DataGrid.tsx:151-158,789`). `prefillNonce` (`ContaForm.tsx`) é necessário (os selects
  inicializam `selected` uma vez; o remonte por `key` reflete o pré-preenchimento).

### React Compiler
- **MÉDIO** `useMemo` manuais redundantes com o transform ativo (`vite.config.ts:18`):
  `Consulta.tsx:349-352` (colunas), `Emails.tsx:322` (colunas), vários em `DataGrid.tsx:322-389`.
  Não causam bug (corretos), mas são a memoização manual que a base pede para remover.
  **Ressalva:** alguns alimentam `useReactTable` (lib em que o compiler dá "bail out" seguro,
  `DataGrid.tsx:393`) e podem ser defensivos — remover só com teste, diferenciando os próximos do
  TanStack.
- **OK** Impureza isolada fora do render: `next7DaysRange()` (`Consulta.tsx:73-78`) e `todayISO()`
  (`ContaForm.tsx:50-55`) são funções de módulo, não chamadas no escopo de render. Sem
  set-state-in-effect indevido.

### Tailwind v4
- **BAIXO** (aceito) `pages/Dashboard.tsx:27-28` — `prorrogado: '#7c3aed'` e `baixado: '#0e7490'`
  são hex hardcoded num mapa semântico de status (donut). As demais entradas usam
  `var(--color-status-*)`; estas duas não têm token equivalente no `@theme` e o arquivo declara a
  exceção no cabeçalho. Única cor semântica fora de token — dívida (criar `status-*` para
  prorrogado/baixado), não bloqueia.
- **OK** Sem concatenação de classe quebrando o JIT (`CARD_TONE`, ternários de `Consulta.tsx` usam
  strings literais completas). `style` inline só onde não há classe (largura de barra, offsets
  sticky, spacers).

### DataGrid
- **OK** `measureElement` em todas as linhas reais incl. detalhe (`DataGrid.tsx:718,726-732`);
  spacers sem `ref` (correto). `gridId` consistente (`consulta`/`emails`),
  `STORAGE_VERSION='v3'` com `purgeOldVersions(['v1','v2'])` (`useGridPreferences.ts:22-30`).
  Auto-heal do `scrollRect` presente e guardado contra altura 0 (`DataGrid.tsx:598-631`).
- **BAIXO** `DataGrid.tsx:636-639` — o effect de scroll infinito dispara por **índice de item
  virtual** (que inclui `second`/`detail`), não por índice de linha de dado; em lista curta com
  detalhe aberto pode alcançar o "fim" um item antes. Guarda `loadingMore`+`hasMore` cobre o
  disparo duplo — robusto, apenas anotado.

### Acessibilidade
- **OK** Todos os controles de filtro têm `id`+`name`+`aria-label` (`Consulta.tsx:597-656`,
  `Emails.tsx:499-541`, `SuppliersPage.tsx:155-163`, `CrudTablePage.tsx:182-191`); botões só-ícone
  com `aria-label`; react-select com `inputId`+`aria-label`+`aria-invalid`; `<dialog>` nativo com
  `aria-label`+`onCancel`.
- **MÉDIO (verificar em navegador)** `pages/Consulta.tsx:564,587` — cards usam `text-slate-500`
  (~4,7:1 sobre branco) para número/label; passa AA por pouco (números são `text-lg`/`text-xl` →
  AA grande ≥3:1; label `text-xs` ≈ limite). É o par de menor margem da página. jsdom não avalia
  contraste — quem trava isso é `tests/contrast-usage.a11y.test.ts` + a camada `e2e/`. Sem achado
  novo além do que esses guards cobrem; **rodar a camada Playwright na máquina/CI** para confirmar.

---

## 4. Pipeline Python — robustez (não-regressão)

### As 8 proteções do CLAUDE.md — todas íntegras
| # | Proteção | Verificado em |
|---|---|---|
| a | Extração **IN-PROCESS** (`extract_pdf.extract_to_csv`) — **zero `subprocess`** (grep confirmou; só comentários/nome de teste) | `read_emails.py:1689-1692`, `extract_pdf.py:937` |
| b | IMAP socket timeout | `read_emails.py:2244` (const `:2225`) |
| c | IMAP connect/search retry+backoff (transitório repete, erro de protocolo não) | `read_emails.py:2261-2297` → 502 em `app.py:228` |
| d | Claude API timeout nos **3** clientes `anthropic.Anthropic` | `extract_pdf.py:462,590,614` (const `:45`) |
| e | `_rfc822_from_fetch` robusto — sem `data[0][1]` direto | `read_emails.py:2058-2071` (usado `:2083,2398`) |
| f | Dedup por `message_id` (`ignore-duplicates`) | `read_emails.py:201,494,2410` |
| g | Dedup por `sk_supplier` + `_finalize_supplier` **antes** do INSERT | `read_emails.py:885-898,1825,1840` |
| h | Bloqueio de e-mail de domínio interno | guarda **SQL** (RPC `resolve_supplier_id`, migration 046) — o Python cumpre não transformando `sender_email` em nome antes da busca (`read_emails.py:1319-1328`) |

`status_for_result` (cadeia de prioridade, `read_emails.py:2011-2055`), prioridade
**anexo→link→corpo** (`:2119/2123/2163`) e classificação de doc_type (utilities/honorários/NF-e
pura) estão corretos e batem com os testes. Cobrança: `compute_exit_code` separa DADO de
OPERACIONAL (`run.py:81-93`); `main()` **retorna** o código (`:346`, `sys.exit(main())` em
`:354`); reuso de `SmtpSession` com `finally` (`run.py:248-270`); catch de queda usa
`(SMTPServerDisconnected, ConnectionError, TimeoutError)`, **não** `OSError`
(`email_sender.py:174-179`); Cc não enviado se o To falhar (`:102-110`). Todos **OK**.

### Achados
- **MÉDIO** `read_emails.py:2366-2457` — `mail.logout()` (`:2457`) **não** está em `finally`. Se
  uma exceção não-`ApiUnavailableError` escapar do loop principal, a conexão IMAP não é fechada
  explicitamente. Mitigantes: `process_message` engole suas exceções (`:2205`),
  `ApiUnavailableError` faz `break`, socket tem timeout. Risco real baixo; ficaria mais robusto
  com `try/finally` (como já feito em `reprocess_ignored_emails.py:137-141`). Não é regressão.
- **MÉDIO (configuração, não código)** `email_sender.py:57` (`_load_smtp_config`) — prioriza
  `SMTP_*` sobre `IMAP_*` corretamente; o risco é o `.env` de **produção**
  (`C:\Sheild\API\Pagamentos\.env`) precisar receber as 4 linhas `SMTP_*` do relay transacional
  manualmente — sem elas, cai no fallback IMAP `email-ssl.com.br` com o gargalo `451`. O código
  está correto.
- **BAIXO** Scripts manuais de reprocess ainda usam `md[0][1]` direto
  (`reprocess_link_emails.py:117`, `reprocess_body_emails.py:59`) — ferramentas offline fora do
  pipeline servido; mesma classe que `_rfc822_from_fetch` resolve, risco baixo.
- **BAIXO** `except` silenciosos sem log são **cosméticos e por design** (reconfigure de
  stdout, decode de parte MIME defeituosa, callback de progresso, `close()` de SMTP). Toda falha
  de **gravação** loga e/ou registra em `email_processing_errors`. Nenhum `except: pass` sobre
  fluxo crítico. Loops todos limitados (links cortados em 10, download em 50 MB, reenvio em
  `MAX_IDS=500`). Um e-mail/título ruim não derruba o lote
  (`read_emails.py:2205-2208`, `run.py:160`).

---

## 5. SQL / migrations (`supabase/migrations/001→054`)

### RLS por tabela
Todas as tabelas com RLS habilitado têm **ao menos uma policy** — nenhum default-deny
remanescente (os dois casos históricos, `supplier` e os cadastros de classificação, foram
fechados em 029 e 049). Leituras `TO authenticated`, escritas `TO service_role`.

| Tabela | Policies | Leitura | Escrita | Status |
|---|---|---|---|---|
| `email_control` | select (015/019) + update `reviewed_at` (030) | authenticated | service_role + col `reviewed_at` | OK |
| `email_processing_errors` | service_role full + authenticated read (012) | authenticated | service_role | OK |
| `financial_account_control` | select (018) + update flags (033) + update `status` (036) | authenticated | service_role + cols `has_invoice/has_bank_slip/status` | OK (ver RLS-1) |
| `supplier` | `authenticated_select` (029) | authenticated | service_role (SECURITY DEFINER) | OK |
| `status` (dimensão) | authenticated read (036) | authenticated | service_role | OK |
| `cobranca_envios_log` / `cobranca_erros_log` | service_role full + authenticated read (037) | authenticated | service_role | OK |
| `financial_cost_center` / `financial_chart_of_account` | authenticated read (049) | authenticated | service_role | OK |
| `storage.objects` (`attachments`) | authenticated read (021) | authenticated | service_role | OK |

- **MÉDIO (RLS-1)** `036:19` — além das 3 colunas documentadas (`reviewed_at`,
  `has_invoice`/`has_bank_slip`), o papel `authenticated` recebe `GRANT UPDATE (status)` em
  `financial_account_control` (alinhado à edição inline de situação no grid). **Não é vazamento**
  (restrito por coluna + RLS), mas o CLAUDE.md cita 3 colunas — atualizar a doc para **3 colunas
  de curadoria + a coluna `status`**.
- **BAIXO (RLS-2)** As policies de UPDATE usam `USING (true) WITH CHECK (true)`; a contenção real
  é o `REVOKE UPDATE; GRANT UPDATE (col)`. Correto hoje; só registrar a dependência.
- **Verificação recomendada:** `company`, `financial_account` e os cadastros de Tabelas são
  **pré-existentes** (sem `CREATE TABLE`/`ENABLE RLS` nas migrations). Confirmar no banco que não
  estão em RLS default-deny silencioso (mesma classe dos bugs pré-029/pré-049). O frontend lê via
  `/data-api` (service_role), então a ausência de policy não quebra o fluxo atual.

### CHECK ↔ z.enum — todos 1:1
| Domínio | CHECK | z.enum | Resultado |
|---|---|---|---|
| `document_type` | 043 (28 valores, `lower()`) | `DOCUMENT_TYPES` (28) | **1:1 OK** |
| `extraction_source` | 018 (4) | `EXTRACTION_SOURCES` (4) | **1:1 OK** |
| `payment_method` | 018 (15) | `PAYMENT_METHODS` (15) | **1:1 OK** |
| `financial_account_control.status` | 035 (10) | `ACCOUNT_STATUSES` (10) | **1:1 OK** |
| `email_control.status` | 031 (6) | `EMAIL_CONTROL_STATUSES` (6) | **1:1 OK** |

`error_type` (012 / `cobranca_erros_log` 037) é `TEXT` livre sem CHECK — `z.string()`
deliberado, sem domínio a cruzar.

### FKs / sentinela
Todas as FKs corretas; sentinela id 0 coberto por `DEFAULT 0 NOT NULL` nas 4 FKs de
classificação (047/048/052), com a linha id 0 existindo nos cadastros.
- **BAIXO (FK-1)** `047:18` — comentário diz "ON DELETE RESTRICT" mas o DDL não declara
  `ON DELETE` (fica `NO ACTION`). Efeito de bloquear delete de cadastro em uso é **equivalente**
  (sem deferição configurada) + o backend bloqueia com 409. Só divergência comentário↔DDL.

### Triggers
`fn_set_status_from_due_date` (034/035) só sobrescreve `status` quando em aberto — **preserva
baixas manuais** (`pago`/`cancelado`/`baixado`). Trigger de espelho `trg_supplier_mirror_id` (042)
só grava `supplier_id := sk_supplier` quando NULL. Trigger de resolução antigo
(`trg_fe_resolve_supplier`) corretamente **dropado** em 041. Todos **OK**.
- **MÉDIO (TRG-1)** `039:32,47` — o backfill faz `DISABLE/ENABLE TRIGGER trg_fe_supplier_id`; se a
  039 for **re-executada** isoladamente após a 041 (que dropa esse trigger), falha com "trigger
  does not exist". Sem impacto na ordem normal 001→054 (uma vez); só em re-run pontual.

### Ordem / idempotência
Numeração **001→054 contígua**, sem gaps nem duplicatas; dependências respeitam a ordem
ascendente.
- **ALTO (ORD-1)** Várias migrations **falham se reaplicadas** (sem `IF NOT EXISTS` no ponto
  crítico): `050:25`, `051:28-58` (`ADD GENERATED ALWAYS AS IDENTITY`), `042:64` (`ADD PRIMARY
  KEY`), `053:11-13` (`ADD CONSTRAINT fk_financial_account_status` sem bloco `DO`, diferente de
  035:65-75 que protege). **Falha de forma segura** (erro, não corrupção) e só importa em **re-run
  acidental** no SQL Editor — o modelo documentado é "aplicar uma vez, em ordem". Marcado ALTO
  para não esconder o risco operacional; **mitigação:** garantir aplicação estritamente
  uma-vez-por-migration.
- **MÉDIO (ORD-2)** As migrations **não bootstrapam um banco vazio**: dependem de objetos
  pré-existentes nunca criados nelas (`supplier`, `company`, `status`, `financial_account`,
  `financial_bank`, `financial_cost_center`, `financial_chart_of_account(_group/_subgroup)`, e a
  função `normalize_search()` usada já em 007:49). Num ambiente novo, aplicar 001→054 do zero
  falha. Coerente com CLAUDE.md (ambiente compartilhado), mas exige dump dos cadastros +
  `normalize_search` antes da 001.
- **BAIXO (ORD-3)** `034:31` referencia estados (`não pago`/`pago protesto`/`pago cartório`) que
  só somem na 035 — comentário/comparação desatualizada, sem falha.

---

## 6. Código morto, redundância e dependências (cross-cutting)

### 6.1 `SUPPLIER_INPUT_FIELDS` — BAIXO (remover)
`skills/email-reader/scripts/read_emails.py:784` define
`SUPPLIER_INPUT_FIELDS = ("supplier_name", "supplier_cnpj", "supplier_cpf")`. Grep no repo
inteiro retorna **só essa linha** — zero referências. Resíduo das colunas denormalizadas que
`_finalize_supplier` removeu (migrations 040/041/042); as tuplas irmãs (`FINANCIAL_VALUE_FIELDS`,
`SKIP_ACCOUNT_TYPES`) **são** usadas. Classificação: **remover** (política `no-dead-code`).
Único achado real do `vulture`.

### 6.2 Dependências não usadas
- **BAIXO** `server/requirements.txt:13` — **`pypdf~=6.13`** não é importado em nenhum `.py`
  (só comentário + `SKILL.md`) e **não** é transitivo de `pdfplumber` (que requer
  `pdfminer.six`, `Pillow`, `pypdfium2`). Candidato a remoção — **confirmar com o usuário** (pode
  estar reservado para merge de PDF planejado).
- **INFO/manter** `Pillow~=12.2` — não importado diretamente, mas é **transitivo de
  `pdfplumber`**; o pin explícito `~=` é intencional (evitar divergência dev/prod). **Manter.**
- **OK** Todas as deps de runtime JS/TS (frontend-vite, api-backend, portal-next, shared)
  resolvem para imports reais. Nenhuma dep faltando (todo import tem declaração ou transitivo).

### 6.3 Build-time (esperado — não sinalizar)
ESLint (`typescript-eslint`, `eslint-plugin-react-hooks/refresh`, `eslint-config-next` — carve-out
9/10), React Compiler (`@rolldown/plugin-babel`, `@babel/core`, `babel-plugin-react-compiler`),
Tailwind v4 (`@tailwindcss/postcss`), teste/a11y (`vitest`, `jsdom`, `@testing-library/*`,
`jest-axe`, `@playwright/test`, `@axe-core/playwright`), tipos (`@types/*`), `ts-prune`,
`concurrently`. Usados pelo build/lint/test mesmo sem `import` em src.

### 6.4 Duplicação de lógica — OK
O split Python (extração) × Next TS (CRUD) é **intencional** (CLAUDE.md). Os domínios de enum
(document_type, payment_method, status, strip de CNPJ/CPF) aparecem em Zod + CHECK SQL +
constantes Python, mas é **espelhamento de contrato documentado e mantido** ("alterar o CHECK →
atualizar o enum"), não drift acidental. A única duplicação de drift-risk **dentro de uma camada**
são os formatters frontend (§3, MÉDIO).

### 6.5 Arquivos órfãos — OK
Spot-check limpo: os 5 `scripts/*.py` são entry-points de manutenção documentados; `lib/*.ts`
backam rotas reais; `e2e/*.ts` cabeados ao `@axe-core/playwright`; `types/tanstack-table.d.ts` é
augmentation ambiente. Nenhum arquivo não-importado/não-rodado encontrado.

---

## 7. Plano de ataque priorizado

Ordenado por severidade. Esforço: **S** (pontual) · **M** (médio) · **L** (amplo).
A coluna "Prompt XML" indica a área da Fase 2 a que o item pertence.

| # | Sev | Item | Arquivo | Esforço | Prompt XML |
|---|---|---|---|---|---|
| 1 | ALTO | Migrations não re-executáveis — confirmar aplicação uma-vez ou guardar com `IF NOT EXISTS`/`DO` | `050/051/042/053` | M | `fix-sql` |
| 2 | MÉDIO | `status` definível no `POST /api/contas` — omitir do create schema | `financial-account-control.schema.ts:238`, `lib/contas.ts:174` | S | `fix-api` |
| 3 | MÉDIO | Lookup cap de 100 (banks/groups/subgroups) — alinhar limite do lookup | `lib/banks.ts:104`, `chart-account-groups.ts:101`, `chart-account-subgroups.ts:116` | S | `fix-api` |
| 4 | MÉDIO | `getEmailStats` 8 requests/refresh → 1 query contada no cliente | `services/supabase.ts:168` | M | `fix-frontend` |
| 5 | MÉDIO | `getDashboardData` awaits sequenciais → `Promise.all` | `services/supabase.ts:598,606` | S | `fix-frontend` |
| 6 | MÉDIO | KPIs com `limit:1000/2000` — usar `count=exact` (escala) | `services/supabase.ts:493,168` | M | `fix-frontend` |
| 7 | MÉDIO | Formatters duplicados Consulta↔useGridColumns → extrair p/ `src/lib` | `Consulta.tsx:40`, `useGridColumns.ts:47` | M | `fix-frontend` |
| 8 | MÉDIO | `useMemo` manuais redundantes (React Compiler) — remover com teste | `Consulta.tsx:349`, `Emails.tsx:322`, `DataGrid.tsx:322` | M | `fix-frontend` |
| 9 | MÉDIO | `mail.logout()` fora de `finally` em `run_reader` | `read_emails.py:2457` | S | `fix-python` |
| 10 | MÉDIO | `.env` SMTP transacional em produção (config, não código) | `C:\Sheild\API\Pagamentos\.env` | S | (operacional) |
| 11 | MÉDIO | RLS-1: documentar `status` como 4ª coluna gravável | doc CLAUDE.md + `036:19` | S | `fix-sql`/docs |
| 12 | MÉDIO | TRG-1: 039 não idempotente após 041 | `039:32,47` | S | `fix-sql` |
| 13 | MÉDIO | ORD-2: bootstrap de banco vazio depende de cadastros pré-existentes | migrations | M | `fix-sql`/docs |
| 14 | MÉDIO | Contraste dos cards `/consulta` — validar na camada Playwright | `Consulta.tsx:564` | S | `fix-frontend` |
| 15 | MÉDIO | `500` em filtro de busca malformado (robustez, não injeção) | `lib/contas.ts:79`, etc. | S | `fix-api` |
| 16 | BAIXO | Remover `SUPPLIER_INPUT_FIELDS` morto | `read_emails.py:784` | S | `fix-python` |
| 17 | BAIXO | `pypdf` dep não usada — confirmar e remover | `server/requirements.txt:13` | S | `fix-python` |
| 18 | BAIXO | Tokens `status-*` para `prorrogado`/`baixado` (Dashboard hex) | `Dashboard.tsx:27` | S | `fix-frontend` |
| 19 | BAIXO | FK-1, ORD-3, RLS-2, Zod-strip, name-echo, loadMore-index, data[0][1]-reprocess | vários | S | conforme área |

**Sequência recomendada:** começar pelos MÉDIO de API (#2, #3 — pontuais, alto valor de
contrato) e frontend de requisições (#4, #5 — ganho de performance imediato), depois a higiene
(#16, #17), e tratar os itens de SQL (#1, #11–#13) como **revisão/documentação operacional** já
que não há corrupção no fluxo normal.

---

## 8. Falsos positivos esperados (NÃO corrigir)

- **vulture — 7 rotas Flask** (`server/app.py:111,140,171,200,213,234,264`): decoradas
  `@app.get`/`@app.post`, chamadas pelo Flask, não "unused".
- **ts-prune no `packages/shared`**: barrel de biblioteca; toda export pública pareceria órfã.
  Cobertura real vem do `prune` dos apps consumidores (CLAUDE.md). Exports com
  `ts-prune-ignore-next` (`getSupabaseAdmin`, `ApiResponse`, `ReaderSummary`,
  `parsePaginationTotal`…) são intencionais.
- **React Compiler "bail out" no `useReactTable`** (`DataGrid.tsx:393`): incompatível por design;
  o disable `react-hooks/incompatible-library` é correto.
- **`Pillow` "não importada"**: transitiva de `pdfplumber`, pin intencional — manter.
- **Espelhamento enum Zod ↔ CHECK SQL ↔ constante Python**: contrato mantido de propósito, não
  duplicação acidental.
- **Decisões documentadas**: extração in-process, `manualChunks` como função, carve-out ESLint
  9/10, dual-mode dos lookups, `cancelado` no grid mas fora dos KPIs, `__select__` fora das prefs,
  `prefillNonce`, flag `EMAIL_READER_ENABLED`, `bank_id = max+1`, soft-vs-hard delete por recurso,
  hex de `prorrogado`/`baixado` sem token (exceção declarada no arquivo).

---

*Fim da Fase 1 (diagnóstico). Nenhum arquivo de produção foi alterado nesta sessão.*
