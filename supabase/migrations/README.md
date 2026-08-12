# Migrations — Supabase (aplicação MANUAL)

As migrations `001 → 061` são aplicadas **manualmente no SQL Editor do Supabase**, em
**ordem numérica** e **uma única vez cada**. Não há runner automático.

> **`120_ai_chat_gate_por_grupo.sql` (idempotente — aplicada DIRETO via Supabase MCP em
> 2026-08-12)** — Onda 8, item 8.3. Acrescenta a `public.user_group` as colunas `ai_chat_enabled`
> (`NOT NULL DEFAULT false`) e `ai_chat_limit_per_hour`/`_per_day` (NULL = teto do `.env`), o CHECK
> `chk_user_group_ai_chat_limits` e a semente dos grupos **1, 2 e 7**.
>
> **Não regredir — três pontos:**
> 1. **Não há função helper de RLS, de propósito.** RLS responde "quais linhas este papel lê"; o
>    gate responde "este usuário pode chamar o endpoint". Quem lê é o `lib/ai-chat/gate.ts` com
>    `service_role`, para quem um `SECURITY DEFINER` sobre `auth.uid()` seria inalcançável — e
>    seria mais um objeto que os advisors apontam e ninguém consegue provar que é morto (o caso do
>    `auth_group_sees_only_own()`, que este README já registra como impossível de revogar). Por isso
>    também **não há GRANT/REVOKE aqui**: o arquivo não cria função nem objeto novo.
> 2. **A semente é `SET ai_chat_enabled = true WHERE group_id IN (...)`.** A forma
>    `SET ai_chat_enabled = (group_id IN (...))` também seria "idempotente" — e **revogaria em
>    silêncio** qualquer grupo liberado à mão depois da aplicação.
> 3. **A sonda P2 avança a sequence IDENTITY de `user_group` permanentemente** (sequence não é
>    transacional, então o rollback devolve a linha mas não o número). Inócuo — não há requisito de
>    numeração sem buracos —, mas registrado para não ser lido como vazamento.
>
> ✅ **`get_advisors` rodado após aplicar (2026-08-12): ZERO achados novos.** Os ERROR/WARN que
> aparecem (`app_user`, `search_path` mutável, `SECURITY DEFINER` executável por `anon`) são todos
> **pré-existentes e já triados** no CLAUDE.md — inclusive o `auth_group_sees_only_own()`, que os
> advisors apontam e **não pode** ser revogado, por ser chamado dentro das policies 076/078. É a
> medição que sustenta a decisão do ponto 1: a 120 não criou função nem view, então não tinha como
> acrescentar nada a essa lista. Rodar os advisors após DDL é a prática do projeto — barata, e
> aqui ela transformou "o helper seria peso morto" de argumento em fato.
>
> **⚠️ Ordem de implantação (o modo de falha real desta migration):** migration → conferir que o
> **cache de schema do PostgREST** já enxerga a coluna → deploy da Next API → deploy da SPA.
> Subir a API antes da migration faz o `gate.ts` falhar ao ler e, sendo **fail-closed**, derruba o
> chat para todos — inclusive para quem iria corrigir. ❌ E a "correção" tentadora de transformar
> "coluna não existe" em passe livre é um backdoor fail-open acionado por string de erro.

> **`100_restore_service_role_default_dml.sql` (idempotente — aplicada DIRETO via Supabase MCP em
> 2026-07-29)** — devolve `SELECT/INSERT/UPDATE/DELETE` ao papel **`service_role`** no DEFAULT de
> tabelas novas (schemas `public` e `analytics`), sem devolver nada a `anon`/`authenticated`.
>
> **Contexto:** ao desligar o toggle **Data API → "Automatically expose new tables"** (2026-07-29),
> o Supabase tratou `service_role` como "Data API role" e o removeu junto — o default do papel
> `postgres` virou `service_role=Dxtm`, isto é, **sem DML**. Como é com `service_role` que o
> pipeline Python e a Next API escrevem, a próxima migration que criasse uma tabela produziria
> `permission denied` no pipeline, com o sintoma longe da causa. Nada quebrou na hora: default
> privileges só valem para objeto NOVO (as 19 tabelas existentes seguiram intactas).
>
> **Seguro porque** a chave `service_role` é server-side (fica no `.env` e nas env vars da Vercel,
> nunca no browser). Quem não pode receber privilégio por default é `anon` (chave pública) e
> `authenticated` — e esses continuam de fora.
>
> ⚠️ **O que continua aberto e NÃO tem correção por SQL:** o default do papel **`supabase_admin`**
> segue com `anon=arwdDxtm`/`authenticated=arwdDxtm` — desligar o toggle **não o alterou**. É o
> papel que cria tabela pelo **Table Editor**, e `ALTER DEFAULT PRIVILEGES` nele exige superuser.
> → **Criar tabela sempre por migration, nunca pela UI do dashboard.**

