-- =============================================================
-- 050_chart_account_id_generated_identity.sql
-- Converte `financial_chart_of_account.chart_account_id` (smallint NOT NULL
-- DEFAULT 0) para coluna de identidade GENERATED ALWAYS AS IDENTITY.
--
-- Por que ALWAYS: o id passa a ser gerado SEMPRE pelo banco e a inserção
-- explícita de valor fica BLOQUEADA (exige OVERRIDING SYSTEM VALUE) — garante
-- que toda nova linha do cadastro receba um id sequencial sob controle do banco.
--
-- A FK `financial_account_control.chart_account_id` -> aqui NÃO é afetada
-- (o tipo permanece smallint).
--
-- Projeto: pagamentos | Data: 2026-06-25
-- =============================================================

BEGIN;

-- 1. Remover o DEFAULT 0 — pré-requisito para anexar a identidade à coluna.
ALTER TABLE financial_chart_of_account
  ALTER COLUMN chart_account_id DROP DEFAULT;

-- 2. Anexar a identidade (auto-incremento) gerada SEMPRE pelo banco — sem
--    permitir inclusão direta de id.
ALTER TABLE financial_chart_of_account
  ALTER COLUMN chart_account_id ADD GENERATED ALWAYS AS IDENTITY;

-- 3. Alinhar a sequence de identidade acima do maior id existente, para que o
--    próximo valor gerado não colida com os cadastros já existentes.
SELECT setval(
  pg_get_serial_sequence('financial_chart_of_account', 'chart_account_id'),
  (SELECT MAX(chart_account_id) FROM financial_chart_of_account)
);

COMMIT;
