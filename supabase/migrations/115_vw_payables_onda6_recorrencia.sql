-- 115_vw_payables_onda6_recorrencia.sql
--
-- ONDA 6 (itens 6.6 e 6.7) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- Fecha a onda: (a) expõe as 5 colunas derivadas ao chat, (b) entrega a análise de recorrência por
-- CADÊNCIA e (c) entrega o parcelamento OBSERVADO, que substitui o `installment_total` inexistente.
--
-- Guardas deste arquivo: tests/test_onda6_campos_derivados.py (G1, G7).
--
-- ---------------------------------------------------------------------------
-- 🔴 A VIEW É REPRODUZIDA POR INTEIRO — CREATE OR REPLACE só ACRESCENTA no fim
-- ---------------------------------------------------------------------------
-- O PostgreSQL recusa replace que mude nome, ordem ou tipo de coluna existente. As 35 colunas da
-- migration 103 aparecem abaixo idênticas; as 5 novas entram DEPOIS de todas elas. Manter
-- `security_invoker = true`: é isso, e só isso, que faz a RLS da 076 valer para o chat.
--
-- IDEMPOTENTE (CREATE OR REPLACE em tudo). Reexecutar é no-op.

CREATE OR REPLACE VIEW analytics.vw_payables
WITH (security_invoker = true) AS
SELECT
    f.id                                                     AS payable_id,
    f.sk_company,
    c.trade_name                                             AS company_name,
    f.sk_supplier,
    COALESCE(NULLIF(btrim(s.trade_name), ''), s.legal_name)  AS supplier_name,
    s.cnpj                                                   AS supplier_cnpj,
    f.status_id,
    st.status_name,
    (f.status_id IN (1, 2, 3))                               AS is_open,       -- pendente/vencido/a vencer
    (f.status_id = 9)                                        AS is_cancelled,  -- fora dos totais por padrão
    f.issue_date,
    f.due_date,
    f.payment_date,
    f.amount,
    f.amount_charged,
    f.document_type,
    f.payment_method,
    f.invoice_number,
    f.cost_center_id,
    COALESCE(cc.cost_center_description, 'não informado')     AS cost_center_name,
    f.chart_account_id,
    COALESCE(ca.account_description, 'não informado')         AS chart_account_name,
    COALESCE(g.group_description, 'não informado')            AS chart_group_name,
    g.type_group_id                                           AS chart_group_nature_id,   -- 2=Despesas, 8=Custo
    COALESCE(sg.subgroup_description, 'não informado')        AS chart_subgroup_name,
    sg.type_group_id                                          AS chart_subgroup_type_id,  -- 5=Fixa, 6=Variável, 7=Custo merc.
    -- ---------- colunas ACRESCENTADAS pela migration 103 (sempre no FIM) ----------
    f.has_invoice,
    f.has_bank_slip,
    COALESCE(f.fine_interest, 0)::numeric(15,2)               AS fine_interest,
    COALESCE(f.other_additions, 0)::numeric(15,2)             AS other_additions,
    COALESCE(f.discount, 0)::numeric(15,2)                    AS discount,
    COALESCE(f.other_deductions, 0)::numeric(15,2)            AS other_deductions,
    f.extraction_source,
    COALESCE(tgs.type_group_description, 'não informado')     AS chart_subgroup_type_name,
    COALESCE(tgg.type_group_description, 'não informado')     AS chart_group_nature_name,
    -- ---------- colunas ACRESCENTADAS pela migration 115 (Onda 6) ----------
    f.competence_month,        -- competência (mês) — NÃO confundir com caixa; ~13% preenchido
    f.days_late,               -- 🔴 negativo = antecipado; NÃO agregar como DPO (ver COMMENT da coluna)
    f.extraction_confidence,   -- alta|media|baixa|manual|desconhecida
    f.installment_number,      -- ordinal da parcela; NULL quando não é inequivocamente parcela
    f.installment_base         -- documento do carnê (chave de agrupamento)
