-- 104_tools_compliance_tipo_demonstrativo.sql
--
-- ONDA 1 (itens 1.2, 1.6 e 1.7) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- Destrava, nas tools do chat, o que a migration 103 passou a expor na view:
--   1.2  filtros de COMPLIANCE (has_invoice / has_bank_slip) em listar_contas e gasto_por_fornecedor
--   1.6  eixo 'tipo' (Fixa / Variável / Custos de Mercadorias) em gasto_por_classificacao
--   1.7  tool NOVA demonstrativo_despesas — a estrutura de custos e despesas do período
--
-- ---------------------------------------------------------------------------
-- POR QUE HÁ `DROP FUNCTION` ANTES DE CADA `CREATE` (não remover — não é redundância)
-- ---------------------------------------------------------------------------
-- Acrescentar parâmetro com DEFAULT **não substitui** a função: o PostgreSQL cria uma SOBRECARGA.
-- As duas passariam a coexistir e toda chamada com a lista antiga de argumentos ficaria AMBÍGUA
-- (`function is not unique`), derrubando o chat em runtime — não na aplicação da migration.
-- Por isso: DROP da assinatura ANTIGA (explícita) e CREATE da nova.
--
-- ---------------------------------------------------------------------------
-- POR QUE CADA FUNÇÃO TEM `GRANT ... TO authenticated` **E** `REVOKE ... FROM PUBLIC, anon`
-- ---------------------------------------------------------------------------
-- (1) O `GRANT EXECUTE ON ALL FUNCTIONS` da migration 098 valeu para as funções existentes NAQUELE
--     momento — não é regra permanente. Função dropada e recriada nasce SEM o grant, e a tool
--     devolveria `42501 permission denied` para `authenticated`.
--
-- (2) 🔴 O REVOKE é IGUALMENTE OBRIGATÓRIO, e por um motivo medido — não por precaução. O
--     PostgreSQL concede `EXECUTE` a **PUBLIC** por default em toda função criada, e o
--     `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon` da migration 098
--     **NÃO deixou registro persistente**: verificado em 2026-07-31, `pg_default_acl` não tem
--     nenhuma entrada de função para o schema `analytics`. As 3 funções antigas só estão protegidas
--     porque a 098 fez o REVOKE **explícito** nelas.
--
--     Efeito real observado nesta migration: sem o REVOKE, as 4 funções recriadas ficaram
--     executáveis por `anon` — ou seja, chamáveis com a **anon key pública** via `/rest/v1/rpc/`,
--     sem login. Foi pego pela verificação de grants logo após aplicar, e corrigido aqui.
--
--     Regra que generaliza (guardrail do projeto): **toda função nova ou recriada em `analytics`
--     leva GRANT explícito para `authenticated` e REVOKE explícito de PUBLIC/anon.** Não confiar
--     no ALTER DEFAULT PRIVILEGES.
--
-- Convenções herdadas da 098 e MANTIDAS em tudo abaixo: LANGUAGE sql · STABLE · SECURITY INVOKER
-- (a RLS da 076 tem de valer) · `SET search_path = ''` com todo objeto qualificado · LIMIT clampado.

-- ---------------------------------------------------------------------------
-- 1.6 — gasto_por_classificacao ganha o eixo 'tipo' e o filtro por tipo de subgrupo
-- ---------------------------------------------------------------------------
-- A classificação Fixa/Variável vive no SUBGRUPO (`chart_subgroup_type_id`, migrations 092/093) e
-- a view já a expunha — mas não havia como AGRUPAR por ela: p_group_by aceitava só
-- centro_custo|plano_contas|grupo|subgrupo. O /dashboard_despesas mostrava o gráfico e o chat não
-- conseguia responder "quanto foi despesa fixa vs. variável?".
--
-- p_nature_ids (que já existia) filtra a NATUREZA do grupo (2=Despesas, 8=Custo);
-- p_subgroup_type_ids (novo) filtra o TIPO do subgrupo (5=Fixa, 6=Variável, 7=Custos de Merc.).
-- São dimensões distintas do mesmo cadastro `financial_type_group`, separadas por `applies_to`
-- (migration 094) — não confundir uma com a outra.

