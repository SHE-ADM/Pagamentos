-- 091_cleanup_chart_account_group_data.sql
-- Higiene de dados em financial_chart_of_account_group (achados da revisão de coerência
-- de 2026-07-20). Item 1 (unicidade de group_code) já resolvido pela migration 090
-- (uq_fin_coa_group_code_lower) — não repetido aqui.
--
-- 1) group_type='D' nos 2 grupos que ficaram NULL por lacuna de cadastro (todos os
--    demais códigos 6-73, mesmo type_group_id=2/Despesas, já são 'D'):
--    código 26 "Despesas de Representação" e 63 "Benefícios".
-- 2) Sentinela id 0 ("não informado", group_description já NULL): group_type
--    normalizado de ' ' (espaço) para NULL, consistente com o resto da linha.
-- 3) Hard delete dos grupos 15 "Despesas Jurídicas" e 44 "Processos Judiciais" —
--    cadastrados sem nenhum subgrupo/plano de contas vinculado (0/0) e conceitualmente
--    substituídos pela granularidade que veio depois (43 Assessoria Jurídica,
--    46 Contratos e Compliance Legal, 47 Contingências e Acordos). Pré-verificado:
--    0 referências em financial_chart_of_account_subgroup e financial_chart_of_account.
--    Mesmo padrão de hard delete já usado pelo CRUD deste cadastro (grupo Administrador).
-- Idempotente (UPDATE por valor final / DELETE por code, sem efeito em reexecução).

UPDATE public.financial_chart_of_account_group
SET group_type = 'D'
WHERE group_code IN ('26', '63')
  AND group_type IS NULL;

UPDATE public.financial_chart_of_account_group
SET group_type = NULL
WHERE chart_account_group_id = 0
  AND group_type = ' ';

DELETE FROM public.financial_chart_of_account_group
WHERE group_code IN ('15', '44')
  AND NOT EXISTS (
    SELECT 1 FROM public.financial_chart_of_account_subgroup s
    WHERE s.chart_account_group_id = financial_chart_of_account_group.chart_account_group_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.financial_chart_of_account ca
    WHERE ca.chart_account_group_id = financial_chart_of_account_group.chart_account_group_id
  );
