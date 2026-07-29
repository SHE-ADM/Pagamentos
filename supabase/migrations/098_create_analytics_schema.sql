-- 098_create_analytics_schema.sql
-- Fase 1 do chat de IA — camada semântica read-only.
-- Ver docs/arquitetura-chat-ia-pagamentos.md (§4.4, §6, §7, §8, §11).
--
-- O QUE ESTE ARQUIVO CRIA
--   1. Schema `analytics` — só leitura curada, exposto ao PostgREST.
--   2. Duas views planas (fact + dimensões resolvidas por chave natural legível).
--   3. As SEIS funções de negócio que o modelo aciona por tool calling.
--   4. `analytics.ai_chat_log` (auditoria) com RLS.
--   5. GRANT/REVOKE explícitos.
--
-- POR QUE FUNÇÃO E NÃO VIEW FILTRADA (§4.4). O PostgREST só agrega (`sum()`, `count()`) com
-- `db-aggregates-enabled`, que vem DESLIGADO no Supabase. Como função: a agregação roda no banco
-- independente dessa flag, os parâmetros viajam como BIND (o gateway nunca interpola string do
-- modelo em SQL) e, sendo SECURITY INVOKER, a RLS das tabelas base continua valendo dentro dela.
--
-- POR QUE SECURITY INVOKER / security_invoker=true (§4.5 — não regredir). O acesso do chat é feito
-- com o JWT do PRÓPRIO usuário (chave anon + `setHeader('Authorization', ...)`, o mesmo caminho de
-- `canSeeConta` em apps/api-backend/lib/auth.ts). As policies de `financial_account_control` são
-- `TO authenticated` e dependem de `auth.uid()` (migration 076), então:
--   - o chat NÃO pode usar `service_role` — veria tudo, furando a visibilidade por dono;
--   - uma role dedicada (`ai_readonly`) NÃO funcionaria — não sendo `authenticated`, nenhuma policy
--     é avaliada e tudo cai no default-deny: o chat leria ZERO linhas.
-- Marcar as views/funções como INVOKER é o que faz a RLS existente decidir sozinha o recorte. Um
-- `SECURITY DEFINER` aqui seria uma escalada de privilégio silenciosa.
--
-- POR QUE OS REVOKE SÃO OBRIGATÓRIOS. O Supabase concede escrita por DEFAULT a `anon`/
-- `authenticated` em todo objeto novo — padrão recorrente do projeto (056, 057, 079, 081) e a causa
-- do resíduo que a 097 teve de limpar. Sem os REVOKE abaixo, o schema analítico nasceria gravável.
--
-- IDEMPOTENTE. Pode ser reaplicada (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
--
-- PASSO MANUAL OBRIGATÓRIO APÓS APLICAR: expor o schema no PostgREST em
-- Supabase Dashboard → Settings → API → Exposed schemas → acrescentar `analytics`.
-- Sem isso, `supabase.schema('analytics').rpc(...)` responde 404.

CREATE SCHEMA IF NOT EXISTS analytics;

COMMENT ON SCHEMA analytics IS
  'Camada semântica read-only do chat de IA. Só views/funções SECURITY INVOKER — a RLS do public '
  'decide o recorte. Nenhuma escrita, exceto o INSERT em ai_chat_log via service_role.';

-- ---------------------------------------------------------------------------
-- 1. VIEWS
-- ---------------------------------------------------------------------------

-- FACT PLANO de contas a pagar, dimensões resolvidas por chave natural legível.
--
-- JOIN (não LEFT) em company/supplier/status: as três FKs são NOT NULL e há 0 órfãos — um LEFT só
-- mascararia inconsistência futura. LEFT nas dimensões de classificação porque o sentinela id 0
-- existe com descrição NULL, e é ele que vira 'não informado'.
--
-- O grupo do plano de contas vem da FK DIRETA `ca.chart_account_group_id` (migration 058), não do
-- subgrupo: as duas nunca divergem (verificado em 572 planos) e a direta é a que o frontend usa.
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
    sg.type_group_id                                          AS chart_subgroup_type_id   -- 5=Fixa, 6=Variável, 7=Custo merc.
FROM public.financial_account_control f
JOIN public.company  c  ON c.sk_company  = f.sk_company
JOIN public.supplier s  ON s.sk_supplier = f.sk_supplier
JOIN public.status   st ON st.status_id  = f.status_id
LEFT JOIN public.financial_cost_center cc              ON cc.cost_center_id           = f.cost_center_id
LEFT JOIN public.financial_chart_of_account ca         ON ca.chart_account_id         = f.chart_account_id
LEFT JOIN public.financial_chart_of_account_group    g ON g.chart_account_group_id    = ca.chart_account_group_id
LEFT JOIN public.financial_chart_of_account_subgroup sg ON sg.chart_account_subgroup_id = ca.chart_account_subgroup_id;

COMMENT ON VIEW analytics.vw_payables IS
  'Fact plano de contas a pagar com dimensões resolvidas. security_invoker: a RLS de '
  'financial_account_control (migration 076) se aplica ao usuário do JWT.';

-- AGING — por VENCIMENTO sobre o que está EM ABERTO.
--
-- NÃO filtrar por status_name = 'vencido' (não regredir). A trigger fn_set_status_from_due_date só
-- reclassifica em INSERT/UPDATE e o batch `baixa-automatica` roda 1x/dia, então o RÓTULO fica
-- defasado: medido em 2026-07-29, 6 contas rotuladas 'vencido' contra 108 em aberto. Vencido DE
-- FATO é `is_open AND due_date < CURRENT_DATE`.
--
-- Faixas começam em 1-30, não 0-30: o que vence HOJE ainda não está vencido — mesma semântica da
-- trigger (`due_date < ref_date`) e do batch.
CREATE OR REPLACE VIEW analytics.vw_aging_vencidos
WITH (security_invoker = true) AS
SELECT
    v.sk_company,
    v.company_name,
    v.sk_supplier,
    v.supplier_name,
    v.cost_center_name,
    v.chart_account_name,
    CASE WHEN CURRENT_DATE - v.due_date BETWEEN  1 AND 30 THEN '1-30'
         WHEN CURRENT_DATE - v.due_date BETWEEN 31 AND 60 THEN '31-60'
         WHEN CURRENT_DATE - v.due_date BETWEEN 61 AND 90 THEN '61-90'
         ELSE '90+' END                        AS aging_bucket,
    (CURRENT_DATE - v.due_date)                AS days_overdue,
    COALESCE(v.amount, 0)::numeric(15,2)       AS amount
FROM analytics.vw_payables v
WHERE v.is_open
  AND v.due_date IS NOT NULL
  AND v.due_date < CURRENT_DATE;

COMMENT ON VIEW analytics.vw_aging_vencidos IS
  'Títulos em aberto já vencidos, um por linha, com a faixa de aging. Vencido é calculado por '
  'due_date < CURRENT_DATE, NUNCA pelo rótulo status_name (que é defasado pela trigger + batch).';

-- ---------------------------------------------------------------------------
-- 2. FUNÇÕES DE NEGÓCIO (as 6 tools do §6)
-- ---------------------------------------------------------------------------
--
-- CONVENÇÕES QUE VALEM PARA TODAS (espelham o app — é o que faz o número do chat bater com o
-- número da tela; ver §6 do documento):
--
--   - `cancelado` (id 9) fica FORA dos totais por padrão. Só entra quando o chamador pede o status
--     explicitamente em p_status. Mesma convenção do /consulta, onde cancelado aparece no grid mas
--     não nos KPIs.
--   - "Em aberto" é o conjunto EXPLÍCITO status_id IN (1,2,3). As flags has_opened/has_closed da
--     dimensão `status` NÃO servem: estão todas `false` no banco.
--   - p_date_field seleciona a data por CASE (bind), nunca por SQL dinâmico:
--     vencimento -> due_date | pagamento -> payment_date | emissao -> issue_date.
--   - LIMIT é sempre clampado no corpo (1..100), para a resposta não estourar o contexto do modelo.
--   - Casamento de nome de fornecedor usa public.normalize_search + LIKE contains. O LIKE é
--     deliberado no lugar do operador `%` do pg_trgm: `%` depende do search_path resolver a
--     extensão e do limiar de similaridade, enquanto o LIKE é operador do core e AINDA usa os
--     índices GIN `idx_supplier_trade_name_trgm` / `idx_supplier_legal_name_trgm` (que são
--     funcionais sobre normalize_search). Escrever `unaccent(lower(...))` inline daria o mesmo
--     resultado mas NÃO usaria o índice — o planner só casa expressão idêntica.
--
-- Todas são LANGUAGE sql STABLE (read-only, inlináveis) e SECURITY INVOKER (o default — explicitado
-- para documentar a intenção; ver o cabeçalho).
--
-- `SET search_path = ''` em todas (linter do Supabase: function_search_path_mutable). É seguro
-- justamente porque TODA referência a objeto está qualificada (`analytics.vw_*`,
-- `public.normalize_search`) e o resto vem do `pg_catalog`, que o PostgreSQL pesquisa
-- implicitamente mesmo com o search_path vazio. Foi também por isso que se optou por `LIKE` em vez
-- do operador `%` do pg_trgm: `%` precisaria da extensão RESOLVÍVEL pelo search_path, e o `SET`
-- acima a tornaria inalcançável — a função quebraria em runtime, não na criação.
-- Verificado após o SET: os 6 resultados permanecem idênticos (551 contas / R$ 8.338.039,49 etc.).

-- 2.1 resumo_situacao — KPIs por situação.
--
-- Devolve o rótulo COMO A TELA MOSTRA (status_name), e ainda as colunas overdue_*, que recalculam
-- o vencido de fato por due_date. As duas leituras convivem de propósito: o rótulo é o que o
-- usuário vê no /consulta, e o overdue_* é a realidade — sem essa segunda coluna o modelo diria
-- "6 vencidas" quando há 100+ em atraso real.
CREATE OR REPLACE FUNCTION analytics.resumo_situacao(
    p_sk_company bigint DEFAULT NULL,
    p_as_of      date   DEFAULT NULL
)
RETURNS TABLE (
    status_id       smallint,
    status_name     text,
    is_open         boolean,
    account_count   bigint,
    total_amount    numeric,
    overdue_count   bigint,
    overdue_amount  numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        v.status_id,
        v.status_name::text,
        bool_or(v.is_open),
        count(*),
        COALESCE(sum(v.amount), 0)::numeric(15,2),
        count(*) FILTER (
            WHERE v.is_open AND v.due_date < COALESCE(p_as_of, CURRENT_DATE)
        ),
        COALESCE(sum(v.amount) FILTER (
            WHERE v.is_open AND v.due_date < COALESCE(p_as_of, CURRENT_DATE)
        ), 0)::numeric(15,2)
    FROM analytics.vw_payables v
    WHERE NOT v.is_cancelled
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
    GROUP BY 1, 2
    ORDER BY 1;
$$;

COMMENT ON FUNCTION analytics.resumo_situacao(bigint, date) IS
  'KPIs por situação. Exclui cancelado. overdue_* recalcula o vencido por due_date (o rótulo '
  'status_name é defasado). Tool: resumo_situacao.';

-- 2.2 gasto_por_periodo — série temporal.
CREATE OR REPLACE FUNCTION analytics.gasto_por_periodo(
    p_date_from   date,
    p_date_to     date,
    p_date_field  text    DEFAULT 'vencimento',
    p_granularity text    DEFAULT 'mes',
    p_status      text[]  DEFAULT NULL,
    p_sk_company  bigint  DEFAULT NULL
)
RETURNS TABLE (
    bucket        date,
    account_count bigint,
    total_amount  numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        date_trunc(
            CASE p_granularity
                WHEN 'dia'       THEN 'day'
                WHEN 'semana'    THEN 'week'
                WHEN 'trimestre' THEN 'quarter'
                ELSE 'month'
            END,
            (CASE p_date_field
                WHEN 'pagamento' THEN v.payment_date
                WHEN 'emissao'   THEN v.issue_date
                ELSE v.due_date
             END)::timestamp
        )::date,
        count(*),
        COALESCE(sum(v.amount), 0)::numeric(15,2)
    FROM analytics.vw_payables v
    WHERE (CASE p_date_field
               WHEN 'pagamento' THEN v.payment_date
               WHEN 'emissao'   THEN v.issue_date
               ELSE v.due_date
           END) BETWEEN p_date_from AND p_date_to
      -- sem p_status explícito, cancelado fica fora
      AND (p_status IS NOT NULL OR NOT v.is_cancelled)
      AND (p_status IS NULL     OR v.status_name = ANY(p_status))
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
    GROUP BY 1
    ORDER BY 1;
$$;

COMMENT ON FUNCTION analytics.gasto_por_periodo(date, date, text, text, text[], bigint) IS
  'Total agregado por período. p_date_field: vencimento|pagamento|emissao. Tool: gasto_por_periodo.';

-- 2.3 gasto_por_fornecedor — ranking.
CREATE OR REPLACE FUNCTION analytics.gasto_por_fornecedor(
    p_date_from  date,
    p_date_to    date,
    p_date_field text   DEFAULT 'vencimento',
    p_supplier   text   DEFAULT NULL,
    p_sk_company bigint DEFAULT NULL,
    p_limit      integer DEFAULT 20
)
RETURNS TABLE (
    sk_supplier   bigint,
    supplier_name text,
    supplier_cnpj text,
    account_count bigint,
    total_amount  numeric
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
        COALESCE(sum(v.amount), 0)::numeric(15,2)
    FROM analytics.vw_payables v
    WHERE (CASE p_date_field
               WHEN 'pagamento' THEN v.payment_date
               WHEN 'emissao'   THEN v.issue_date
               ELSE v.due_date
           END) BETWEEN p_date_from AND p_date_to
      AND NOT v.is_cancelled
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
      AND (
            p_supplier IS NULL
            -- CNPJ exato: só quando o termo traz dígitos suficientes para ser um documento
            OR (length(regexp_replace(p_supplier, '\D', '', 'g')) >= 8
                AND v.supplier_cnpj = regexp_replace(p_supplier, '\D', '', 'g'))
            OR public.normalize_search(COALESCE(v.supplier_name, ''))
               LIKE '%' || public.normalize_search(p_supplier) || '%'
          )
    GROUP BY 1, 2, 3
    ORDER BY 5 DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

COMMENT ON FUNCTION analytics.gasto_por_fornecedor(date, date, text, text, bigint, integer) IS
  'Ranking/total por fornecedor. p_supplier casa CNPJ exato ou nome via normalize_search + LIKE '
  '(usa os índices GIN trgm). Tool: gasto_por_fornecedor.';

-- 2.4 gasto_por_classificacao — agrega pela classificação contábil.
--
-- p_group_by escolhe a dimensão por CASE (bind), sem SQL dinâmico. p_nature_ids filtra pela
-- NATUREZA do grupo (2=Despesas, 8=Custo) — é o mesmo recorte de /dashboard_despesas.
CREATE OR REPLACE FUNCTION analytics.gasto_por_classificacao(
    p_date_from  date,
    p_date_to    date,
    p_group_by   text,
    p_date_field text      DEFAULT 'vencimento',
    p_nature_ids smallint[] DEFAULT NULL,
    p_sk_company bigint    DEFAULT NULL,
    p_limit      integer   DEFAULT 20
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
      -- group_by inválido zeraria o rótulo e agregaria tudo numa linha NULL: barra na origem
      AND p_group_by IN ('centro_custo', 'plano_contas', 'grupo', 'subgrupo')
    GROUP BY 1, 2
    ORDER BY 4 DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

COMMENT ON FUNCTION analytics.gasto_por_classificacao(date, date, text, text, smallint[], bigint, integer) IS
  'Agrega por classificação contábil. p_group_by: centro_custo|plano_contas|grupo|subgrupo. '
  'p_nature_ids: 2=Despesas, 8=Custo. Tool: gasto_por_classificacao.';

-- 2.5 aging_vencidos — faixas de atraso.
CREATE OR REPLACE FUNCTION analytics.aging_vencidos(
    p_group_by   text   DEFAULT 'faixa',
    p_sk_company bigint DEFAULT NULL,
    p_limit      integer DEFAULT 50
)
RETURNS TABLE (
    aging_bucket  text,
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
        a.aging_bucket,
        CASE p_group_by
            WHEN 'empresa'      THEN a.company_name
            WHEN 'fornecedor'   THEN a.supplier_name
            WHEN 'centro_custo' THEN a.cost_center_name
            WHEN 'plano_contas' THEN a.chart_account_name
            ELSE a.aging_bucket
        END,
        count(*),
        COALESCE(sum(a.amount), 0)::numeric(15,2)
    FROM analytics.vw_aging_vencidos a
    WHERE (p_sk_company IS NULL OR a.sk_company = p_sk_company)
      AND p_group_by IN ('faixa', 'empresa', 'fornecedor', 'centro_custo', 'plano_contas')
    GROUP BY 1, 2
    ORDER BY 1, 4 DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$;

COMMENT ON FUNCTION analytics.aging_vencidos(text, bigint, integer) IS
  'Aging dos títulos EM ABERTO já vencidos (due_date < CURRENT_DATE), por faixa 1-30/31-60/61-90/90+. '
  'Tool: aging_vencidos.';

-- 2.6 listar_contas — drill-down paginado.
--
-- Retorno ENXUTO de propósito: só o que responde "quais contas são essas". Colunas de pipeline
-- (barcode, sender_email, subject, email_body_excerpt, processing_notes) NÃO entram — o chat é
-- análise financeira, não auditoria de extração, e cada coluna a mais consome contexto do modelo.
CREATE OR REPLACE FUNCTION analytics.listar_contas(
    p_date_from  date,
    p_date_to    date,
    p_date_field text   DEFAULT 'vencimento',
    p_supplier   text   DEFAULT NULL,
    p_status     text[] DEFAULT NULL,
    p_sk_company bigint DEFAULT NULL,
    p_page       integer DEFAULT 1,
    p_limit      integer DEFAULT 50
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
    chart_account_name text
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
        v.chart_account_name::text
    FROM analytics.vw_payables v
    WHERE (CASE p_date_field
               WHEN 'pagamento' THEN v.payment_date
               WHEN 'emissao'   THEN v.issue_date
               ELSE v.due_date
           END) BETWEEN p_date_from AND p_date_to
      AND (p_status IS NOT NULL OR NOT v.is_cancelled)
      AND (p_status IS NULL     OR v.status_name = ANY(p_status))
      AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
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

COMMENT ON FUNCTION analytics.listar_contas(date, date, text, text, text[], bigint, integer, integer) IS
  'Drill-down: contas individuais de um recorte, paginado. Tool: listar_contas.';

-- ---------------------------------------------------------------------------
-- 3. AUDITORIA — ai_chat_log
-- ---------------------------------------------------------------------------
--
-- O INSERT é a ÚNICA escrita de todo o desenho e usa `service_role` (§4.6). É uma exceção estreita
-- e deliberada ao princípio "sem service_role": ele veda o acesso a DADO DE NEGÓCIO, e deixar o
-- usuário auditado escrever a própria trilha de auditoria seria pior. A leitura é RLS-restrita ao
-- próprio user_id.
CREATE TABLE IF NOT EXISTS analytics.ai_chat_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at    timestamptz NOT NULL DEFAULT now(),
    user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    question      text        NOT NULL,
    tool_calls    jsonb,
    row_count     integer,
    latency_ms    integer,
    input_tokens  integer,
    output_tokens integer,
    error         text
);

COMMENT ON TABLE analytics.ai_chat_log IS
  'Trilha de auditoria do chat de IA. Escrito só por service_role; leitura restrita ao próprio '
  'usuário pela RLS. Fonte para descobrir quais tools faltam (§11 do doc de arquitetura).';

-- Índice para a consulta natural (histórico do usuário, mais recente primeiro).
CREATE INDEX IF NOT EXISTS ix_ai_chat_log_user_created
    ON analytics.ai_chat_log (user_id, created_at DESC);

ALTER TABLE analytics.ai_chat_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_chat_log_select_own ON analytics.ai_chat_log;
CREATE POLICY ai_chat_log_select_own
    ON analytics.ai_chat_log
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. GRANTS / REVOKES
-- ---------------------------------------------------------------------------

-- `anon` não entra no schema em hipótese alguma: o chat exige usuário autenticado.
REVOKE ALL ON SCHEMA analytics FROM anon;

GRANT USAGE ON SCHEMA analytics TO authenticated;

GRANT SELECT ON analytics.vw_payables       TO authenticated;
GRANT SELECT ON analytics.vw_aging_vencidos TO authenticated;
GRANT SELECT ON analytics.ai_chat_log       TO authenticated;   -- a policy acima restringe as linhas

-- Tira a escrita que o Supabase concede por DEFAULT em objeto novo (o motivo da 097).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON ALL TABLES IN SCHEMA analytics FROM authenticated, anon;

-- EXECUTE só para authenticated. O REVOKE de PUBLIC é necessário porque o PostgreSQL concede
-- EXECUTE a PUBLIC por default em toda função criada — sem ele, `anon` executaria via PUBLIC
-- mesmo sem USAGE explícito no schema.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA analytics FROM PUBLIC, anon;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA analytics TO authenticated;

-- Objeto criado no futuro neste schema já nasce sem escrita e sem acesso do anon.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA analytics
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM authenticated, anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA analytics
    REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA analytics
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executada após aplicar — resultados registrados aqui em prosa, não como SQL
-- comentado, para não disparar o "commented-out code" do SonarCloud, como na 073)
-- ---------------------------------------------------------------------------
--
-- Conferir, com o papel `authenticated` de um usuário de grupo IRRESTRITO e de um usuário do grupo
-- COMERCIAL (sees_only_own_accounts = true):
--
--   1. `analytics.vw_payables` devolve MENOS linhas para o Comercial que para o irrestrito — prova
--      que o security_invoker está propagando a RLS da migration 076. Se os dois virem o mesmo
--      total, o security_invoker NÃO pegou e a migration deve ser revista antes de seguir.
--   2. `resumo_situacao()` soma o mesmo que a query de controle equivalente sobre
--      `financial_account_control` (excluindo status_id = 9).
--   3. `aging_vencidos()` bate com `count(*) FROM financial_account_control WHERE
--      status_id IN (1,2,3) AND due_date < CURRENT_DATE`.
--   4. `anon` recebe 42501 (permission denied) ao tentar executar qualquer função do schema.
--   5. `authenticated` recebe 42501 ao tentar INSERT/UPDATE/DELETE em analytics.ai_chat_log.