DROP FUNCTION IF EXISTS analytics.gasto_por_classificacao(date, date, text, text, smallint[], bigint, integer);

CREATE FUNCTION analytics.gasto_por_classificacao(
    p_date_from         date,
    p_date_to           date,
    p_group_by          text,
    p_date_field        text       DEFAULT 'vencimento',
    p_nature_ids        smallint[] DEFAULT NULL,
    p_sk_company        bigint     DEFAULT NULL,
    p_limit             integer    DEFAULT 20,
    p_subgroup_type_ids smallint[] DEFAULT NULL
)
RETURNS TABLE (
    dimension     text,
    label         text,
    account_count bigint,
    total_amount  numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        p_group_by,
        CASE p_group_by
            WHEN 'centro_custo' THEN v.cost_center_name
            WHEN 'plano_contas' THEN v.chart_account_name
            WHEN 'grupo'        THEN v.chart_group_name
            WHEN 'subgrupo'     THEN v.chart_subgroup_name
            WHEN 'tipo'         THEN v.chart_subgroup_type_name
        END,
        count(*),
        COALESCE(sum(v.amount), 0)::numeric(15,2)
    FROM analytics.vw_payables v
    WHERE (CASE p_date_field
               WHEN 'pagamento' THEN v.payment_date
               WHEN 'emissao'   THEN v.issue_date
               ELSE v.due_date
           END) BETWEEN p_date_from AND p_date_to
      AND NOT v.is_cancelled
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
      AND (p_nature_ids IS NULL OR v.chart_group_nature_id = ANY(p_nature_ids))
      AND (p_subgroup_type_ids IS NULL OR v.chart_subgroup_type_id = ANY(p_subgroup_type_ids))
      AND p_group_by IN ('centro_custo', 'plano_contas', 'grupo', 'subgrupo', 'tipo')
    GROUP BY 1, 2
    ORDER BY 4 DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

COMMENT ON FUNCTION analytics.gasto_por_classificacao(date, date, text, text, smallint[], bigint, integer, smallint[]) IS
  'Agrega por classificação contábil. p_group_by: centro_custo|plano_contas|grupo|subgrupo|tipo. '
  'p_nature_ids filtra a NATUREZA do grupo (2=Despesas, 8=Custo); p_subgroup_type_ids filtra o '
  'TIPO do subgrupo (5=Fixa, 6=Variável, 7=Custos de Mercadorias). Tool: gasto_por_classificacao.';

GRANT EXECUTE ON FUNCTION analytics.gasto_por_classificacao(date, date, text, text, smallint[], bigint, integer, smallint[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 1.2 — filtros de COMPLIANCE
-- ---------------------------------------------------------------------------
-- Tri-state deliberado: NULL = não filtra · true/false = filtra. Um booleano com DEFAULT false
-- mudaria silenciosamente o resultado de toda chamada que não passasse o parâmetro.

DROP FUNCTION IF EXISTS analytics.listar_contas(date, date, text, text, text[], bigint, integer, integer);

CREATE FUNCTION analytics.listar_contas(
    p_date_from     date,
    p_date_to       date,
    p_date_field    text    DEFAULT 'vencimento',
    p_supplier      text    DEFAULT NULL,
    p_status        text[]  DEFAULT NULL,
    p_sk_company    bigint  DEFAULT NULL,
    p_page          integer DEFAULT 1,
    p_limit         integer DEFAULT 50,
    p_has_invoice   boolean DEFAULT NULL,
    p_has_bank_slip boolean DEFAULT NULL
)
RETURNS TABLE (
    payable_id         bigint,
    company_name       text,
    supplier_name      text,
    invoice_number     text,
    document_type      text,
    status_name        text,
    issue_date         date,
    due_date           date,
    payment_date       date,
    amount             numeric,
    cost_center_name   text,
    chart_account_name text,
    has_invoice        boolean,
    has_bank_slip      boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        v.payable_id,
        v.company_name::text,
        v.supplier_name::text,
        v.invoice_number,
        v.document_type,
        v.status_name::text,
        v.issue_date,
        v.due_date,
        v.payment_date,
        v.amount,
        v.cost_center_name::text,
        v.chart_account_name::text,
        v.has_invoice,
        v.has_bank_slip
    FROM analytics.vw_payables v
    WHERE (CASE p_date_field
               WHEN 'pagamento' THEN v.payment_date
               WHEN 'emissao'   THEN v.issue_date
               ELSE v.due_date
           END) BETWEEN p_date_from AND p_date_to
      AND (p_status IS NOT NULL OR NOT v.is_cancelled)
      AND (p_status IS NULL     OR v.status_name = ANY(p_status))
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
      AND (p_has_invoice   IS NULL OR v.has_invoice   = p_has_invoice)
      AND (p_has_bank_slip IS NULL OR v.has_bank_slip = p_has_bank_slip)
      AND (
            p_supplier IS NULL
            OR (length(regexp_replace(p_supplier, '\D', '', 'g')) >= 8
                AND v.supplier_cnpj = regexp_replace(p_supplier, '\D', '', 'g'))
            OR public.normalize_search(COALESCE(v.supplier_name, ''))
               LIKE '%' || public.normalize_search(p_supplier) || '%'
          )
    ORDER BY (CASE p_date_field
                  WHEN 'pagamento' THEN v.payment_date
                  WHEN 'emissao'   THEN v.issue_date
                  ELSE v.due_date
              END) DESC,
             v.payable_id DESC
    LIMIT  LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
    OFFSET (GREATEST(COALESCE(p_page, 1), 1) - 1) * LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$;

COMMENT ON FUNCTION analytics.listar_contas(date, date, text, text, text[], bigint, integer, integer, boolean, boolean) IS
  'Drill-down: contas individuais de um recorte, paginado. p_has_invoice/p_has_bank_slip são '
  'tri-state (NULL = não filtra) e respondem a auditoria de compliance — boleto sem NF é '
  'p_has_bank_slip=true + p_has_invoice=false. Tool: listar_contas.';

GRANT EXECUTE ON FUNCTION analytics.listar_contas(date, date, text, text, text[], bigint, integer, integer, boolean, boolean) TO authenticated;

DROP FUNCTION IF EXISTS analytics.gasto_por_fornecedor(date, date, text, text, bigint, integer);

CREATE FUNCTION analytics.gasto_por_fornecedor(
    p_date_from     date,
    p_date_to       date,
    p_date_field    text    DEFAULT 'vencimento',
    p_supplier      text    DEFAULT NULL,
    p_sk_company    bigint  DEFAULT NULL,
    p_limit         integer DEFAULT 20,
    p_has_invoice   boolean DEFAULT NULL,
    p_has_bank_slip boolean DEFAULT NULL
)
-- As três somas de boleto entram no RETORNO (não como parâmetro): expor as colunas na view não
-- torna "quanto pagamos de juros" respondível — alguma tool precisa AGREGÁ-LAS. Sem isto, a
-- pergunta devolveria só o total do documento, sem os acréscimos.
RETURNS TABLE (
    sk_supplier    bigint,
    supplier_name  text,
    supplier_cnpj  text,
    account_count  bigint,
    total_amount   numeric,
    fine_interest  numeric,
    discount       numeric,
    amount_charged numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        v.sk_supplier,
        v.supplier_name::text,
        v.supplier_cnpj::text,
        count(*),
        COALESCE(sum(v.amount), 0)::numeric(15,2),
        COALESCE(sum(v.fine_interest + v.other_additions), 0)::numeric(15,2),
        COALESCE(sum(v.discount + v.other_deductions), 0)::numeric(15,2),
        COALESCE(sum(v.amount_charged), 0)::numeric(15,2)
    FROM analytics.vw_payables v
    WHERE (CASE p_date_field
               WHEN 'pagamento' THEN v.payment_date
               WHEN 'emissao'   THEN v.issue_date
               ELSE v.due_date
           END) BETWEEN p_date_from AND p_date_to
      AND NOT v.is_cancelled
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
      AND (p_has_invoice   IS NULL OR v.has_invoice   = p_has_invoice)
      AND (p_has_bank_slip IS NULL OR v.has_bank_slip = p_has_bank_slip)
      AND (
            p_supplier IS NULL
            OR (length(regexp_replace(p_supplier, '\D', '', 'g')) >= 8
                AND v.supplier_cnpj = regexp_replace(p_supplier, '\D', '', 'g'))
            OR public.normalize_search(COALESCE(v.supplier_name, ''))
               LIKE '%' || public.normalize_search(p_supplier) || '%'
          )
    GROUP BY 1, 2, 3
    ORDER BY 5 DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

COMMENT ON FUNCTION analytics.gasto_por_fornecedor(date, date, text, text, bigint, integer, boolean, boolean) IS
  'Ranking/total por fornecedor. Devolve também fine_interest (juros+acréscimos), discount '
  '(descontos+deduções) e amount_charged — sem isso, "quanto pagamos de juros" não teria como ser '
  'respondido, mesmo com as colunas expostas na view. p_has_invoice/p_has_bank_slip são tri-state. '
  'ATENÇÃO: é um ranking TRUNCADO (máx. 100 de 165 fornecedores) — somar suas linhas NÃO dá o '
  'total do período. Tool: gasto_por_fornecedor.';

GRANT EXECUTE ON FUNCTION analytics.gasto_por_fornecedor(date, date, text, text, bigint, integer, boolean, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 1.7 — demonstrativo_despesas (tool NOVA)
-- ---------------------------------------------------------------------------
-- NÃO é um DRE, e o nome é deliberado: o sistema é contas a PAGAR e tem ZERO receitas — um DRE
-- exige Receita Bruta → Deduções → CMV → Lucro Bruto → Despesas → Resultado, e aqui existe só a
-- metade de baixo. Chamar isto de "DRE" repetiria o defeito do DPO: número com o nome de uma coisa
-- que ele não é. (Decisão do usuário em 2026-07-31 — opção B; ver seção 5 do roadmap.)
--
-- INVARIANTE CENTRAL — O DEMONSTRATIVO TEM DE FECHAR:
-- a classificação abaixo é MUTUAMENTE EXCLUSIVA (CASE, primeira condição vence) e EXAUSTIVA
-- (ELSE), então a soma das linhas é sempre igual ao total do período. Um demonstrativo que omite o
-- que não soube classificar não fecha — e um número que não fecha destrói a confiança em todos os
-- outros. Por isso 'Não classificado' é uma LINHA, não um filtro.
--
-- TRIBUTOS EM LINHA PRÓPRIA: os subgrupos de Passivo Tributário não têm tipo Fixa/Variável, e isso
-- é contabilmente CORRETO (tributo a recolher é passivo, não despesa do período). Mas o
-- /dashboard_despesas filtra só natureza Despesas+Custo, então esse dinheiro fica invisível lá —
-- medido em 2026-07-31: R$ 2.214.143,31 em 40 contas. A linha própria preserva a semântica contábil
-- E fecha o caixa. Sai da NATUREZA (chart_group_nature_id = 4), nunca de ids de subgrupo
-- hardcoded, que quebrariam em silêncio se o cadastro mudasse.
--
-- A linha 'Total de saídas' é devolvida pela própria função (UNION ALL) para o modelo NÃO precisar
-- somar — LLM somando moeda é fonte de erro silencioso.
--
-- PRECEDÊNCIA DO CASE (hoje inalcançável, mas define o comportamento futuro): o tipo do SUBGRUPO
-- vence a natureza do GRUPO. Uma conta que fosse Despesa Fixa e Passivo ao mesmo tempo apareceria
-- em 'Despesas Fixas', não em 'Tributos'. Verificado em 2026-07-31: **0 contas** e **0 subgrupos do
-- cadastro** combinam as duas condições, então a ordem não muda nenhum número atual — está fixada
-- aqui para que uma mudança de cadastro não produza classificação imprevisível.
--
-- 'Não classificado' agrega DOIS casos distintos: conta sem plano de contas (64) e conta com plano
-- cujo subgrupo não tem tipo (2 — as de Publicidade e Propaganda). Ambas são genuinamente "não
-- classificadas" para efeito do demonstrativo; separá-las seria detalhe de saneamento de cadastro,
-- não de apresentação.

CREATE OR REPLACE FUNCTION analytics.demonstrativo_despesas(
    p_date_from  date,
    p_date_to    date,
    p_date_field text   DEFAULT 'vencimento',
    p_sk_company bigint DEFAULT NULL
)
RETURNS TABLE (
    line_order    integer,
    line_label    text,
    account_count bigint,
    total_amount  numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    WITH base AS (
        SELECT
            -- ids do catálogo financial_type_group: 5=Despesas Fixas, 6=Despesas Variáveis,
            -- 7=Custos de Mercadorias (applies_to='subgroup'); 4=Passivo (applies_to='group').
            CASE
                WHEN v.chart_subgroup_type_id = 7 THEN 1
                WHEN v.chart_subgroup_type_id = 5 THEN 2
                WHEN v.chart_subgroup_type_id = 6 THEN 3
                WHEN v.chart_group_nature_id  = 4 THEN 4
                ELSE 5
            END AS line_order,
            v.amount
        FROM analytics.vw_payables v
        WHERE (CASE p_date_field
                   WHEN 'pagamento' THEN v.payment_date
                   WHEN 'emissao'   THEN v.issue_date
                   ELSE v.due_date
               END) BETWEEN p_date_from AND p_date_to
          AND NOT v.is_cancelled
          AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
    )
    SELECT
        b.line_order,
        (CASE b.line_order
            WHEN 1 THEN 'Custos de Mercadorias'
            WHEN 2 THEN 'Despesas Fixas'
            WHEN 3 THEN 'Despesas Variáveis'
            WHEN 4 THEN 'Tributos (passivo tributário)'
            ELSE        'Não classificado'
         END)::text,
        count(*),
        COALESCE(sum(b.amount), 0)::numeric(15,2)
    FROM base b
    GROUP BY 1
    UNION ALL
    SELECT 9, 'Total de saídas'::text, count(*), COALESCE(sum(b.amount), 0)::numeric(15,2)
    FROM base b
    ORDER BY 1;
$$;

COMMENT ON FUNCTION analytics.demonstrativo_despesas(date, date, text, bigint) IS
  'Demonstrativo de Custos e Despesas do período — NÃO é um DRE (o sistema tem 0 receitas). '
  'Linhas mutuamente exclusivas e exaustivas, com Tributos (natureza Passivo) e Não classificado '
  'em linhas próprias, de modo que a soma SEMPRE fecha com o Total de saídas. '
  'Tool: demonstrativo_despesas.';

GRANT EXECUTE ON FUNCTION analytics.demonstrativo_despesas(date, date, text, bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- REVOKE de PUBLIC/anon nas 4 funções criadas/recriadas acima — ver o cabeçalho: o default do
-- PostgreSQL concede EXECUTE a PUBLIC, e o ALTER DEFAULT PRIVILEGES da 098 não persistiu.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION analytics.gasto_por_classificacao(date, date, text, text, smallint[], bigint, integer, smallint[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION analytics.listar_contas(date, date, text, text, text[], bigint, integer, integer, boolean, boolean)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION analytics.gasto_por_fornecedor(date, date, text, text, bigint, integer, boolean, boolean)           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION analytics.demonstrativo_despesas(date, date, text, bigint)                                          FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; esperado em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. Nenhuma das 4 funções aparece DUPLICADA em pg_proc (o DROP evitou a sobrecarga ambígua).
--   2. As 4 têm EXECUTE para `authenticated` e NÃO têm para `anon`/PUBLIC.
--   3. gasto_por_classificacao com p_group_by='tipo' devolve Custos de Mercadorias, Despesas
--      Fixas, Despesas Variáveis e 'não informado' — e a soma bate com a query de controle
--      equivalente sobre financial_account_control.
--   4. demonstrativo_despesas: a soma das linhas 1..5 é IGUAL à linha 9 (Total de saídas). É o
--      invariante que prova que a classificação é exaustiva.
--   5. listar_contas(p_has_bank_slip=>true, p_has_invoice=>false) devolve o mesmo conjunto que
--      `WHERE has_bank_slip AND NOT has_invoice` na tabela base.
