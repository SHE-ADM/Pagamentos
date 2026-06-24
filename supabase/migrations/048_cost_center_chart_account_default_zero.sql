-- =============================================================
-- 048_cost_center_chart_account_default_zero.sql
-- Classificação contábil "não informada" = 0 (sentinela). Os cadastros
-- financial_cost_center e financial_chart_of_account já possuem a linha id = 0
-- (placeholder sem código/descrição), então 0 é um alvo de FK válido. Torna as
-- colunas NOT NULL DEFAULT 0: o pipeline e o CRUD que omitem a classificação
-- gravam 0 automaticamente, em vez de NULL.
--
-- Complementa a migration 047 (que criou as colunas NULL-áveis + FKs).
-- Projeto: pagamentos | Data: 2026-06-24
-- =============================================================

BEGIN;

-- 1. Backfill: linhas já existentes sem classificação passam a 0.
UPDATE financial_account_control SET cost_center_id   = 0 WHERE cost_center_id   IS NULL;
UPDATE financial_account_control SET chart_account_id = 0 WHERE chart_account_id IS NULL;

-- 2. DEFAULT 0 + NOT NULL.
ALTER TABLE financial_account_control
  ALTER COLUMN cost_center_id   SET DEFAULT 0,
  ALTER COLUMN cost_center_id   SET NOT NULL,
  ALTER COLUMN chart_account_id SET DEFAULT 0,
  ALTER COLUMN chart_account_id SET NOT NULL;

COMMIT;