> **`099_revoke_rls_bypass_rpcs.sql` (SEGURANÇA CRÍTICA, idempotente — aplicada DIRETO via
> Supabase MCP em 2026-07-29)** — fecha duas RPCs que **contornavam a RLS** e eram executáveis por
> **`anon`**, ou seja, **sem login**, com a anon key que é pública por design (vai no bundle do
> browser). Achadas pelos advisors do Supabase durante a Fase 1 do chat de IA.
>
> 1. **`fn_delete_all_emails()`** — `SECURITY DEFINER`, `RETURNS text` (logo, chamável em
>    `/rest/v1/rpc/`), fazia `DELETE` em `financial_account_control`, `email_control` e
>    `email_processing_errors` + reset das sequences. Qualquer pessoa na internet podia **apagar a
>    base inteira** com um POST. A função foi **PRESERVADA** (só `REVOKE`) — é a ferramenta manual
>    de "Limpeza / reset de dados", usada pelo SQL Editor, que roda como `postgres`.
> 2. **`search_text(p_table, p_column, p_termo)`** — `SECURITY DEFINER` com `EXECUTE format('%I')`.
>    O `%I` barra SQL injection, mas rodando como `postgres` a função **ignora a RLS** e devolve
>    `SELECT *` de qualquer tabela, 50 linhas por chamada. **Exploração confirmada como `anon`:**
>    50 contas (com `amount`/`created_by`) e 50 fornecedores. Depois do fix, o mesmo POST via HTTP
>    responde `42501 permission denied`.
> 3. **View `app_user`** — `REVOKE SELECT ... FROM anon` (lia os 12 e-mails de todos os usuários sem
>    login). **`authenticated` MANTÉM o SELECT** — sem ele o "Criado por" some do detalhe de
>    `/consulta`. A 081 já havia fechado a ESCRITA nela; faltava a leitura por `anon`.
> 4. `DROP TABLE public.supplier_tmp` (staging residual, 464 linhas; 0 FKs e 0 views dependentes).
>
> **NÃO REGREDIR — o que a 099 deliberadamente NÃO toca:** `auth_group_sees_only_own()` também é
> apontada pelos advisors, mas **revogar o EXECUTE dela quebraria TODA a RLS** — ela é chamada
> DENTRO das policies 076/078, avaliadas como `authenticated`. É a mesma regressão que a **074**
> teve de consertar depois da 072. As 6 funções `RETURNS trigger` são ruído do linter (o PostgreSQL
> recusa chamada direta a função de trigger).

> **`098_create_analytics_schema.sql` (Fase 1 do chat de IA, idempotente — aplicada DIRETO via
> Supabase MCP em 2026-07-29)** — cria o schema `analytics` (camada semântica read-only): as views
> `vw_payables`/`vw_aging_vencidos` (`security_invoker = true`), as **6 funções** de tool calling
> (`SECURITY INVOKER` + `STABLE`), a `ai_chat_log` com RLS e os GRANT/REVOKE. Ver
> `docs/arquitetura-chat-ia-pagamentos.md`.
>
> ⚠️ **PASSO MANUAL PENDENTE, fora da migration:** expor o schema no PostgREST em
> **Supabase Dashboard → Settings → API → Exposed schemas** → acrescentar `analytics`. Sem isso,
> `supabase.schema('analytics').rpc(...)` responde **404** e a Fase 2 (gateway) não funciona. Os
> objetos existem e respondem por SQL direto — só a exposição HTTP depende desse passo.
>
> **Não regredir:** as views/funções são `SECURITY INVOKER` de propósito — é isso que faz a RLS de
> `financial_account_control` (076) valer para o chat. Trocar por `DEFINER` seria escalada de
> privilégio silenciosa; usar `service_role` no gateway teria o mesmo efeito. Validado com o papel
> `authenticated` real: ester (Comercial, restrita) vê **48** contas, barbara (Financeiro) vê
> **578**.

