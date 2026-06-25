-- =============================================================
-- 051_classification_cadastros_generated_identity.sql
-- Converte as PKs dos cadastros de classificação contábil (smallint NOT NULL
-- DEFAULT 0) para colunas de identidade GENERATED ALWAYS AS IDENTITY, no mesmo
-- padrão da migration 050 (`financial_chart_of_account.chart_account_id`).
--
-- Tabelas / colunas afetadas:
--   financial_account                    -> financial_account_id
--   financial_chart_of_account_group     -> chart_account_group_id
--   financial_chart_of_account_subgroup  -> chart_account_subgroup_id
--   financial_cost_center                -> cost_center_id
--
-- Por que ALWAYS: o id passa a ser gerado SEMPRE pelo banco e a inserção
-- explícita de valor fica BLOQUEADA (exige OVERRIDING SYSTEM VALUE) — garante
-- que toda nova linha do cadastro receba um id sequencial sob controle do banco.
--
-- As FKs que referenciam essas PKs NÃO são afetadas (o tipo permanece smallint).
--
-- Projeto: pagamentos | Data: 2026-06-25
-- =============================================================

BEGIN;

-- financial_account.financial_account_id
ALTER TABLE financial_account
  ALTER COLUMN financial_account_id DROP DEFAULT;
ALTER TABLE financial_account
  ALTER COLUMN financial_account_id ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(
  pg_get_serial_sequence('financial_account', 'financial_account_id'),
  (SELECT MAX(financial_account_id) FROM financial_account)
);

-- financial_chart_of_account_group.chart_account_group_id
ALTER TABLE financial_chart_of_account_group
  ALTER COLUMN chart_account_group_id DROP DEFAULT;
ALTER TABLE financial_chart_of_account_group
  ALTER COLUMN chart_account_group_id ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(
  pg_get_serial_sequence('financial_chart_of_account_group', 'chart_account_group_id'),
  (SELECT MAX(chart_account_group_id) FROM financial_chart_of_account_group)
);

-- financial_chart_of_account_subgroup.chart_account_subgroup_id
ALTER TABLE financial_chart_of_account_subgroup
  ALTER COLUMN chart_account_subgroup_id DROP DEFAULT;
ALTER TABLE financial_chart_of_account_subgroup
  ALTER COLUMN chart_account_subgroup_id ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(
  pg_get_serial_sequence('financial_chart_of_account_subgroup', 'chart_account_subgroup_id'),
  (SELECT MAX(chart_account_subgroup_id) FROM financial_chart_of_account_subgroup)
);

-- financial_cost_center.cost_center_id
ALTER TABLE financial_cost_center
  ALTER COLUMN cost_center_id DROP DEFAULT;
ALTER TABLE financial_cost_center
  ALTER COLUMN cost_center_id ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(
  pg_get_serial_sequence('financial_cost_center', 'cost_center_id'),
  (SELECT MAX(cost_center_id) FROM financial_cost_center)
);

COMMIT;