FROM public.financial_account_control f
JOIN public.company  c  ON c.sk_company  = f.sk_company
JOIN public.supplier s  ON s.sk_supplier = f.sk_supplier
JOIN public.status   st ON st.status_id  = f.status_id
LEFT JOIN public.financial_cost_center cc              ON cc.cost_center_id           = f.cost_center_id
LEFT JOIN public.financial_chart_of_account ca         ON ca.chart_account_id         = f.chart_account_id
LEFT JOIN public.financial_chart_of_account_group    g ON g.chart_account_group_id    = ca.chart_account_group_id
LEFT JOIN public.financial_chart_of_account_subgroup sg ON sg.chart_account_subgroup_id = ca.chart_account_subgroup_id
LEFT JOIN public.financial_type_group tgg              ON tgg.type_group_id           = g.type_group_id
LEFT JOIN public.financial_type_group tgs              ON tgs.type_group_id           = sg.type_group_id;

COMMENT ON VIEW analytics.vw_payables IS
  'Fact plano de contas a pagar com dimensões resolvidas. security_invoker: a RLS de '
  'financial_account_control (migration 076) se aplica ao usuário do JWT. A migration 103 '
  'acrescentou curadoria, componentes de boleto e os NOMES de natureza/tipo; a 115 acrescentou os '
  'campos derivados da Onda 6 (competência, atraso, confiança da extração e parcelamento).';

GRANT SELECT ON analytics.vw_payables TO authenticated;

-- ---------------------------------------------------------------------------
-- 6.6 — Recorrência por CADÊNCIA
-- ---------------------------------------------------------------------------
-- 🔴 POR CADÊNCIA, NUNCA POR VALOR. O roadmap mediu que apenas 3 de 11 fornecedores recorrentes
-- têm valor estável — classificar por valor descartaria 8 de 11 recorrentes REAIS. `valor_mediano`
-- e `valor_variacao_pct` são SAÍDA informativa, jamais critério.
--
-- 🔴 FUNÇÃO, não tabela materializada. Uma tabela seria calculada sobre a base inteira e lida por
-- um usuário restrito, mostrando cadência de fornecedores que ele não pode ver — furo de RLS. Além
-- de contrariar a decisão fechada "sem tabelas agregadas" (o gatilho de reabertura é tool > 500 ms;
-- 803 linhas não chegam perto). SECURITY INVOKER sobre a view faz a RLS valer naturalmente.
--
-- ---------------------------------------------------------------------------
-- O QUE É HONESTAMENTE DETECTÁVEL HOJE (e a função DECLARA isso na saída)
-- ---------------------------------------------------------------------------
-- Baseline 2026-08-10: 27 fornecedores com conta em >= 3 meses distintos, máximo 5 meses, faixa de
-- vencimentos 2026-02-26 a 2026-11-28.
--   mensal      -> detectável (é o único regime com N suficiente)
--   semanal/quinzenal -> detectável SE existir
--   bimestral   -> no limite: 3 observações exigiriam ~6 meses e o teto é 5 -> sai 'insuficiente'
--   trimestral/anual  -> NÃO detectável. Precisaria de 9 e 36 meses de histórico.
-- Por isso a saída traz `ocorrencias`, `intervalo_min_dias`, `intervalo_max_dias` e `confianca` ao
-- lado de `cadencia`: quem quiser só a palavra "mensal" terá de ignorar ativamente os campos que a
-- contradizem.

