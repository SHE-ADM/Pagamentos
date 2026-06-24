-- =============================================================
-- 047_add_cost_center_chart_account.sql
-- Classificação contábil em `financial_account_control`: vincula a conta a pagar
-- a um centro de custo e a um plano de contas (cadastros pré-existentes,
-- PRESERVADOS em limpezas). Ambas as colunas são NULL-áveis — o lançamento rápido
-- não obriga a classificação; é curadoria opcional.
--
-- Projeto: pagamentos | Data: 2026-06-24
-- =============================================================

BEGIN;

-- 1. Colunas de classificação (smallint, espelham o tipo das PKs referenciadas).
ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS cost_center_id   SMALLINT,
  ADD COLUMN IF NOT EXISTS chart_account_id SMALLINT;

-- 2. FKs para os cadastros (idempotentes). ON DELETE RESTRICT: cadastro com uso
--    não pode ser removido sem antes desvincular as contas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_account_control'::regclass
       AND conname = 'fk_fac_cost_center'
  ) THEN
    ALTER TABLE financial_account_control
      ADD CONSTRAINT fk_fac_cost_center
      FOREIGN KEY (cost_center_id) REFERENCES financial_cost_center(cost_center_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_account_control'::regclass
       AND conname = 'fk_fac_chart_account'
  ) THEN
    ALTER TABLE financial_account_control
      ADD CONSTRAINT fk_fac_chart_account
      FOREIGN KEY (chart_account_id) REFERENCES financial_chart_of_account(chart_account_id);
  END IF;
END $$;

-- 3. Índices para os JOINs/filtros por classificação.
CREATE INDEX IF NOT EXISTS idx_fac_cost_center_id   ON financial_account_control (cost_center_id);
CREATE INDEX IF NOT EXISTS idx_fac_chart_account_id ON financial_account_control (chart_account_id);

COMMIT;
