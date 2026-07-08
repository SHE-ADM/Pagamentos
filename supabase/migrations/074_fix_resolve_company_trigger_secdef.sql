-- 074_fix_resolve_company_trigger_secdef.sql
-- ============================================================================
-- Correção de REGRESSÃO da migration 072 (não regredir).
--
-- Sintoma: ao marcar NF/BOL (curadoria) ou trocar a situação em /consulta, o
-- PATCH em financial_account_control feito pelo papel `authenticated` falhava com
--   403 { code: 42501, message: "permission denied for function resolve_company_id" }.
--
-- Causa: o trigger BEFORE INSERT/UPDATE `trg_fe_company_id` executa a função
-- `trg_fe_resolve_company()` (SECURITY INVOKER = roda como o CHAMADOR), que chama
-- `resolve_company_id(NEW.payer_cnpj, NEW.payer_name)`. A migration 072 revogou o
-- EXECUTE de `resolve_company_id` de PUBLIC/anon/authenticated (S2-1) — correto para
-- barrar a chamada RPC direta —, mas o trigger passou a rodar como `authenticated`,
-- que já não tem EXECUTE, quebrando TODO UPDATE do frontend (curadoria + situação).
--
-- Correção: tornar a FUNÇÃO DO TRIGGER `SECURITY DEFINER` (owner = postgres, que
-- mantém EXECUTE). Assim o trigger chama `resolve_company_id` como postgres; o
-- `authenticated` nunca precisa de EXECUTE direto e o vetor S2-1 continua fechado
-- (a RPC direta `POST /rest/v1/rpc/resolve_company_id` por anon/authenticated segue
-- devolvendo 42501). Comportamento inalterado: o company_id já era resolvido em todo
-- write (inclusive os do `authenticated`); só muda o papel sob o qual o trigger roda.
--
-- Boas práticas de SECURITY DEFINER: `search_path` fixo + chamada QUALIFICADA
-- (public.resolve_company_id) — evita sequestro de search_path.
--
-- Idempotente (CREATE OR REPLACE). Aplicada via Supabase MCP em 2026-07-08.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_fe_resolve_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.company_id := public.resolve_company_id(NEW.payer_cnpj, NEW.payer_name);
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- VERIFICAÇÃO (após aplicar):
--   -- (1) a função do trigger virou SECURITY DEFINER:
--   SELECT proname, prosecdef, proconfig FROM pg_proc
--   WHERE proname = 'trg_fe_resolve_company';   -- prosecdef = true
--   -- (2) o UPDATE de curadoria como `authenticated` não levanta 42501:
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     UPDATE financial_account_control SET has_invoice = has_invoice
--     WHERE id = (SELECT id FROM financial_account_control LIMIT 1);
--   ROLLBACK;
-- ============================================================================
