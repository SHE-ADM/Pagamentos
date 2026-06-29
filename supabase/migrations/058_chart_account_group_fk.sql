-- 058_chart_account_group_fk.sql
-- Formaliza a relação direta financial_chart_of_account.chart_account_group_id ->
-- financial_chart_of_account_group.chart_account_group_id. A coluna já existia
-- (SMALLINT NOT NULL? -> nullable, DEFAULT 0 = "não informado"), mas SEM FK — sem ela
-- o PostgREST não resolve o embed `group:financial_chart_of_account_group(...)` usado
-- pela grade e pelo detalhe de /tabelas/plano-de-contas.
--
-- Pré-condição verificada (2026-06-29): não há valores órfãos — todo chart_account_group_id
-- de financial_chart_of_account existe em financial_chart_of_account_group (inclui o
-- sentinela id 0). A constraint, portanto, não falha.
--
-- ON DELETE/UPDATE NO ACTION (default): impede excluir/renumerar um grupo em uso.
-- Índice parcial (ignora o sentinela 0) acompanha o padrão das demais FKs de classificação.

ALTER TABLE financial_chart_of_account
  ADD CONSTRAINT fk_fin_coa_group
  FOREIGN KEY (chart_account_group_id) REFERENCES financial_chart_of_account_group (chart_account_group_id);

CREATE INDEX IF NOT EXISTS ix_fin_coa_group
  ON financial_chart_of_account (chart_account_group_id)
  WHERE chart_account_group_id <> 0;
