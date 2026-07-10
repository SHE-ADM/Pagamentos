-- Migration 077 — Etapa 2: auditoria de autor (quem editou / mudou o status) + view app_user
--
-- Complementa a 076 (created_by = dono): registra QUEM foi o último a EDITAR (updated_by) e a
-- MUDAR A SITUAÇÃO (status_changed_by + status_changed_at). Carimbo nos 3 caminhos de escrita via
-- trigger SECURITY DEFINER (espelha a 074): no caminho `authenticated` (curadoria REST direta) usa
-- auth.uid(); no `service_role` (Next API/Python) usa o valor explícito do payload; senão preserva.
--
-- APLICADA via Supabase MCP em 2026-07-10 (base compartilhada dev/prod) — histórico; não reaplicar.
-- Idempotente-segura.

-- (a) Colunas de auditoria (sentinela = teste@otimotex.com.br, igual created_by).
ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS updated_by UUID NOT NULL
    DEFAULT 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e' REFERENCES auth.users(id) ON DELETE SET DEFAULT,
  ADD COLUMN IF NOT EXISTS status_changed_by UUID NOT NULL
    DEFAULT 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e' REFERENCES auth.users(id) ON DELETE SET DEFAULT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- (b) Backfill: histórico = o criador (melhor aproximação sem log de alterações).
UPDATE financial_account_control
  SET updated_by = created_by, status_changed_by = created_by, status_changed_at = updated_at;

-- (c) Trigger de carimbo. Nome trg_fac_* roda ANTES de trg_fe_* (recálculo de status por vencimento)
--     → vê o status_id enviado pelo HUMANO, não o recálculo automático (que não conta como mudança).
CREATE OR REPLACE FUNCTION public.fn_stamp_account_authorship()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_by        := COALESCE(NEW.updated_by, NEW.created_by);
    NEW.status_changed_by := COALESCE(NEW.status_changed_by, NEW.created_by);
    NEW.status_changed_at := COALESCE(NEW.status_changed_at, now());
    RETURN NEW;
  END IF;
  actor := COALESCE(auth.uid(), NEW.updated_by);   -- authenticated: JWT; service_role: explícito
  NEW.updated_by := COALESCE(actor, OLD.updated_by);
  IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    NEW.status_changed_by := COALESCE(actor, OLD.status_changed_by);
    NEW.status_changed_at := now();
  ELSE
    NEW.status_changed_by := OLD.status_changed_by;
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_fac_authorship ON financial_account_control;
CREATE TRIGGER trg_fac_authorship
  BEFORE INSERT OR UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_account_authorship();

-- (d) View app_user (id → e-mail) para exibir o autor na UI. Usuários internos (decisão aprovada).
CREATE OR REPLACE VIEW public.app_user
  WITH (security_invoker = false) AS
  SELECT id, email FROM auth.users;
GRANT SELECT ON public.app_user TO authenticated;
