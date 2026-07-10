-- Migration 076 — Etapa 1: visibilidade de contas por DONO, controlada por GRUPO
--
-- Contexto: controlar QUEM VÊ/pesquisa cada conta de `financial_account_control`, por grupo:
--   - Comercial (group_id=6) → vê só as contas gravadas por ele (created_by = auth.uid()).
--   - Financeiro (7) e demais → veem tudo (comportamento atual preservado).
-- Mecanismo OPT-IN por grupo (flag em user_group) para não quebrar quem vê tudo hoje.
--
-- APLICADA via Supabase MCP em 2026-07-10 (base compartilhada dev/prod) — histórico; não reaplicar.
-- Idempotente-segura (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).
-- Etapa 2 (fora daqui): updated_by/status_changed_by, exibição do autor, auth_is_admin(), dimensões
-- do blueprint (docs/design/permissoes-por-grupo.md).

-- (a) Coluna de dono. Sentinela = teste@otimotex.com.br. NOT NULL + DEFAULT garante 100% de vínculo.
ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS created_by UUID NOT NULL
    DEFAULT 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e'
    REFERENCES auth.users(id) ON DELETE SET DEFAULT;
CREATE INDEX IF NOT EXISTS ix_fac_created_by ON financial_account_control (created_by);

-- (b) RPC: sender_email → UUID do usuário; não encontrado → sentinela (nunca NULL).
--     SECURITY DEFINER porque auth.users não é legível pelos papéis anon/authenticated.
CREATE OR REPLACE FUNCTION public.resolve_user_for_account(p_email text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT COALESCE(
    (SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1),
    'fe8d268d-2bc3-4418-8cae-65e426c3fb4e'::uuid);
$$;
REVOKE EXECUTE ON FUNCTION public.resolve_user_for_account(text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_user_for_account(text) TO service_role;

-- (c) Backfill: histórico atribuído ao usuário do sender_email (interno) ou ao sentinela.
UPDATE financial_account_control
  SET created_by = public.resolve_user_for_account(sender_email);

-- (d) Flag de visibilidade por GRUPO (opt-in; default = vê tudo).
ALTER TABLE public.user_group
  ADD COLUMN IF NOT EXISTS sees_only_own_accounts boolean NOT NULL DEFAULT false;
UPDATE public.user_group SET sees_only_own_accounts = true WHERE group_id = 6; -- Comercial

-- (e) Helper RLS: o grupo do usuário logado vê só as próprias?
CREATE OR REPLACE FUNCTION public.auth_group_sees_only_own()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT g.sees_only_own_accounts
       FROM public.user_profile p
       JOIN public.user_group g ON g.group_id = p.group_id
      WHERE p.user_id = auth.uid()), false);
$$;
GRANT EXECUTE ON FUNCTION public.auth_group_sees_only_own() TO authenticated;

-- (f) Nova policy SELECT: grupo sem flag → vê tudo (default); grupo com flag → só as próprias.
--     service_role continua com bypass (policy service_role_all_*). Ponto de extensão futuro:
--     acrescentar `OR public.auth_is_admin()` e as dimensões do blueprint.
DROP POLICY IF EXISTS authenticated_select_financial_account_control ON financial_account_control;
CREATE POLICY authenticated_select_financial_account_control
  ON financial_account_control FOR SELECT TO authenticated
  USING ( NOT public.auth_group_sees_only_own() OR created_by = auth.uid() );
