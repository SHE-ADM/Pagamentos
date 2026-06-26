-- 057_revoke_write_supplier_status.sql
-- SEGURANÇA (defesa em profundidade — auditoria 2026-06-26, RELATORIO-SEGURANCA §2).
-- IDEMPOTENTE (re-executável): REVOGA do papel `authenticated` o grant de escrita
-- (INSERT/UPDATE/DELETE) residual em `supplier` e `status`.
--
-- Contexto (verificado no banco em 2026-06-26): o RLS dessas tabelas JÁ bloqueia 100%
-- da escrita por `authenticated` — ambas só têm política de SELECT, então toda
-- INSERT/UPDATE/DELETE é negada por RLS independentemente do grant. Porém o grant
-- DEFAULT do Supabase para o papel `authenticated` permanecia presente. Esta migration
-- remove esse grant para SIMETRIA com os demais cadastros (056) e como rede secundária
-- (caso o RLS seja desabilitado por engano no futuro). A escrita continua só por
-- `service_role` (pipeline Python + Next API), que IGNORA RLS e mantém seus grants.
--
-- NÃO altera políticas, dados nem o grant de SELECT. Não toca em
-- `financial_account_control`/`email_control`, cujas colunas de curadoria (has_invoice/
-- has_bank_slip/status; reviewed_at) dependem de grants por coluna intencionais (033/036/030).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['supplier', 'status'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    ELSE
      RAISE NOTICE 'Tabela % não encontrada — pulando.', t;
    END IF;
  END LOOP;
END $$;
