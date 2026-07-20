-- 093_subgroup_fixed_variable_refinement.sql
-- Refina a classificação de financial_chart_of_account_subgroup.type_group_id
-- (Despesas Fixas id=5 / Despesas Variáveis id=6), aplicada em bloco pela migration 092
-- herdando cegamente o group_code do pai. Nesta migration a decisão passa a ser POR
-- SUBGRUPO, usando o nome de cada subgrupo (não mais o grupo inteiro) para julgar se o
-- custo escala com volume de vendas/produção/compras/expedição.
--
-- Baseline: todo subgrupo de grupo "Despesa" (group.type_group_id=2) vira Fixa (5).
-- Depois, os subgrupos abaixo são sobrescritos para Variável (6) por indicarem custo
-- proporcional a volume:
--
--   6.3 Tributos Não Recuperáveis            21.1 Compras de Mercadorias
--   16.2 Representação Comercial             23.1/23.2 Aduaneiras / Serv. Importação
--   18.1 Viagens Comerciais                  31.2 Cobrança Bancária
--   20.1/20.2 Material / Ações Comerciais    32.1-32.3 + Taxa cartão crédito
--   33.1 Cobrança / 33.3 Análise de Crédito  48.1/48.2 Fretes / Transportadoras
--   49.1/49.2 Depósitos / Serv. Armazenagem  50.1/50.2 Expedição / Recebimento
--   51.1/51.2 Entregas / Ocorrências Entrega 52.1/52.2 Movimentação / Mat. Logísticos
--   53.1 Seguros de Transporte               58.1 Combustíveis
--   72.1 Industrialização por Terceiros
--
-- Exemplos de refinamento vs. a herança em bloco da 092 (grupo inteiro deixa de ser
-- uniforme): grupo 6 "Despesas Tributárias" era 100% Variável, agora só 6.3 é (o resto —
-- taxas, multas, tributos patrimoniais, obrigações acessórias — é periódico, não
-- proporcional a venda); grupos 22 "Despesas com Fornecedores" e 24 "Despesas com
-- Negociação e Suprimentos" eram 100% Variável, viram 100% Fixa (homologação,
-- desenvolvimento de fornecedor e viagens de negociação são estruturais/ocasionais, não
-- por transação de compra); grupo 16 "Despesas com Vendas" se divide (16.1 Equipe
-- Comercial = folha/Fixa, 16.2 Representação Comercial = comissão/Variável).
--
-- Pré-verificado: 155 subgrupos totais -> 119 Fixa / 28 Variável / 8 fora de escopo
-- (não-despesa, inalterados desde a 092). APLICADA DIRETO VIA SUPABASE MCP (histórico).
-- Idempotente — não reaplicar no SQL Editor.

UPDATE public.financial_chart_of_account_subgroup s
SET type_group_id = 5
FROM public.financial_chart_of_account_group g
WHERE g.chart_account_group_id = s.chart_account_group_id
  AND g.type_group_id = 2;

UPDATE public.financial_chart_of_account_subgroup
SET type_group_id = 6
WHERE chart_account_subgroup_id IN (
  61, 84, 87, 91, 92, 93, 97, 98, 109, 111, 112, 114, 115, 113, 117,
  153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 176, 204
);
