-- 092_subgroup_fixed_variable_classification.sql
-- Classifica financial_chart_of_account_subgroup.type_group_id em "Despesas Fixas"
-- (id 5) / "Despesas Variáveis" (id 6) — linhas já existentes em financial_type_group,
-- criadas manualmente pelo usuário em 2026-07-20.
--
-- Fonte da classificação: revisão de coerência de financial_chart_of_account_group
-- (2026-07-20) — critério de contabilidade gerencial (variável = escala com volume de
-- vendas/produção/compras/expedição; fixa = estrutural/administrativa/recorrente por
-- período). O grupo pai (financial_chart_of_account_group) permanece genérico em
-- type_group_id=2 "Despesas" — a classificação fina vive só no subgrupo.
--
-- Propagação via o FK subgroup.chart_account_group_id -> group.chart_account_group_id:
-- todo subgrupo cujo grupo pai é "Despesa" (group.type_group_id=2) recebe Fixa ou
-- Variável conforme o group_code do pai; subgrupos de grupos não-despesa (sentinela 0,
-- 3 Deduções da Receita, 4 Passivo Tributário) permanecem em type_group_id=0
-- "Não informado" — não fazem parte dessa dicotomia.
--
-- Códigos de grupo classificados como VARIÁVEL (16): 6, 16, 20, 21, 22, 23, 24, 32,
-- 48, 49, 50, 51, 52, 53, 58, 72. Os demais 50 códigos de despesa (7-73, exceto os
-- acima e os já removidos 15/44) são FIXA.
--
-- Pré-verificado: 155 subgrupos totais -> 110 Fixa / 37 Variável / 8 fora de escopo
-- (não-despesa, inalterados). APLICADA DIRETO VIA SUPABASE MCP (histórico).
-- Idempotente — não reaplicar no SQL Editor.

UPDATE public.financial_chart_of_account_subgroup s
SET type_group_id = CASE
    WHEN g.group_code IN ('6','16','20','21','22','23','24','32','48','49','50','51','52','53','58','72')
      THEN 6  -- Despesas Variáveis
    ELSE 5    -- Despesas Fixas
  END
FROM public.financial_chart_of_account_group g
WHERE g.chart_account_group_id = s.chart_account_group_id
  AND g.type_group_id = 2;
