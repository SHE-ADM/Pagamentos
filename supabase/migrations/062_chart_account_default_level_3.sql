-- =============================================================
-- 062_chart_account_default_level_3.sql
-- Altera o DEFAULT de financial_chart_of_account.account_level de 2 para 3.
--
-- Motivo: o nivel padrao de um novo plano de contas passa a ser 3
-- (novos INSERTs sem account_level explicito assumem 3).
--
-- Escopo: apenas o DEFAULT da coluna. NAO faz backfill dos registros
-- existentes (account_level ja gravado permanece inalterado).
-- Idempotente (SET DEFAULT e absoluto, pode ser reaplicado).
--
-- Projeto: pagamentos | Data: 2026-07-01
-- =============================================================

BEGIN;

ALTER TABLE financial_chart_of_account
  ALTER COLUMN account_level SET DEFAULT 3;

COMMIT;
