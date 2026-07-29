-- 099_revoke_rls_bypass_rpcs.sql
-- Fecha DUAS vulnerabilidades CRÍTICAS exploráveis por `anon` — isto é, SEM LOGIN — e remove uma
-- tabela de staging residual. Achado em 2026-07-29 pelos advisors do Supabase, durante a Fase 1 do
-- chat de IA (migration 098).
--
-- CONTEXTO: A RLS NÃO ESTAVA FALHANDO. Verificado com o papel `anon` real, o acesso DIRETO às
-- tabelas devolve 0 linhas (`financial_account_control`, `supplier`, `supplier_tmp`). As brechas
-- abaixo são três caminhos que **contornam** a RLS — duas funções `SECURITY DEFINER` de owner
-- `postgres` e uma view `security_invoker = false`. É a lição das migrations 072/074/081 se
-- repetindo: o perímetro do PostgREST não é só a policy, é também **quem pode executar o quê**.
--
-- POR QUE `anon` É O PAPEL QUE IMPORTA: a anon key é **pública por design** — vai no bundle
-- JavaScript servido em pag.otimotex.com.br. Qualquer pessoa que abra o site e leia o JS a obtém.
-- "Só `anon` consegue" não é mitigação; é o pior caso.
--
-- ---------------------------------------------------------------------------------------------
-- BRECHA 1 (CRÍTICA — destruição) — public.fn_delete_all_emails()
-- ---------------------------------------------------------------------------------------------
-- `SECURITY DEFINER`, owner `postgres`, `RETURNS text` (portanto NÃO é função de trigger e É
-- chamável via `POST /rest/v1/rpc/fn_delete_all_emails`), com EXECUTE para `anon`. O corpo faz:
--     DELETE FROM financial_account_control;   -- 578 contas
--     DELETE FROM email_processing_errors;
--     DELETE FROM email_control;               -- + RESTART das sequences
-- Ou seja: qualquer pessoa na internet podia apagar a base inteira de contas a pagar com um único
-- POST. Não foi testado, por razões óbvias — a prova é o privilégio + o tipo de retorno.
--
-- A FUNÇÃO É PRESERVADA (REVOKE, não DROP): é a ferramenta manual de "Limpeza / reset de dados"
-- descrita no CLAUDE.md, usada pelo SQL Editor — que roda como `postgres` e portanto não é afetado.
--
-- ---------------------------------------------------------------------------------------------
-- BRECHA 2 (CRÍTICA — vazamento) — public.search_text(p_table, p_column, p_termo)
-- ---------------------------------------------------------------------------------------------
-- `SECURITY DEFINER` + `EXECUTE format('SELECT * FROM %I WHERE ... %I ...')`. O `%I` (quote_ident)
-- de fato barra a SQL injection clássica — e é por isso que a função "parecia" segura. O problema
-- é outro: rodando como `postgres`, ela **ignora a RLS** e devolve `SELECT *` de qualquer tabela
-- alcançável pelo search_path, 50 linhas por chamada, com o nome da tabela escolhido pelo cliente.
--
-- EXPLORAÇÃO CONFIRMADA (executada como `anon`, sem login):
--     search_text('financial_account_control','subject','')  -> 50 contas, com amount e created_by
--     search_text('supplier','trade_name','')                -> 50 fornecedores
-- Toda a visibilidade por dono (076/078/080/081) é contornada por essa única função.
--
-- ---------------------------------------------------------------------------------------------
-- BRECHA 3 (ALTA — PII) — view public.app_user
-- ---------------------------------------------------------------------------------------------
-- A view é `security_invoker = false` de propósito (roda como owner e ignora a RLS de `auth.users`)
-- — é isso que permite `/consulta` resolver o e-mail do autor de uma conta, e **não deve mudar**.
-- O problema é o outro lado: `anon` tinha SELECT. Confirmado como `anon` sem login: os 12 e-mails
-- de todos os usuários (samuel@…, rose@…, bruna@…). Isso é uma lista pronta para phishing dirigido
-- e credential stuffing.
--
-- A migration 081 já havia fechado a ESCRITA nessa view (era escalada de privilégio: a view é
-- auto-atualizável e um UPDATE nela alterava `auth.users`). A LEITURA por `anon` passou batido.
-- `authenticated` MANTÉM o SELECT — sem ele, o autor some do painel de detalhe de /consulta.
--
-- ---------------------------------------------------------------------------------------------
-- O QUE NÃO É TOCADO, E POR QUÊ (não "completar" depois sem ler isto)
-- ---------------------------------------------------------------------------------------------
-- * `public.auth_group_sees_only_own()` — os advisors também a apontam (SECURITY DEFINER,
--   executável por anon/authenticated). REVOGAR O EXECUTE DELA QUEBRARIA TODA A RLS: ela é chamada
--   DENTRO das policies de 076/078, que são avaliadas com o papel `authenticated`; sem EXECUTE, o
--   usuário levaria `42501` em qualquer SELECT das contas. É exatamente a regressão que a migration
--   074 teve de corrigir (o trigger `trg_fe_resolve_company` após a 072). O risco real dela é
--   desprezível: retorna um booleano sobre o próprio chamador.
-- * As 6 funções `RETURNS trigger` (`handle_new_user`, `fn_set_payment_date`,
--   `fn_set_status_from_due_date`, `fn_stamp_account_authorship`, `trg_fe_resolve_company`,
--   `fn_supplier_block_funcionario_classification`) — o PostgreSQL recusa chamada direta a função
--   de trigger, então o alerta do linter é conservador. Não são alcançáveis por RPC.
-- * `public.search_company(termo)` — é `SECURITY INVOKER`, logo respeita a RLS. Não usada pelo app,
--   mas inofensiva; deixada como está para manter o escopo desta migration no que é explorável.
--
-- ---------------------------------------------------------------------------------------------
-- IMPACTO NO APP: NENHUM. `fn_delete_all_emails`, `search_text` e `search_company` não aparecem em
-- nenhum `.ts`, `.tsx` ou `.py` do repositório (grep) nem em migration alguma — foram criadas à mão
-- no SQL Editor. A leitura de `app_user` por `authenticated` é preservada.
--
-- IDEMPOTENTE. Pode ser reaplicada.

