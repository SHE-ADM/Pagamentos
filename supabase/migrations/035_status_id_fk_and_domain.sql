-- =============================================================
-- 035_status_id_fk_and_domain.sql
-- Relaciona financial_account_control.status_id → status(status_id) e alinha o
-- domínio textual de `status` à tabela `status`.
-- Projeto: pagamentos | Data: 2026-06-18
--
-- O usuário adicionou a coluna `status_id` (smallint) e a tabela de dimensão
-- `status` (status_id, status_name, status_short_name, has_opened/closed/invoiced)
-- com 10 valores. Esta migration:
--   1. Reduz o CHECK de `status` aos 10 valores existentes em `status` — remove
--      'pago protesto', 'pago cartório' e 'não pago' (0 linhas usam — verificado).
--   2. Estende a trigger de situação para resolver status_id a partir do texto.
--   3. Cria a FK status_id → status(status_id) + índice.
--   4. Backfill idempotente de status_id.
-- supplier_id já é resolvido por supplier_name (entre CNPJ/CPF/e-mail) pela trigger
-- trg_fe_resolve_supplier + FK fk_fe_supplier (migrations 018/027/028) — inalterado.
-- =============================================================

-- 1. Domínio de `status` = os 10 valores da tabela `status`.
ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_status_check;
ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_status_check CHECK (status IN (
    'pendente', 'vencido', 'a vencer', 'prorrogado', 'baixado',
    'protestado', 'cartório', 'pago', 'cancelado', 'falha'
  ));

-- 2. Trigger de situação (migration 034) passa a também sincronizar status_id.
--    SECURITY DEFINER: o SELECT em `status` precisa funcionar mesmo quando quem
--    dispara o UPDATE é o papel `authenticated` (edição das flags de curadoria),
--    sem depender de RLS na tabela `status`.
CREATE OR REPLACE FUNCTION fn_set_status_from_due_date()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ref_date DATE;
BEGIN
  -- Situação de vencimento: só recalcula quando há vencimento e o status está
  -- "em aberto" (preserva falha/pago/baixado/cancelado/protestado/cartório/prorrogado).
  IF NEW.due_date IS NOT NULL
     AND (NEW.status IS NULL OR NEW.status IN ('pendente', 'a vencer', 'vencido')) THEN
    ref_date := (COALESCE(NEW.extracted_at, NOW()) AT TIME ZONE 'America/Sao_Paulo')::date;
    IF NEW.due_date >= ref_date THEN
      NEW.status := 'a vencer';
    ELSE
      NEW.status := 'vencido';
    END IF;
  END IF;

  -- Sincroniza status_id com o status textual final (coluna única — migration 034).
  SELECT s.status_id INTO NEW.status_id
    FROM status s
   WHERE s.status_name = NEW.status;

  RETURN NEW;
END;
$$;

-- A trigger trg_fe_status_vencimento (034) já aponta para esta função — não recriar.

-- 3. FK status_id → status(status_id) + índice (idempotentes).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_account_control'::regclass
       AND conname = 'fk_fac_status'
  ) THEN
    ALTER TABLE financial_account_control
      ADD CONSTRAINT fk_fac_status FOREIGN KEY (status_id) REFERENCES status(status_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fac_status_id ON financial_account_control (status_id);

-- 4. Backfill idempotente: alinha status_id ao status textual de cada linha.
UPDATE financial_account_control fac
   SET status_id = s.status_id
  FROM status s
 WHERE s.status_name = fac.status
   AND fac.status_id IS DISTINCT FROM s.status_id;