CREATE OR REPLACE FUNCTION analytics.fornecedores_recorrentes(
    p_min_ocorrencias integer DEFAULT 3,
    p_tolerancia_dias integer DEFAULT 5,
    p_date_from       date    DEFAULT NULL,
    p_date_to         date    DEFAULT NULL,
    p_limit           integer DEFAULT 50
)
RETURNS TABLE (
    sk_supplier            bigint,
    supplier_name          text,
    ocorrencias            integer,
    primeiro_vencimento    date,
    ultimo_vencimento      date,
    intervalo_mediano_dias numeric,
    intervalo_min_dias     integer,
    intervalo_max_dias     integer,
    cadencia               text,
    regular                boolean,
    confianca              text,
    parcelamento_provavel  boolean,
    valor_mediano          numeric,
    valor_variacao_pct     numeric
)
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
    WITH base AS (
        SELECT p.sk_supplier, p.supplier_name, p.due_date, p.amount, p.installment_base
          FROM analytics.vw_payables p
         WHERE NOT p.is_cancelled          -- conta cancelada inventaria intervalo
           AND p.due_date IS NOT NULL
           AND (p_date_from IS NULL OR p.due_date >= p_date_from)
           AND (p_date_to   IS NULL OR p.due_date <= p_date_to)
    ),
    -- 🔴 CADÊNCIA SE MEDE ENTRE DATAS DISTINTAS, NÃO ENTRE CONTAS (defeito corrigido ao RODAR a
    -- função contra o dado real, 2026-08-10). Um fornecedor emite várias faturas para o MESMO
    -- vencimento: OTIMOTEX tem 53 contas em apenas 21 datas, FEDEX 35 em 17. Medindo entre contas,
    -- os intervalos vinham cheios de ZEROS, a mediana desabava e a resposta era "cadência semanal,
    -- confiança provável" para série que não tem cadência nenhuma. O agrupamento por data é o que
    -- responde à pergunta real: "de quanto em quanto tempo este fornecedor cobra?".
    datas AS (
        SELECT b.sk_supplier, b.due_date FROM base b GROUP BY 1, 2
    ),
    com_intervalo AS (
        SELECT d.sk_supplier, d.due_date,
               (d.due_date - LAG(d.due_date) OVER (PARTITION BY d.sk_supplier ORDER BY d.due_date))
                   AS intervalo
          FROM datas d
    ),
    cadencia AS (
        SELECT ci.sk_supplier,
               count(*)::integer                                            AS ocorrencias,
               min(ci.due_date)                                             AS primeiro,
               max(ci.due_date)                                             AS ultimo,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ci.intervalo)    AS mediana,
               min(ci.intervalo)::integer                                   AS menor,
               max(ci.intervalo)::integer                                   AS maior
          FROM com_intervalo ci
         GROUP BY ci.sk_supplier
        HAVING count(*) >= p_min_ocorrencias
    ),
    valores AS (
        SELECT b.sk_supplier,
               min(b.supplier_name)                                         AS supplier_name,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY b.amount)        AS valor_med,
               min(b.amount)                                                AS valor_min,
               max(b.amount)                                                AS valor_max,
               -- >= 2 contas com o MESMO documento de carnê: é contrato parcelado, não recorrência
               (count(*) FILTER (WHERE b.installment_base IS NOT NULL)
                    > count(DISTINCT b.installment_base)
                      FILTER (WHERE b.installment_base IS NOT NULL))        AS tem_carne
          FROM base b
         GROUP BY b.sk_supplier
    ),
    classificado AS (
        -- 🔴 BANDAS FIXAS E DISJUNTAS, não derivadas da tolerância. A 1ª versão usava
        -- `mediana BETWEEN 7 - tolerancia AND 7 + tolerancia`: com a tolerância padrão de 5 dias
        -- isso vira [2,12] para "semanal" e [10,20] para "quinzenal" — faixas SOBREPOSTAS, e uma
        -- mediana de 2 dias saía rotulada "semanal". Rótulo de cadência precisa de banda estreita;
        -- a tolerância governa a DISPERSÃO (`regular`), que é outra pergunta.
        SELECT c.*, v.supplier_name, v.valor_med, v.valor_min, v.valor_max, v.tem_carne,
               CASE
                   WHEN c.mediana IS NULL                  THEN 'indeterminado'
                   WHEN c.mediana BETWEEN  6 AND  8        THEN 'semanal'
                   WHEN c.mediana BETWEEN 13 AND 17        THEN 'quinzenal'
                   WHEN c.mediana BETWEEN 26 AND 35        THEN 'mensal'
                   WHEN c.mediana BETWEEN 55 AND 67        THEN 'bimestral'
                   ELSE 'irregular'
               END AS cad,
               -- `regular` olha os EXTREMOS, não a mediana: intervalos 30, 30, 90 têm mediana 30 e
               -- não são mensais. Sem isto, a palavra "mensal" seria emitida para série irregular.
               (c.menor IS NOT NULL
                AND c.menor >= c.mediana - p_tolerancia_dias
                AND c.maior <= c.mediana + p_tolerancia_dias) AS reg
          FROM cadencia c
          JOIN valores  v ON v.sk_supplier = c.sk_supplier
    )
    -- `percentile_cont` devolve DOUBLE PRECISION (o ORDER BY é convertido), e `round(double, int)`
    -- não existe no PostgreSQL — só `round(numeric, int)`. Os casts abaixo são obrigatórios; sem
    -- eles a função nem é criada.
    SELECT c.sk_supplier,
           c.supplier_name,
           c.ocorrencias,
           c.primeiro,
           c.ultimo,
           round(c.mediana::numeric, 1),
           c.menor,
           c.maior,
           c.cad,
           c.reg,
           CASE WHEN c.reg AND c.cad NOT IN ('irregular', 'indeterminado')
                THEN 'provavel' ELSE 'insuficiente' END,
           c.tem_carne,
           round(c.valor_med::numeric, 2),
           CASE WHEN c.valor_med IS NULL OR c.valor_med = 0 THEN NULL
                ELSE round((100.0 * (c.valor_max - c.valor_min) / c.valor_med::numeric), 1) END
      FROM classificado c
     ORDER BY c.ocorrencias DESC, c.supplier_name
     LIMIT COALESCE(p_limit, 50);
