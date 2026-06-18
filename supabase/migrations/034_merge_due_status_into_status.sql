-- =============================================================
-- 034_merge_due_status_into_status.sql
-- Funde due_status em status (coluna única) em financial_account_control.
-- Projeto: pagamentos | Data: 2026-06-18
--
-- Contexto: status (ciclo de vida: pendente/falha/…) e due_status (situação de
-- vencimento, calculada pela trigger) tinham domínio idêntico e se sobrepunham.
-- O grid exibia due_status, mas o filtro "Situação" filtrava status → inconsistência.
-- Passamos a usar SÓ `status`, carregando a situação de vencimento.
--
-- Trigger com GUARD (decisão de negócio): a situação de vencimento ('a vencer'/
-- 'vencido') só é (re)calculada quando o status está EM ABERTO
-- (NULL/pendente/a vencer/vencido). Estados não-automáticos — 'falha' (extração),
-- e futuros 'pago'/'baixado'/'cancelado'/'prorrogado'/… — são PRESERVADOS, para a
-- fusão ser segura quando houver baixa/CRUD manual.
-- =============================================================

-- 1. Nova função: grava a situação de vencimento direto em NEW.status (com guard).
CREATE OR REPLACE FUNCTION fn_set_status_from_due_date()
RETURNS TRIGGER AS $$
DECLARE
  ref_date DATE;
BEGIN
  -- Sem vencimento: mantém o status como está (não há situação a derivar).
  IF NEW.due_date IS NULL THEN
    RETURN NEW;
  END IF;

  -- Só recalcula quando o status está "em aberto"; preserva falha/pago/baixado/
  -- cancelado/protestado/cartório/prorrogado/não pago/pago protesto/pago cartório.
  IF NEW.status IS NULL OR NEW.status IN ('pendente', 'a vencer', 'vencido') THEN
    ref_date := (COALESCE(NEW.extracted_at, NOW()) AT TIME ZONE 'America/Sao_Paulo')::date;
    IF NEW.due_date >= ref_date THEN
      NEW.status := 'a vencer';
    ELSE
      NEW.status := 'vencido';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Substitui a trigger antiga (que escrevia due_status) pela nova (escreve status).
DROP TRIGGER IF EXISTS trg_fe_due_status ON financial_account_control;
DROP TRIGGER IF EXISTS trg_fe_status_vencimento ON financial_account_control;
CREATE TRIGGER trg_fe_status_vencimento
  BEFORE INSERT OR UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION fn_set_status_from_due_date();

-- A função antiga deixa de ser usada (referenciava a coluna que será removida).
DROP FUNCTION IF EXISTS fn_set_due_status();

-- 3. Backfill: move a situação de vencimento para `status` nas linhas em aberto;
--    preserva 'falha' (e qualquer estado não-automático) ao restringir o WHERE.
UPDATE financial_account_control
   SET status = due_status
 WHERE due_status IS NOT NULL
   AND status IN ('pendente', 'a vencer', 'vencido');

-- 4. Remove a coluna e seu índice (agora redundantes).
DROP INDEX IF EXISTS idx_fac_due_status;
ALTER TABLE financial_account_control DROP COLUMN IF EXISTS due_status;

-- 5. `status` já tem CHECK do domínio completo (migration 018) e idx_fac_status —
--    nada a recriar.
