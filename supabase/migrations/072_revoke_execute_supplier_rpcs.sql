-- 072_revoke_execute_supplier_rpcs.sql
-- ============================================================================
-- Segurança S2-1 (BLOQUEADOR de go-live) — auditoria 2026-07-08.
--
-- Problema: as RPCs SECURITY DEFINER de resolução/enriquecimento de fornecedor
-- vivem no schema `public` (expostas como RPC pelo PostgREST) com EXECUTE default
-- para PUBLIC, anon e authenticated. Como SECURITY DEFINER roda como owner e
-- IGNORA RLS, um chamador anon/authenticated (só com a anon key) chama
--   POST /rest/v1/rpc/resolve_supplier_id  (ou _add_supplier_email, etc.)
-- e ESCREVE na tabela `supplier`, contornando o REVOKE de escrita das migrations
-- 056/057. Ref.: docs/review/seguranca/RELATORIO-SEGURANCA.md §2.
--
-- Correção: revogar EXECUTE de PUBLIC + anon + authenticated nas 6 funções,
-- MANTENDO service_role (o pipeline Python resolve fornecedor via service_role).
-- Revogar só de PUBLIC seria insuficiente: o ACL tem grants EXPLÍCITOS a
-- anon/authenticated (default do Supabase p/ funções em public) — precisam sair
-- individualmente. Chamadas internas entre as funções (ex.:
-- resolve_supplier_for_account -> resolve_supplier_id) NÃO quebram: rodam sob o
-- owner (postgres) da SECURITY DEFINER externa, que mantém EXECUTE.
--
-- Assinaturas confirmadas em pg_proc (projeto Financeiro, 2026-07-08) — uma
-- sobrecarga por função (o 3-arg de resolve_supplier_id foi dropado na 027).
--
-- Idempotente: REVOKE de grant inexistente é no-op; GRANT a service_role é seguro
-- reexecutar.
--
-- >>> APLICAÇÃO MANUAL no Supabase SQL Editor (staging -> produção). <<<
-- ============================================================================

-- 1) Entradas de RPC chamadas pelo pipeline (só service_role deve executar):
REVOKE EXECUTE ON FUNCTION public.resolve_supplier_for_account(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_supplier_for_account(text, text, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_supplier_id(text, text, text, text)          FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_supplier_id(text, text, text, text)          TO service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_company_id(text, text)                       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_company_id(text, text)                       TO service_role;

-- 2) Helpers de enriquecimento/e-mail (escrevem em supplier; nunca expostos ao cliente):
REVOKE EXECUTE ON FUNCTION public._enrich_supplier(bigint, text, text)                 FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._enrich_supplier(bigint, text, text)                 TO service_role;

REVOKE EXECUTE ON FUNCTION public._enrich_supplier_name(bigint, text)                  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._enrich_supplier_name(bigint, text)                  TO service_role;

REVOKE EXECUTE ON FUNCTION public._add_supplier_email(bigint, text)                    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._add_supplier_email(bigint, text)                    TO service_role;

-- ============================================================================
-- VERIFICAÇÃO (rodar após aplicar — esperado: sem 'X' para PUBLIC/anon/authenticated;
-- 'service_role=X' e 'postgres=X' presentes em cada linha):
--
-- SELECT p.proname,
--        pg_get_function_identity_arguments(p.oid) AS args,
--        p.proacl::text AS acl
-- FROM   pg_proc p
-- JOIN   pg_namespace n ON n.oid = p.pronamespace
-- WHERE  n.nspname = 'public'
--   AND  p.proname IN ('resolve_supplier_id','resolve_supplier_for_account',
--                      'resolve_company_id','_enrich_supplier',
--                      '_enrich_supplier_name','_add_supplier_email')
-- ORDER  BY p.proname, args;
-- ============================================================================