$$;

COMMENT ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) IS
  'Fornecedores com despesa recorrente, classificados pela CADÊNCIA entre vencimentos — nunca pelo '
  'valor (só 3 de 11 recorrentes têm valor estável; classificar por valor perderia os outros 8). '
  'SECURITY INVOKER: conta apenas o que o usuário do JWT enxerga. `confianca` = ''provavel'' só '
  'quando TODOS os intervalos cabem na banda, não só a mediana. Com o histórico atual (máx. 5 '
  'meses) apenas cadência mensal/quinzenal/semanal é detectável; bimestral sai ''insuficiente'' e '
  'trimestral/anual não é detectável. `parcelamento_provavel` = TRUE indica CARNÊ (um contrato '
  'parcelado), que produz cadência mensal perfeita e NÃO é fornecedor recorrente.';

-- ---------------------------------------------------------------------------
-- 6.3 (complemento) — parcelamento OBSERVADO
-- ---------------------------------------------------------------------------
-- 🔴 POR QUE ISTO NÃO É UMA COLUNA NEM VIVE NA VIEW: um `count(*) OVER (PARTITION BY sk_supplier,
-- installment_base)` dentro de `vw_payables` seria calculado DEPOIS do filtro de RLS (a view é
-- security_invoker). Um usuário do grupo Comercial veria "parcela 3 de 3" onde existem 5 — número
-- errado, plausível e sem erro nenhum. Aqui o nome do campo diz o que ele é: `parcelas_observadas`.
--
-- `parcelas_faltando` é o achado que o "total" inventado jamais entregaria: um carnê com {1,3}
-- significa parcela SEM CONTA CADASTRADA — um passivo invisível.