-- ---------------------------------------------------------------------------
-- 1. BRECHA 1 e 2 — tirar as RPCs de bypass do alcance dos papéis do PostgREST
-- ---------------------------------------------------------------------------
-- O REVOKE de PUBLIC é o que realmente fecha: o PostgreSQL concede EXECUTE a PUBLIC por default em
-- toda função criada, e `anon`/`authenticated` herdam por aí. Revogar só dos dois papéis deixaria
-- o privilégio de pé via PUBLIC.

REVOKE EXECUTE ON FUNCTION public.fn_delete_all_emails()
    FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.search_text(text, text, text)
    FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. BRECHA 3 — fechar a leitura de e-mails de usuário para o papel anônimo
-- ---------------------------------------------------------------------------
-- `authenticated` NÃO entra neste REVOKE (ver acima).

REVOKE SELECT ON public.app_user FROM anon;

-- ---------------------------------------------------------------------------
-- 3. HIGIENE — remover a tabela de staging residual
-- ---------------------------------------------------------------------------
-- `public.supplier_tmp`: 464 linhas, staging de importação de fornecedores
-- (trade_name, legal_name, cnpj, cpf, cost_center_id, chart_account_id). Confirmado tabela
-- temporária pelo dono do produto em 2026-07-29.
--
-- Verificado antes do DROP: 0 FKs apontando para ela, 0 FKs saindo dela, 0 views dependentes —
-- o DROP não cascateia em nada. 463 das 464 linhas já existem em `public.supplier`; a única
-- exclusiva é `01217JCT / JC TEXTILE (RRICHTONE)` (sem CNPJ/CPF, sem conta vinculada).
--
-- OBSERVAÇÃO REGISTRADA PARA O FUTURO (não é ação desta migration): a classificação contábil que
-- estava no staging (`cost_center_id = 19`, `chart_account_id = 42`) NUNCA foi aplicada — os
-- fornecedores correspondentes em `supplier` estão todos com 0/0. Se um dia essa classificação for
-- desejada, ela NÃO se recupera daqui; o conteúdo permanece nos backups diários do
-- `pg_dump` (skill `backup-supabase`, retenção 30 dias).

DROP TABLE IF EXISTS public.supplier_tmp;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executada após aplicar — em prosa, não como SQL comentado, para não disparar o
-- "commented-out code" do SonarCloud; mesma convenção da 073 e da 098)
-- ---------------------------------------------------------------------------
--
--   1. Como `anon`: executar `fn_delete_all_emails()` e `search_text(...)` devolve
--      `42501 permission denied`. Idem para `authenticated`.
--   2. Como `anon`: `SELECT count(*) FROM public.app_user` devolve `42501`.
--   3. Como `authenticated`: `SELECT count(*) FROM public.app_user` CONTINUA devolvendo 12 — se
--      der erro, o painel de detalhe de /consulta perde o "Criado por".
--   4. Como `authenticated` de grupo restrito (Comercial): a leitura de `financial_account_control`
--      continua funcionando (prova de que `auth_group_sees_only_own()` não foi afetada).
--   5. `public.supplier_tmp` não existe mais em `information_schema.tables`.
--   6. `postgres`/`service_role` seguem executando `fn_delete_all_emails()` — a ferramenta de
--      limpeza pelo SQL Editor continua disponível.
