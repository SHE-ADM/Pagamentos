# RELATÓRIO DE AUDITORIA DE SEGURANÇA — pré-produção (`pagamentos`)

> Data: 2026-07-08 · Branch: `Features` · Modelo: claude-opus-4-8 (1M) · Migrations no repo: 001→071
> Spec seguida: `docs/prompts/auditoria-seguranca-spec.md` (ajustada para 001→071; migration nova a partir de **072**).
> Sessão READ-ONLY no código de produção — só este relatório + `docs/review/seguranca/prompts/*` foram escritos.
> Nenhum segredo real transcrito — apenas nomes de variáveis.

Modelo de ameaça avaliado: (a) usuário autenticado malicioso escalando privilégio; (b) atacante externo sem
login na superfície pública; (c) conteúdo HOSTIL entrando pelo pipeline (e-mail/PDF/link de remetente desconhecido).

---

## Sumário e veredito

**Veredito de produção (atualizado na Fase 2, 2026-07-08): PASSA.** O único bloqueador — **S2-1** (ALTO,
escalonamento de privilégio via RPCs `SECURITY DEFINER` de fornecedor expostas ao `authenticated`/`anon`) —
foi **fechado**: a **migration 072** (`REVOKE EXECUTE`) foi **aplicada no projeto `Financeiro`** em
2026-07-08, o ACL das 6 funções foi verificado (`{postgres=X, service_role=X}` apenas) e o vetor foi testado
via REST (`anon` → `42501 permission denied`; `service_role` segue executando). Não há CRÍTICO. Todos os
achados MÉDIO e BAIXO também foram aplicados na Fase 2 (ver "Status de aplicação" abaixo); restam apenas
INFO aceitos/operacionais. A postura confirmada na Fase 1 permanece: SSRF, injeção SMTP/CRLF, XSS, RLS por
coluna, isolamento da `service_role` e envelope de erro **corretamente implementados**.

### Status de aplicação (Fase 2 — 2026-07-08, branch `Features`)

| Achado(s) | Commit / ação |
|---|---|
| **S2-1** (ALTO, bloqueador) | Migration **072** aplicada no banco (ACL verificado; anon→42501) — arquivo versionado |
| S1-1/S1-2/S1-3/S1-4 | `898e76f` (marca em `app_metadata` + endpoint admin + matcher ancorado + docs) |
| S3-1/S3-2 | `52f6c67` (timeout 504 na ponte + schemas manuais sem colunas de pipeline) |
| S4-1/S4-2/S4-3/S4-4 | `787c677` (pin de IP anti-rebinding, token Flask obrigatório fora de loopback, IPv4-mapeado, From sanitizado) |
| S5-1/S5-2 | `8774cd8` (sandbox no iframe do PDF + CSP; header validado no preview da Vercel) |
| S6-1 | `6ce978a` (next 16.2.10 + override postcss ≥8.5.10 — `npm audit --omit=dev` 0) |
| S2-2 | Migration **073** aplicada (policy RESTRICTIVE de no-DELETE no bucket) — `52f6c67` |
| INFO aceitos | `VITE_IMAP_USER` (e-mail), `normalize_search` não versionada (bootstrap), RLS condicional da 056 (checklist), deps Python menores sem CVE |

### Contagem por severidade

| Severidade | Qtde |
|---|---|
| CRÍTICO | 0 |
| ALTO | 1 |
| MÉDIO | 6 |
| BAIXO | 9 |
| INFO | 7 |

### Achados por área

| Área | CRÍTICO | ALTO | MÉDIO | BAIXO | Prompt |
|---|---|---|---|---|---|
| S1 AuthN/Z | 0 | 0 | 2 | 2 | `S1-authz-middleware.md` |
| S2 RLS/banco | 0 | 1 | 0 | 1 | `S2-rls-banco.md` |
| S3 Next API | 0 | 0 | 0 | 2 | `S3-api-idor-massassign.md` |
| S4 Python hostil | 0 | 0 | 2 | 2 | `S4-python-ssrf-injection.md` |
| S5 Frontend/XSS | 0 | 0 | 1 | 1 | `S5-frontend-xss-config.md` |
| S6 Segredos/deps | 0 | 0 | 1 | 1 | `S6-segredos-deps.md` |