CREATE OR REPLACE FUNCTION analytics.parcelamentos(
    p_sk_supplier bigint  DEFAULT NULL,
    p_limit       integer DEFAULT 50
)
RETURNS TABLE (
    sk_supplier             bigint,
    supplier_name           text,
    documento               text,
    parcelas_observadas     integer,
    maior_parcela_observada smallint,
    parcelas_faltando       smallint[],
    primeiro_vencimento     date,
    ultimo_vencimento       date,
    valor_total_observado   numeric
)
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT p.sk_supplier,
           min(p.supplier_name),
           p.installment_base,
           count(*)::integer,
           max(p.installment_number),
           -- buracos em 1..maior: o que existe no carnê e não existe como conta
           ARRAY(
               SELECT g::smallint
                 FROM generate_series(1, max(p.installment_number)::integer) AS g
                WHERE g NOT IN (
                    SELECT q.installment_number FROM analytics.vw_payables q
                     WHERE q.sk_supplier = p.sk_supplier
                       AND q.installment_base = p.installment_base
                       AND q.installment_number IS NOT NULL
                       AND NOT q.is_cancelled
                )
           ),
           min(p.due_date),
           max(p.due_date),
           sum(p.amount)
      FROM analytics.vw_payables p
     WHERE p.installment_number IS NOT NULL
       AND NOT p.is_cancelled
       AND (p_sk_supplier IS NULL OR p.sk_supplier = p_sk_supplier)
     GROUP BY p.sk_supplier, p.installment_base
     ORDER BY count(*) DESC, min(p.due_date)
     LIMIT COALESCE(p_limit, 50);
$$;

COMMENT ON FUNCTION analytics.parcelamentos(bigint, integer) IS
  'Parcelamentos (carnês) agrupados por documento. `parcelas_observadas` é o que ESTE usuário '
  'enxerga sob RLS — NUNCA apresentar como "parcela X de N": o total não existe na origem (o '
  'reader grava doc/ordinal, sem total). `parcelas_faltando` lista os buracos em 1..maior: um '
  'carnê {1,3} tem a 2ª parcela sem conta cadastrada, que é um passivo invisível.';

-- ---------------------------------------------------------------------------
-- Grants — guardrail 2 do roadmap: explícito nos dois sentidos, sempre
-- ---------------------------------------------------------------------------
-- O PostgreSQL concede EXECUTE a PUBLIC por default e o ALTER DEFAULT PRIVILEGES da 098 não
-- persiste neste schema (medido na Onda 1: 4 funções nasceram chamáveis com a anon key pública).

GRANT  EXECUTE ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION analytics.parcelamentos(bigint, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.parcelamentos(bigint, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. A view tem 40 colunas (eram 35) e `count(*)` sobre ela é IDÊNTICO ao de antes — nenhum JOIN
--      novo foi acrescentado, então qualquer variação significaria que um JOIN passou a filtrar.
--   2. `security_invoker` continua TRUE em pg_class.reloptions. Perdê-lo faria o chat ver contas de
--      todo mundo — escalada silenciosa.
--   3. ORÁCULO DIFERENCIAL da recorrência: `fornecedores_recorrentes(3, 5, NULL, NULL, <sem teto>)`
--      tem de devolver o mesmo conjunto que `SELECT sk_supplier FROM analytics.vw_payables WHERE
--      NOT is_cancelled AND due_date IS NOT NULL GROUP BY 1 HAVING count(DISTINCT due_date) >= 3`
--      — 63 fornecedores na medição de 2026-08-10. Divergência: investigar antes de seguir.
--      🔴 O oráculo conta DATAS DISTINTAS porque é isso que a função conta (CTE `datas`, que existe
--      justamente para não medir cadência entre CONTAS). Contar MESES distintos aqui daria 27 e
--      acusaria divergência onde não há — e "consertar" a função para casar com esse número
--      desfaria a correção documentada no bloco 🔴 da CTE `datas`.
--      ⚠️ Passar o teto explícito NÃO é detalhe: com o `p_limit` padrão a função devolve 50, e a
--      comparação falharia por TRUNCAGEM, não por divergência de regra.
--   4. `parcelamentos()` sobre o documento 962148 deve devolver 3 parcelas observadas, maior = 3 e
--      `parcelas_faltando` VAZIO (o carnê está completo). É o caso lido à mão no portão da 113.
--   5. `has_function_privilege('anon', ...)` = false para as duas funções novas.
--   6. `get_advisors` sem achado novo (em especial: nenhuma função SECURITY DEFINER acidental).