> **`095_fix_status_trigger_reference_date.sql` (BUG DE FUNDAÇÃO, idempotente — aplicada
> DIRETO via Supabase MCP em 2026-07-23)** — a trigger `fn_set_status_from_due_date`
> (desde a `034`, 2026-06-18) calculava a data de referência como
> `COALESCE(NEW.extracted_at, NOW())` — a data em que a conta foi **extraída**, congelada —
> em vez da data ATUAL. Qualquer `UPDATE` numa conta "em aberto" feito depois do vencimento
> ter passado (curadoria de NF/Boleto, ou o `PATCH status_id=2` da skill
> `baixa-automatica`/Regra 2) recalculava contra essa data congelada e **revertia** de volta
> para "a vencer" — silenciosamente, na mesma transação. Medido antes do fix: só 3 de 126
> contas que deveriam estar `vencido` realmente persistiam assim. Fix: `ref_date := (NOW()
> AT TIME ZONE 'America/Sao_Paulo')::date`. Correção retroativa das 123 contas
> mal-classificadas aplicada no mesmo momento (SQL direto). Detalhes completos em
> "Trigger de situação por vencimento usava a data de EXTRAÇÃO" no `CLAUDE.md`.

> **`059`/`060`/`061`/`063` foram aplicadas DIRETO via Supabase MCP** (não pelo SQL Editor) — o
> arquivo numerado é só histórico. Todas idempotentes; **não reaplicar** no SQL Editor.
> `059` = backfill único da classificação das contas a partir do supplier (fora do fluxo
> diário). `060` = índices de performance da busca em `/consulta` (GIN trigram + btree).
> `061` = adiciona `image_vision` ao CHECK de `extraction_source` (anexos de imagem via Vision).
> `063` = fundação de grupos de usuário: catálogo `public.user_group` (id 0 sentinela + RLS
> read `authenticated`/write `service_role`) + backfill de `app_metadata.group_id=0` nos
> usuários existentes. A atribuição de grupo por usuário vive no claim `app_metadata.group_id`
> (padrão do `role`), não em `auth.users`/tabela de perfil. (Há um `062` duplicado no diretório
> — `062_chart_account_default_level_3` e `062_doc_type_multa_dare`; a numeração seguiu para 063.)
> `064` = adiciona `financial_account_control.additional_info` TEXT (nullable) — texto livre do
> usuário no cadastro de contas (ContaForm), exibido no card de detalhe de `/consulta`.

