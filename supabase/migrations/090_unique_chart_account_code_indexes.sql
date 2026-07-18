-- 090_unique_chart_account_code_indexes.sql
-- Unicidade CASE-INSENSITIVE do código de grupo e subgrupo do plano de contas — fecha o
-- TOCTOU do create (a checagem em `assertCodeUnique` usa `ilike`, mas sem constraint no
-- banco duas requisições concorrentes podiam inserir o mesmo código). Índice em
-- lower(code) para casar a semântica do ilike; PARCIAL excluindo o sentinela id 0
-- (padrão do projeto; o app já impede colidir com o sentinela via assertCodeUnique).
-- Pré-verificado: 0 duplicatas case-insensitive em ambas as tabelas.
-- APLICADA DIRETO VIA SUPABASE MCP (histórico). Idempotente — não reaplicar no SQL Editor.

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_coa_group_code_lower
  ON public.financial_chart_of_account_group (lower(group_code))
  WHERE chart_account_group_id <> 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_coa_subgroup_code_lower
  ON public.financial_chart_of_account_subgroup (lower(subgroup_code))
  WHERE chart_account_subgroup_id <> 0;