---

## 1. AuthN/AuthZ (Supabase Auth)

**Confirmações positivas:** token validado com chave **ANON** (`lib/auth.ts:20-30,42-46`), nunca service_role;
401/500 corretos; `requireAdmin` lê papel de `app_metadata.role` (server-controlled) com **403** para
não-admin (`lib/auth.ts:75-94`); `POST /api/users` atrás de `requireAdmin`; **sem `signUp` no frontend**
(cadastro admin-only); `POST /api/auth/login` público sem enumeração (mensagem genérica); `requireAdminGroup`
resolve `group_id` via service_role e convive corretamente com `requireAdmin`; perfil nunca expõe `password_hash`.

### Achados

**[MÉDIO] S1-1 — Troca obrigatória de senha é burlável e nunca imposta no servidor.**
- **arquivo:linha:** `ChangePasswordForm.tsx:38-41`, `packages/shared/src/schemas/auth.schema.ts:52-55`, `ProtectedRoute.tsx:20`
- **vetor:** o gate `mustChangePassword` lê `user_metadata.password_changed`, campo **gravável pelo próprio
  cliente**; o usuário pode marcar `password_changed: true` sem trocar a senha, ou ignorar a SPA e usar o
  `access_token` direto contra a Next API (que só exige `requireAuth`, nunca checa `password_changed`).
- **pré-condição:** possuir a senha temporária definida pelo admin.
- **impacto:** o controle documentado como "troca obrigatória" é cosmético; o usuário segue operando com a
  senha conhecida pelo admin. Divergência desenho×implementação.
- **correção mínima:** marcar `password_changed` em `app_metadata` (server-controlled) via Admin API após
  confirmar a troca, ou um endpoint próprio no backend; nunca confiar em `user_metadata` para autorização.

**[MÉDIO] S1-2 — `access_token` em `localStorage` quando "Lembrar-me" marcado (exposição a XSS).**
- **arquivo:linha:** `lib/supabaseClient.ts:21-27`, `lib/authStorage.ts:33-48`
- **vetor:** com `remember=on` o token persiste em `localStorage`, legível por qualquer script injetado.
- **pré-condição:** existir um vetor de XSS. **S5 confirmou que hoje NÃO há XSS reproduzível** — logo não é
  explorável no estado atual; a severidade é MÉDIO porque eleva o impacto de *qualquer* XSS futuro a takeover
  total de sessão.
- **impacto:** sequestro de sessão completo se surgir XSS.
- **correção mínima:** CSP estrita (ver S5-2) + expiração curta de token; se o modelo exigir, migrar a sessão
  para cookie `HttpOnly` (muda a arquitetura de auth). Contido hoje pela ausência de XSS + idle 10 min.

**[BAIXO] S1-3 — Matcher do middleware sem âncora de segmento.**
- **arquivo:linha:** `apps/api-backend/middleware.ts:19` (`'/api/((?!health|auth/login).*)'`)
- **vetor:** rota futura com prefixo `health`/`auth/login` (ex.: `/api/health-internal`) ficaria pública sem
  guard. Hoje sem bypass explorável (só existem `/api/health` e `/api/auth/login`).
- **correção mínima:** ancorar por fim de segmento: `'/api/(?!health$|auth/login$).*'`. *Cross-ref: code review A1-5.*

**[BAIXO] S1-4 — Teto de inatividade (10 min) só client-side e "esquecível".**
- **arquivo:linha:** `useIdleLogout.ts:18-20,24-26`, `AuthContext.tsx:86-93`
- **vetor:** apagando a chave `pag:last-activity` do localStorage (mantendo o token), `isIdleExpired` volta
  `false` e a sessão é restaurada; o token segue válido no servidor até a expiração real do Supabase.
- **impacto:** o "teto de 10 min" é advisory, não fronteira de autorização.
- **correção mínima:** aceitar como UX + encurtar `expires_in` do JWT / revogar refresh token no logout.

