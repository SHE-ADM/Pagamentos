-- 103_expose_columns_vw_payables.sql
--
-- ONDA 1 (item 1.1) do roadmap de enriquecimento — docs/roadmap-enriquecimento-dados.md
--
-- PROBLEMA: `financial_account_control` tem 42 colunas; `analytics.vw_payables` expõe 26. O chat de
-- IA só enxerga a view, então 16 colunas JÁ GRAVADAS são inalcançáveis — entre elas as que
-- respondem o achado de compliance mais material da base: 169 contas com boleto e SEM nota fiscal.
--
-- Esta migration é ADITIVA e não altera nenhuma coluna existente: `CREATE OR REPLACE VIEW` do
-- PostgreSQL só permite ACRESCENTAR colunas no fim — mudar nome, ordem ou tipo de coluna existente
-- é recusado pelo próprio banco. Por isso a `vw_aging_vencidos` (que depende desta view) e as 6
-- funções de tool continuam válidas: todas selecionam colunas NOMEADAS, nenhuma usa `SELECT *`
-- (verificado antes de escrever esta migration).
--
-- O QUE ENTRA E POR QUÊ:
--   - has_invoice / has_bank_slip .... compliance: boleto pago sem NF é passivo tributário e vetor
--                                      de fraude. Hoje: 169 contas nessa condição.
--   - fine_interest / other_additions  o que a tesouraria PERDEU em juros e multa.
--   - discount / other_deductions .... o que a tesouraria GANHOU em desconto de antecipação.
--   - extraction_source .............. qualidade da esteira automática (pdf_text é texto nativo;
--                                      pdf_vision/image_vision são OCR e merecem ressalva na
--                                      resposta do chat).
--   - chart_subgroup_type_name ....... o NOME de Fixa/Variável/Custos de Mercadorias. A view já
--                                      trazia o id (`chart_subgroup_type_id`), mas rotular exigiria
--                                      JOIN dentro de cada função. Resolver aqui, uma vez.
--   - chart_group_nature_name ........ idem para a natureza do grupo (Despesas/Custo/Passivo…).
--
-- SEGURANÇA (não regredir):
--   - `security_invoker = true` é MANTIDO. É ele que faz a RLS de financial_account_control
--     (migration 076 — visibilidade por dono) valer para o usuário do JWT dentro do chat. Sem ele,
--     a view rodaria como owner e o chat veria contas de todos os usuários.
--   - O JOIN novo é com `public.financial_type_group`, que tem RLS ativo, policy para
--     `authenticated` e GRANT SELECT (verificado no catálogo). Sob security_invoker a leitura
--     funciona; sem esse grant a view voltaria NULL no rótulo, silenciosamente.
--   - LEFT JOIN de propósito: conta sem classificação precisa continuar aparecendo (são 64 contas
--     / R$ 416.379 hoje). INNER JOIN as faria sumir do fato — e um demonstrativo que perde linhas
--     não fecha com o total.

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
    COALESCE(tgg.type_group_description, 'não informado')     AS chart_group_nature_name
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
  'acrescentou curadoria (has_invoice/has_bank_slip), componentes de boleto (juros/descontos), '
  'extraction_source e os NOMES de natureza/tipo da classificação.';

-- O GRANT de SELECT sobrevive ao CREATE OR REPLACE (a view não é recriada do zero), mas
-- reaplicá-lo é idempotente e protege contra um replace futuro que a recrie.
GRANT SELECT ON analytics.vw_payables TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; resultados esperados em prosa, não como SQL comentado —
-- o "commented-out code" do SonarCloud reprova o gate, como aconteceu na 073)
-- ---------------------------------------------------------------------------
--
--   1. A view passa a ter 35 colunas (26 + 9). As 26 primeiras mantêm nome, ordem e tipo.
--   2. `SELECT count(*) FROM analytics.vw_payables` devolve o mesmo total de antes — os dois
--      LEFT JOIN novos não podem multiplicar linhas, porque type_group_id é PK de
--      financial_type_group. Se o total subir, há duplicata no catálogo e a migration deve ser
--      revertida antes de seguir.
--   3. `count(*) FILTER (WHERE has_bank_slip AND NOT has_invoice)` = 169 (o achado de compliance).
--   4. `chart_subgroup_type_name` distinto devolve: Despesas Fixas, Despesas Variáveis,
--      Custos de Mercadorias e 'não informado'.
--   5. Com o papel `authenticated` de um usuário do grupo Comercial, a view continua devolvendo
--      MENOS linhas que para um usuário irrestrito — prova de que o security_invoker segue
--      propagando a RLS da 076.
