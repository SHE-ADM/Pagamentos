-- 056_rls_cadastros_preexistentes.sql
-- SEGURANÇA (auditoria 2026-06-26, RELATORIO-SEGURANCA §2 M1/M2/B1). DEFENSIVA e
-- IDEMPOTENTE (re-executável): fecha o ponto cego de RLS dos cadastros PRÉ-EXISTENTES
-- (criados fora do versionamento — company, financial_account, financial_bank, grupos/
-- subgrupos do plano de contas), garantindo o padrão do projeto:
--   • RLS habilitado;
--   • leitura `TO authenticated` (lookup/embeds da UI);
--   • ESCRITA só `service_role` (REVOKE de INSERT/UPDATE/DELETE do papel `authenticated`).
-- service_role IGNORA RLS, então a Next API (escrita) e os scripts Python seguem
-- funcionando — esta migration só remove a possibilidade de um usuário autenticado
-- escrever/excluir esses cadastros direto pelo REST do PostgREST.
--
-- ┌─ ATENÇÃO (pré-condição operacional) ───────────────────────────────────────┐
-- │ VERIFIQUE o estado atual no SQL Editor ANTES de aplicar (queries em          │
-- │ supabase/migrations/README.md). Esta migration ASSUME que estes cadastros    │
-- │ devem ser APENAS-LEITURA para o papel `authenticated`. Se algum precisar de  │
-- │ escrita por authenticated, ajuste antes de rodar. NÃO aplicada automaticamente│
-- │ (migrations são manuais).                                                    │
-- └──────────────────────────────────────────────────────────────────────────────┘

-- 1) Cadastros pré-existentes: RLS + SELECT authenticated + REVOKE de escrita.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'company',
    'financial_account',
    'financial_bank',
    'financial_chart_of_account_group',
    'financial_chart_of_account_subgroup'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = t
          AND policyname = 'authenticated read ' || t
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
          'authenticated read ' || t, t);
      END IF;
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    ELSE
      RAISE NOTICE 'Tabela % não encontrada — pulando (verifique o estado no go-live).', t;
    END IF;
  END LOOP;
END $$;

-- 2) Defesa em profundidade nos cadastros de classificação (a 049 só concedeu SELECT;
--    aqui REVOGAMOS escrita do authenticated como rede secundária — RELATORIO §2 B1).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'financial_cost_center') THEN
    REVOKE INSERT, UPDATE, DELETE ON public.financial_cost_center FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'financial_chart_of_account') THEN
    REVOKE INSERT, UPDATE, DELETE ON public.financial_chart_of_account FROM authenticated;
  END IF;
END $$;

-- 3) audit_log: se EXISTIR, habilita RLS + policy de leitura + REVOKE de escrita. Se NÃO
--    existir, NÃO criamos aqui (schema desconhecido) — crie a tabela de auditoria numa
--    migration dedicada (RELATORIO-SEGURANCA §2 M2 / padrão Sheild exige audit_log).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log') THEN
    ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'audit_log'
        AND policyname = 'authenticated read audit_log'
    ) THEN
      CREATE POLICY "authenticated read audit_log" ON public.audit_log
        FOR SELECT TO authenticated USING (true);
    END IF;
    REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM authenticated;
  ELSE
    RAISE NOTICE 'audit_log não existe — criar em migration dedicada (RELATORIO-SEGURANCA §2 M2).';
  END IF;
END $$;