> INFO: `VITE_SESSION_IDLE_MINUTES` sem teto máximo (`AuthContext.tsx:57`) — não é atacante-controlável (env de
> build), mas pode elevar o "teto de 10 min"; considerar `Math.min(valor, 10)`. Restauração otimista de sessão
> em falha de rede (`AuthContext.tsx:108-112`) é deliberada e razoável.

---

## 2. RLS e privilégio no banco

**Confirmações positivas:** RLS habilitada **com ≥1 policy** em todas as tabelas (o buraco pré-049 foi fechado);
leitura `TO authenticated`, escrita `TO service_role`; GRANTs por coluna exatos — `financial_account_control`
gravável por `authenticated` só em `has_invoice`/`has_bank_slip`/`status_id`, `email_control` só `reviewed_at`;
**hard delete dos cadastros barrado no BANCO** (`REVOKE INSERT/UPDATE/DELETE` das 056/057), não só no
`requireAdminGroup`; INSERT/DELETE de linha em `financial_account_control` negados por RLS ("remoção = PATCH
status_id" é imposto no banco); funções `SECURITY DEFINER` **de trigger** com `search_path` fixo; sem SQL
injection (inputs parametrizados; `EXECUTE format` só com nomes de tabela de array hardcoded via `%I`).

### Achado (BLOQUEADOR)

**[ALTO] S2-1 — RPCs `SECURITY DEFINER` de resolução de fornecedor com `EXECUTE` para PUBLIC — escrita em
`supplier` contornando o lockdown das 056/057.**
- **arquivo:linha:** `042_supplier_sk_surrogate_key.sql:221` (+ `040:15`, `042:335,119,161,182`, `010:59`)
- **vetor:** as funções `resolve_supplier_id(text,text,text,text)`, `resolve_supplier_for_account(...)`,
  `_add_supplier_email(bigint,text)`, `_enrich_supplier(...)`, `_enrich_supplier_name(...)` e
  `resolve_company_id(...)` são `SECURITY DEFINER`, escalares, no schema `public` → **expostas como RPC pelo
  PostgREST**. Nenhuma migration faz `REVOKE EXECUTE ... FROM PUBLIC/anon/authenticated`; as únicas linhas de
  EXECUTE (`040:34`, `042:354`) só **adicionam** `GRANT ... TO service_role`, sem remover o `EXECUTE` default
  que o Postgres concede a `PUBLIC`. `authenticated` e `anon` herdam PUBLIC.
- **pré-condição:** apenas a **anon key** (pública) + opcionalmente um token de usuário — um
  `POST /rest/v1/rpc/resolve_supplier_id`.
- **impacto:** como `SECURITY DEFINER` roda como owner e **ignora RLS**, um chamador `authenticated`/`anon`
  **escreve na `supplier`** apesar do `REVOKE INSERT/UPDATE/DELETE` da 057: `resolve_supplier_id` faz INSERT de
  fornecedor arbitrário (`042:319`); `_add_supplier_email` injeta e-mail em qualquer `sk_supplier` (`042:208-214`)
  — sequestrando a resolução futura de fornecedor (o e-mail do atacante passa a casar) e poluindo a busca de
  `/consulta`; `_enrich_supplier*` sobrescrevem CNPJ/CPF/nome. Contradiz o desenho (`CLAUDE.md:436-439,1349`:
  escrita só por `service_role`).
- **correção mínima (migration 072):** `REVOKE EXECUTE` de `PUBLIC`, `anon` e `authenticated` em todas as
  funções de resolução/enriquecimento, mantendo `GRANT EXECUTE ... TO service_role`. Ex.:
  `REVOKE EXECUTE ON FUNCTION public.resolve_supplier_id(text,text,text,text) FROM PUBLIC, anon, authenticated;`
  (repetir para cada assinatura). **Este é o único bloqueador de produção.**

### Achado

**[BAIXO] S2-2 — `protect_delete` documentado no bucket `attachments` não existe no código.**
- **arquivo:linha:** `CLAUDE.md:2425` vs `021_create_attachments_bucket.sql:21-26`
- **vetor/impacto:** a 021 cria só `authenticated_read_attachments` (SELECT). Não há policy `protect_delete`.
  Hoje o DELETE por `authenticated` **está bloqueado por ausência de policy** (default-deny da RLS de
  `storage.objects`) — sem exposição atual —, mas a proteção é implícita/frágil e a doc descreve um controle
  inexistente.
- **correção mínima (migration 072):** policy explícita
  `CREATE POLICY "attachments_no_delete_authenticated" ON storage.objects FOR DELETE TO authenticated USING (false);`
  e alinhar o texto do CLAUDE.md.

> INFO: `normalize_search()` usada por funções `SECURITY DEFINER` mas **não versionada** (bootstrap manual,
> `README.md:52`) — não auditável do repo; confirmar no banco que fixa `SET search_path`; idealmente versionar
> na 072. INFO: a 056 habilita RLS/REVOKE **condicional a `IF EXISTS`** — um cadastro criado *depois* da 056
> fica sem RLS; risco operacional (checklist de go-live), não de código.

---

## 3. Superfície da Next API (IDOR / mass assignment / bridge)

**Confirmações positivas:** `service_role` instanciada só server-side (`lib/supabase-admin.ts:16`), **zero
import de `supabase-admin` no frontend**; auth valida token com anon; **mass assignment bloqueado** — nenhum
`.passthrough()`/`.catchall()` nos schemas (default **strip**): `status_id` no create, `sk_supplier`,
`supplier_id`, `company_id`, `*_id` IDENTITY, `created/updated_at` enviados no corpo são **descartados**;
IDOR dentro do modelo single-org documentado (sem vazamento cross-recurso; `company_id` omitido → sem
reatribuição de tenant); bridge validada (`readRequestSchema`); `failFromError` não vaza detalhe em 5xx.

### Achados

**[BAIXO] S3-1 — `python-bridge.ts` faz fetch ao Flask sem timeout.**
- **arquivo:linha:** `apps/api-backend/lib/python-bridge.ts:49-53` (e `probePythonHealth` `:67`)
- **vetor:** Flask lento/travado (IMAP pendurado) pendura o handler `POST /api/emails/read` junto (disponibilidade).
- **correção mínima:** `AbortSignal.timeout(30_000)` no fetch, tratando `AbortError` como `PythonBridgeError(…, 504)`.

**[BAIXO] S3-2 — PATCH/CREATE de conta expõem colunas de pipeline/auditoria à escrita manual.**
- **arquivo:linha:** `packages/shared/src/schemas/financial-account-control.schema.ts:292-325`
- **vetor:** `financialAccountControlInputSchema` só omite `id/company_id/created_at/updated_at`+embeds. Restam
  graváveis por `POST`/`PATCH /api/contas`: `gmail_message_id`, `extraction_source`, `extracted_at`,
  `processing_notes`, `email_body_excerpt`, `nosso_numero`, `payer_cnpj/name`, `sender_email`, `subject`, etc.
- **impacto:** dentro do tenant (aceitável por design), mas um usuário pode corromper a trilha de
  auditoria/dedup (`gmail_message_id`/`extraction_source`). Não cruza tenant.
- **correção mínima:** derivar `financialAccountControlManualEditSchema` com `.pick()` só dos campos de UI
  (fornecedor, valores, datas, classificação, `status_id`, `additional_info`, flags) em vez de `.partial()`
  sobre todo o input.

> INFO: `users/route.ts:26` e `emails/read/route.ts:37` têm ramo `fail(e.message, 500)` residual (o de users é o
> A1-2 do code review; ambos só alcançam erros de config/rede — não Postgres). Uniformizar para `failFromError`.

---

## 4. Pipeline Python como superfície hostil

**Confirmações positivas:** SSRF — `_is_safe_download_url` (`read_emails.py:2653-2668`) rejeita scheme≠http(s),
porta fora de {80,443} e host que resolve para IP interno (`_host_is_safe:2633-2650` cobre private/loopback/
link-local **169.254.169.254**/reserved/multicast/unspecified); `_SafeRedirectHandler` revalida **cada**
redirect (`:2671-2679`); cookiejar sem vazamento cross-domain; `_is_suspicious_link` cobre bing/ck, SafeLinks,
Proofpoint, base64. Contenção em `PDF_INBOX` + `_is_within_inbox` + `safe_filename` (path traversal barrado).
Injeção SMTP/CRLF: `_strip_crlf` no Subject/To e `_safe_address` descarta Cc malformado, **antes do header E do
envelope**. HTML injection: `template.py:14-15` aplica `html.escape` em `customer_name`/`document_id`. Sem SQLi
(PostgREST parametrizado). Flask sem CORS aberto; guarda CSRF `_reject_trigger_request` em todos os disparos;
bind `127.0.0.1`; SMTP com TLS verificado.

### Achados

**[MÉDIO] S4-1 — SSRF residual por DNS rebinding / TOCTOU (IP validado não é fixado).**
- **arquivo:linha:** `read_emails.py:2639-2650` (`_host_is_safe`)
- **vetor:** `socket.getaddrinfo` valida os IPs, mas o `urllib`/`http.client` **re-resolve o nome ao conectar**
  — o IP validado não é fixado no socket. Um domínio de TTL baixo responde IP público na 1ª resolução e
  `127.0.0.1`/`169.254.169.254` na 2ª.
- **pré-condição:** atacante (remetente) controla um domínio com DNS rebinding + link entra no pipeline.
- **impacto:** requisição a alvo interno (metadata/LAN) apesar do guard.
- **correção mínima:** resolver uma vez e conectar ao IP fixado revalidado (custom opener que faz `getaddrinfo`
  e passa o IP à conexão preservando o header `Host`), ou reusar a mesma resolução validada.

**[MÉDIO] S4-2 — Endpoints de disparo do Flask sem token obrigatório por padrão.**
- **arquivo:linha:** `server/app.py:55,60-77,312-314`
- **vetor:** `FLASK_TRIGGER_TOKEN` é **opcional** (default vazio → só checa `Content-Type: application/json`). A
  única barreira efetiva é o bind `127.0.0.1`.
- **pré-condição:** qualquer processo/usuário local (ou exposição futura via `0.0.0.0`/ponte HTTP de outro host).
- **impacto:** disparar leitura IMAP e **envio de cobranças SMTP** com poderes de `service_role`.
- **correção mínima:** exigir `FLASK_TRIGGER_TOKEN` quando o bind não for loopback (falhar no boot se vazio), e
  documentar o pressuposto de rede. Ver "Pressuposto de rede" abaixo.

**[BAIXO] S4-3 — Bypass residual por IPv6 IPv4-mapeado (`::ffff:169.254.169.254`) em Python < 3.13.**
- **arquivo:linha:** `read_emails.py:2642-2649`
- **vetor:** `is_private/is_link_local` só delegam ao IPv4 embutido em Python ≥ 3.13. **Produção roda Python
  3.14.5** (CLAUDE.md) → mitigado; risco só em runtime < 3.13.
- **correção mínima (defesa em profundidade):** normalizar `if ip.ipv4_mapped: ip = ip.ipv4_mapped` antes das checagens.

**[BAIXO] S4-4 — `From` do e-mail de cobrança sem `_strip_crlf`.**
- **arquivo:linha:** `email_sender.py:103` (`_build_message`)
- **vetor:** `from_name` (env `SMTP_FROM_NAME`/`company.trade_name`/`legal_name` do Supabase) não passa por
  `_strip_crlf` — injeção teórica de header (admin-controlado, hostilidade baixa).
- **correção mínima:** `_strip_crlf(smtp['from_name'])` (e `from_addr`) na composição do From.

> INFO: `_is_internal_email` citado na doc **não existe** em Python — o bloqueio de remetente interno é feito na
> RPC/migration 046. Ajustar o texto do CLAUDE.md (não afirmar defesa inexistente).

### Pressuposto de rede (LAN)

O modelo repousa em três premissas acopladas: (1) Flask só em `127.0.0.1`; (2) máquina single-operator confiável
(onde vivem `.env` com `service_role`, IMAP e SMTP); (3) `FLASK_TRIGGER_TOKEN` opcional. **Sustenta-se** para a
ferramenta de estação única. **Não se sustenta** se o Flask ouvir em `0.0.0.0` ou a máquina for multiusuário —
nesses casos a única barreira é o token, vazio por padrão. Recomendação de go-live: tornar o token obrigatório
fora de loopback e nunca expor a porta 8000.

---

## 5. Frontend / XSS / config

**Confirmações positivas:** **sem `dangerouslySetInnerHTML`/`innerHTML`/`insertAdjacentHTML`** em todo `src/`;
corpo de e-mail/`email_body_excerpt`/assunto/`raw_payload` renderizados como **texto** (React escapa —
`ExpandableText`, `<pre>` com `JSON.stringify`); **XSS não reproduzível**; segredos no bundle só o público
(`VITE_SUPABASE_URL` + anon key confirmada `"role":"anon"`; **nenhuma service_role**); proxy do Vite com alvo
fixo (dev-only); `vercel.json` com destino fixo; `csv.ts` `csvCell` neutraliza injeção de fórmula (`= + - @`) +
CRLF; `.env` gitignored.

### Achados

**[MÉDIO] S5-1 — `<iframe>` do PDF anexado sem atributo `sandbox`.**
- **arquivo:linha:** `apps/frontend-vite/src/components/AttachmentViewer.tsx:105`
- **vetor:** o PDF (conteúdo de e-mail hostil) é renderizado em `<iframe src={signedUrl}>` sem `sandbox`. A
  origem é o Supabase Storage (cross-origin → SOP protege o token do app), mas um PDF com JS pode disparar
  **navegação de topo** (`window.top.location`) e redirecionar o app para phishing, além de popups.
- **correção mínima:** `sandbox="allow-same-origin allow-popups"` (sem `allow-scripts`/`allow-top-navigation`),
  opcional `referrerPolicy="no-referrer"`.

**[BAIXO] S5-2 — Ausência de header Content-Security-Policy.**
- **arquivo:linha:** `apps/frontend-vite/vercel.json` (sem bloco `headers`) + `index.html` (sem meta CSP)
- **vetor:** qualquer XSS futuro (hoje inexistente) exfiltra o token de web-storage sem barreira; `frame-src`/
  `frame-ancestors` sem restrição.
- **correção mínima:** CSP restritiva no `vercel.json` (`default-src 'self'`; `connect-src` p/ o projeto Supabase
  + Vercel; `frame-src https://*.supabase.co`; `frame-ancestors 'none'`; `object-src 'none'`). Endurece S1-2.

> INFO: `VITE_IMAP_USER` (e-mail da caixa) entra no bundle (`Emails.tsx:318`) — é um e-mail, não credencial;
> divulgação de baixa sensibilidade. Opcional: servir via API autenticada em vez de `VITE_`.

---

## 6. Segredos e dependências

**Confirmações positivas:** **nenhum `.env` versionado** (`git ls-files` só 4 `.env.example` com placeholders;
`git log --all --diff-filter=A` para `.env` real = vazio); nenhum segredo hardcoded (todo carregamento via
`process.env`/`os.getenv`/`import.meta.env`); `.gitignore` cobre `.env*`, `data/`, `logs/`, `backups/`,
`node_modules/`, `.next/`, `dist/`; nenhum segredo em `vercel.json`/`.vscode`/`scheduler/*.ps1`. **Ações de
rotacionar/limpar histórico NÃO se aplicam** (nenhum segredo encontrado).

### Achados

**[MÉDIO] S6-1 — `postcss <8.5.10` (GHSA-qx2v-qp2m-jg93) — 2 vulns moderadas, build-time via `next`.**
- **origem:** `npm audit --omit=dev` — `postcss` transitivo de `next` (`node_modules/next/...`), apps
  `api-backend` e `portal-next`.
- **vetor:** XSS via `</style>` não escapado no stringify de CSS — requer CSS **controlado pelo atacante** no
  build. Neste projeto o CSS é estático (do time); postcss roda **em build**, sem entrada de terceiros/usuário
  → **sem exposição de runtime**. Impacto prático baixo/nulo.
- **correção mínima:** higiene — `npm update next` (linha que traz postcss ≥8.5.10) na próxima janela. **Não é
  bloqueador** (build-time sobre entrada confiável).

**[BAIXO] S6-2 — `VITE_IMAP_USER` embutido no bundle** (`Emails.tsx:318`) — endereço de e-mail, não credencial;
divulgação de baixa sensibilidade (phishing/enumeração). Correção opcional: servir via resposta autenticada.

> INFO: `pip list --outdated` — updates **menores** sem CVE sinalizado (`cryptography 48→49`, `requests
> 2.32.5→2.34.2`, `urllib3 2.6.3→2.7.0`, `pillow 12.2→12.3`, `pypdf 6.13→6.14`, …). `pip list` não checa CVE —
> registrar como manutenção; priorizar `cryptography`/`urllib3`/`requests`/`pillow` (superfície de rede/parsing).

---

## 7. Veredito + matriz de risco

**PASSA** (atualizado na Fase 2, 2026-07-08): o **S2-1** foi fechado — migration 072 **aplicada** e vetor
verificado (`anon` → `42501`). Os demais achados MÉDIO/BAIXO da matriz também foram aplicados (ver "Status
de aplicação" no sumário).

| Achado | Sev | Esforço | Bloqueia go-live? |
|---|---|---|---|
| S2-1 RPCs SECURITY DEFINER escrita por authenticated | ALTO | S (migration 072) | ~~SIM~~ **FECHADO** (072 aplicada) |
| S1-1 troca de senha só client-side | MÉDIO | M | Não (recomendado) |
| S1-2 token em localStorage (XSS) | MÉDIO | M | Não (contido — sem XSS) |
| S4-1 SSRF DNS rebinding/TOCTOU | MÉDIO | M | Não (recomendado) |
| S4-2 disparo Flask sem token obrigatório | MÉDIO | S | Não (mitigado por bind loopback) |
| S5-1 iframe do PDF sem sandbox | MÉDIO | S | Não (recomendado) |
| S6-1 postcss build-time | MÉDIO | S | Não (build-time) |
| S2-2, S3-1, S3-2, S4-3, S4-4, S5-2, S6-2, S1-3, S1-4 | BAIXO | S | Não |

### Top 5 a fechar antes do go-live

1. **S2-1 (ALTO, BLOQUEADOR)** — migration 072: `REVOKE EXECUTE` das RPCs `resolve_supplier_id`,
   `resolve_supplier_for_account`, `resolve_company_id`, `_enrich_supplier`, `_enrich_supplier_name`,
   `_add_supplier_email` de PUBLIC/anon/authenticated (manter service_role).
2. **S4-2** — tornar `FLASK_TRIGGER_TOKEN` obrigatório fora de loopback (protege disparo de leitura/cobrança).
3. **S1-1** — impor a troca de senha no servidor (`app_metadata`), não em `user_metadata`.
4. **S5-1 + S5-2** — `sandbox` no iframe do PDF + header CSP (defesa em profundidade contra XSS futuro).
5. **S4-1** — fixar o IP resolvido no download de boleto (fecha o SSRF por rebinding).

---

## 8. Não-achados (confirmações positivas)

- `service_role` isolada server-side; **zero import de `supabase-admin` no frontend**; anon key confirmada.
- Mass assignment bloqueado (strip efetivo; sem `.passthrough()`); `company_id`/`sk_supplier`/IDENTITY/`created_at` descartados no corpo.
- RLS habilitada com ≥1 policy em todas as tabelas; GRANTs por coluna restritos a 3+1 colunas; hard delete barrado no banco.
- SSRF: scheme/porta/IP interno bloqueados; redirect revalidado; cookiejar sem vazamento; links suspeitos filtrados; contenção em PDF_INBOX.
- Injeção SMTP/CRLF barrada (Subject/To/Cc, header + envelope); HTML escape no e-mail de cobrança; sem SQLi.
- XSS não reproduzível (React escapa; sem HTML cru; CSV endurecido); segredos só públicos no bundle.
- `requireAdmin` (papel) vs `requireAdminGroup` (grupo) corretos; login público sem enumeração; Flask sem CORS aberto + guarda CSRF nos disparos + bind loopback + TLS verificado.
- Nenhum segredo versionado ou no histórico do git; `.gitignore` completo.