> **`088`/`089`/`090` (NATUREZA contábil — aplicadas DIRETO via Supabase MCP, idempotentes)** —
> normalizam a classificação dos grupos do plano de contas (substituem o legado `group_type`).
> `088` = catálogo `public.financial_type_group` (id 0 sentinela + Receitas/Despesas/Ativo/Passivo;
> RLS read `authenticated`/write `service_role` + REVOKE). `089` = FK `type_group_id` (SMALLINT
> NOT NULL DEFAULT 0) em `financial_chart_of_account_group` **e** `_subgroup` + índice parcial (a
> classificação é feita só no GRUPO; o subgrupo fica em 0). `090` = índice UNIQUE case-insensitive
> `lower(code)` (parcial, exclui o sentinela) em grupo/subgrupo — fecha o TOCTOU do create.
> **A CLASSIFICAÇÃO em si dos grupos** (mapear `group_type` → `type_group_id`, rename de "Despesas
> Fiscais"→"Despesas Tributárias") foi **curadoria de DADOS manual** (não há migration de backfill);
> em ambiente novo vem do dump dos cadastros (como os demais cadastros pré-existentes).

> **`084_sk_company_lebianco_rule.sql` (idempotente)** — empresa pagadora pela **regra LEBIANCO**:
> (1) `trg_fe_resolve_company()` passa a resolver **só quando `NEW.sk_company IS NULL`** (antes
> sobrescrevia sempre — descartava o valor do pipeline **e** qualquer UPDATE re-resolvia a
> empresa); (2) **backfill** das contas já extraídas (55 → `sk_company=2`). **Ordem interna
> importa** (trigger antes do backfill). Re-run reporta 0 linhas. Aplicada via psql em 2026-07-17.
> Detalhes em "Empresa pagadora (`sk_company`) — regra LEBIANCO" no `CLAUDE.md`.

> **`057_revoke_write_supplier_status.sql` (segurança, idempotente)** — `REVOKE` de escrita
> do papel `authenticated` em `supplier`/`status` (defesa em profundidade; o RLS já bloqueia).
> Seguro reaplicar; não altera políticas/dados/SELECT.

> **`056_rls_cadastros_preexistentes.sql` (segurança) é idempotente, MAS exige verificação
> antes de aplicar.** Ela habilita RLS + leitura `authenticated` + REVOKE de escrita nos
> cadastros pré-existentes (`company`, `financial_account`, `financial_bank`, grupos/
> subgrupos) e em `audit_log` se existir. **Antes de rodar**, confirme no SQL Editor o
> estado atual (queries abaixo) — a migration assume que esses cadastros são
> **apenas-leitura** para o papel `authenticated`. Ver `docs/review/seguranca/RELATORIO-SEGURANCA.md` §2.
>
> ```sql
> SELECT relname, relrowsecurity FROM pg_class WHERE relname = '<tabela>';
> SELECT * FROM pg_policies WHERE tablename = '<tabela>';
> -- \dp <tabela>   -- GRANTs do papel authenticated
> ```

## Regras operacionais (não regredir)

1. **Aplicar uma vez, em ordem.** Várias migrations **não são idempotentes** (falham se
   reaplicadas) — isso é **falha segura** (erro, não corrupção de dado), mas evite re-run:
   - `042` — `ADD CONSTRAINT supplier_pkey PRIMARY KEY` / `DROP IDENTITY`.
   - `050`, `051` — `ALTER COLUMN ... ADD GENERATED ALWAYS AS IDENTITY`.
   - `083` — `company`: `ADD CONSTRAINT company_pkey PRIMARY KEY (sk_company)` +
     `ALTER COLUMN sk_company ADD GENERATED ALWAYS AS IDENTITY`; `financial_account_control`
     `DROP COLUMN company_id`. Espelha a `042` (agora para empresa).
   - `053` — `ADD CONSTRAINT fk_financial_account_status` (sem bloco `DO`/`IF NOT EXISTS`).
   - `039` — `DISABLE/ENABLE TRIGGER trg_fe_supplier_id`: quebra se reaplicada **após** a
     `041` (que dropa esse trigger). Só re-run isolado é afetado.
   - A migration `055` era idempotente (só `COMMENT ON`), **mas apenas até a `069`**: a
     `069` dropou a coluna `status` (texto) e o `COMMENT ON` dela passa a abortar
     ("column status does not exist"). **Não reaplicar a `055` após a `069`** (A5-1).

2. **Pré-requisito de bootstrap (banco vazio NÃO se reconstrói só com estas migrations).**
   As migrations dependem de objetos **pré-existentes** nunca criados por elas:
   - Tabelas de cadastro: `company` (com `sk_company` — surrogate PK IDENTITY criada na
     `083`; um ambiente novo aplica a `083` sobre o dump que já tenha a coluna), `status`,
     `supplier`, `financial_account`, `financial_bank`, `financial_cost_center`,
     `financial_chart_of_account(_group/_subgroup)`.
   - Função `normalize_search()` (usada já na `007`).
   Em um ambiente novo, aplique o **dump desses cadastros + `normalize_search`** ANTES da
   `001`. (Os cadastros são preservados em qualquer limpeza — ver "Limpeza / reset de dados"
   no `CLAUDE.md`.)

3. **RLS.** Leitura `TO authenticated`, escrita `TO service_role`. Exceções por coluna
   (grant restrito) em `financial_account_control`: `reviewed_at` (030),
   `has_invoice`/`has_bank_slip` (033) e **`status`** (036) — esta última documentada na
   `055`. Toda tabela com RLS habilitado tem ao menos uma policy (default-deny histórico de
   `supplier` e dos cadastros de classificação foi fechado em `029` e `049`).

4. **ON DELETE das FKs de classificação.** As FKs `fk_fac_cost_center`/`fk_fac_chart_account`
   (047) e `fk_supplier_cost_center`/`fk_supplier_chart_account` (052) não declaram `ON DELETE`
   → `NO ACTION`, cujo efeito **equivale a RESTRICT** (sem deferição): bloqueiam excluir um
   cadastro em uso. O backend também valida e devolve `409`. Documentado via `COMMENT ON` na `055`.

5. **Onda 6 — migrations 111 a 115 (campos derivados).** Todas idempotentes; as **111 e 113 têm
   bloco `DO $$` que ABORTA** se a própria regra que elas definem não reproduzir os vetores de
   conferência (Páscoa/feriados na 111; a amostra real de `invoice_number` na 113). Reaplicá-las é
   no-op, mas uma reaplicação que falhe no `DO $$` significa que o dado ou a regra mudaram — não
   remover a guarda para "fazer passar". A numeração real é **111–115**, não 112–116 como o roadmap
   previa: as 109/110 foram consumidas por trabalho não relacionado antes da onda começar.

   🔴 **Coluna gerada tem duas armadilhas que estas migrations documentam no corpo:**
   `to_date` é **STABLE** e o PostgreSQL a recusa (usar `make_date`), e substituir a função de uma
   coluna gerada **não recalcula** os valores STORED — para corrigir a regra, `DROP COLUMN` +
   `ADD COLUMN`, nunca `UPDATE ... SET x = x` (dispararia as triggers da tabela).
