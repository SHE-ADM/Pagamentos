-- 127_demonstrativo_custos_importacao.sql
--
-- CORRECAO: analytics.demonstrativo_despesas nao reconhecia o tipo 9 do catalogo
-- financial_type_group ("Custos de Importacoes", applies_to='both'), criado direto no banco em
-- 2026-08-14 18:03 (sem CRUD no app; sem passar por esta migration).
--
-- ---------------------------------------------------------------------------
-- O QUE ESTAVA ERRADO
-- ---------------------------------------------------------------------------
-- O CASE da funcao (migration 104) so reconhecia 4 tipos + um ELSE:
--
--     WHEN chart_subgroup_type_id = 7 THEN 1   -- Custos de Mercadorias
--     WHEN chart_subgroup_type_id = 5 THEN 2   -- Despesas Fixas
--     WHEN chart_subgroup_type_id = 6 THEN 3   -- Despesas Variaveis
--     WHEN chart_group_nature_id  = 4 THEN 4   -- Tributos (passivo)
--     ELSE 5                                    -- Nao classificado
--
-- O grupo "23 - Despesas com Importacao e Aquisicao" (chart_account_group_id 26, subgrupos
-- 23.1 "Despesas Aduaneiras" e 23.2 "Servicos de Importacao") foi reclassificado hoje para o tipo
-- 9. Como 9 nao aparece em nenhuma condicao do CASE, cada conta caiu no primeiro teste que
-- casasse por ACIDENTE, nao por classificacao correta:
--
--   * contas cujo GRUPO tem natureza Custos (8): nenhum teste casa -> ELSE -> "Nao classificado".
--     Medido no periodo 01-14/08/2026: 23 contas, R$ 1.900.565,19 (era a fatia de ~37% que o
--     proprio assistente de IA sinalizou como digna de investigacao, na conversa que originou
--     este achado).
--   * contas cujo GRUPO tem natureza Passivo (4): batem no `chart_group_nature_id = 4` -> viram
--     "Tributos (passivo tributario)" -- ERRADO, sao custo de importacao, nao tributo a recolher.
--     Medido no mesmo periodo: 6 contas, R$ 633.683,10, inflando a linha de Tributos.
--
-- Este achado NAO e sobre a Onda 9/10 (nada a ver com roadmap-gatilhos) -- e um gap de
-- acompanhamento: o cadastro do plano de contas evoluiu (tipo novo) e a funcao SQL, escrita em
-- 31/07, nao foi ensinada sobre ele. Decisao do usuario em 2026-08-14: corrigir agora (esta
-- migration) e, separadamente, avaliar tornar o demonstrativo dinamico (ler o catalogo em vez de
-- decorar ids) para que o proximo tipo novo nao repita o problema.
--
-- ---------------------------------------------------------------------------
-- A CORRECAO
-- ---------------------------------------------------------------------------
-- Nova linha "Custos de Importacao" (chart_subgroup_type_id = 9), com PRECEDENCIA sobre o teste
-- de natureza=4 -- mesma logica ja aplicada aos tipos 7/5/6 (o tipo do SUBGRUPO vence a natureza
-- do GRUPO). `OR chart_group_nature_id = 9` cobre o caso (hoje inexistente, 0 grupos) de o tipo
-- ser atribuido diretamente ao GRUPO -- o catalogo permite (applies_to='both'), entao a condicao
-- fica pronta para quando isso acontecer, sem exigir nova migration so por essa combinacao.
--
-- `CREATE OR REPLACE` (nao DROP+CREATE): a assinatura (parametros e RETURNS TABLE) NAO muda, so o
-- CASE interno -- e por isso os GRANTs sobrevivem sem precisar reemitir REVOKE/GRANT (a licao da
-- migration 116 vale para DROP+CREATE; aqui nao se aplica).

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
            -- ids do catalogo financial_type_group: 5=Despesas Fixas, 6=Despesas Variaveis,
            -- 7=Custos de Mercadorias, 9=Custos de Importacoes (subgroup ou group,
            -- applies_to='both'); 4=Passivo (applies_to='group').
            CASE
                WHEN v.chart_subgroup_type_id = 7 THEN 1
                WHEN v.chart_subgroup_type_id = 9
                  OR v.chart_group_nature_id  = 9 THEN 2
                WHEN v.chart_subgroup_type_id = 5 THEN 3
                WHEN v.chart_subgroup_type_id = 6 THEN 4
                WHEN v.chart_group_nature_id  = 4 THEN 5
                ELSE 6
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
            WHEN 2 THEN 'Custos de Importação'
            WHEN 3 THEN 'Despesas Fixas'
            WHEN 4 THEN 'Despesas Variáveis'
            WHEN 5 THEN 'Tributos (passivo tributário)'
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
  'Linhas mutuamente exclusivas e exaustivas: Custos de Mercadorias, Custos de Importação, '
  'Despesas Fixas, Despesas Variáveis, Tributos (natureza Passivo) e Não classificado, de modo '
  'que a soma SEMPRE fecha com o Total de saídas. Tool: demonstrativo_despesas.';

-- ---------------------------------------------------------------------------
-- VERIFICACAO — assinatura inalterada, mas o corpo mudou: reprova os invariantes de origem
-- (o total continua fechando) e os dois achados especificos desta migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_soma_linhas    numeric(15,2);
  v_total_linha    numeric(15,2);
  v_custos_imp_qt  bigint;
  v_custos_imp_rs  numeric(15,2);
  v_ctrl_imp_qt    bigint;
  v_ctrl_imp_rs    numeric(15,2);
  v_tributos_qt    bigint;
  v_tributos_rs    numeric(15,2);
  v_ctrl_trib_qt   bigint;
  v_ctrl_trib_rs   numeric(15,2);
  v_grant_auth     boolean;
  v_grant_anon     boolean;
BEGIN
  -- P1 — ORACULO DIFERENCIAL da linha NOVA: a tool bate com uma consulta de controle
  -- INDEPENDENTE (le vw_payables direto, sem passar pelo CASE que acabou de mudar).
  SELECT COALESCE(sum(account_count), 0)::bigint, COALESCE(sum(total_amount), 0)::numeric(15,2)
    INTO v_custos_imp_qt, v_custos_imp_rs
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento')
   WHERE line_label = 'Custos de Importação';

  SELECT count(*), COALESCE(sum(v.amount), 0)::numeric(15,2)
    INTO v_ctrl_imp_qt, v_ctrl_imp_rs
    FROM analytics.vw_payables v
   WHERE NOT v.is_cancelled
     AND (v.chart_subgroup_type_id = 9 OR v.chart_group_nature_id = 9);

  IF v_custos_imp_qt <> v_ctrl_imp_qt OR v_custos_imp_rs IS DISTINCT FROM v_ctrl_imp_rs THEN
    RAISE EXCEPTION 'ABORTADO: oraculo divergiu na linha Custos de Importação — tool (% contas, '
                    'R$ %) x controle (% contas, R$ %)',
                    v_custos_imp_qt, v_custos_imp_rs, v_ctrl_imp_qt, v_ctrl_imp_rs;
  END IF;

  -- Sanidade: nao aceitar zero, senao a sonda so provaria "0 = 0" e passaria mesmo com o CASE
  -- ainda quebrado. O caso de origem (2026-08-14) mediu 29 contas (23 nature=Custos + 6
  -- nature=Passivo) antes da correcao.
  IF v_custos_imp_qt < 29 THEN
    RAISE EXCEPTION 'ABORTADO: esperava >= 29 contas em Custos de Importação (as medidas em '
                    '2026-08-14), achei %. A correção pode não ter pego o caso de origem.',
                    v_custos_imp_qt;
  END IF;

  -- P2 — ORACULO DIFERENCIAL da linha Tributos, com a EXCLUSÃO que motivou esta migration: o
  -- controle usa a MESMA precedência corrigida (nature=4 mas NÃO tipo 9), então uma conta de tipo
  -- 9 e natureza Passivo tem de ter DEIXADO essa linha — é o achado dos R$ 633.683,10.
  SELECT COALESCE(sum(account_count), 0)::bigint, COALESCE(sum(total_amount), 0)::numeric(15,2)
    INTO v_tributos_qt, v_tributos_rs
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento')
   WHERE line_label = 'Tributos (passivo tributário)';

  SELECT count(*), COALESCE(sum(v.amount), 0)::numeric(15,2)
    INTO v_ctrl_trib_qt, v_ctrl_trib_rs
    FROM analytics.vw_payables v
   WHERE NOT v.is_cancelled
     AND v.chart_group_nature_id = 4
     AND NOT (v.chart_subgroup_type_id = 9 OR v.chart_group_nature_id = 9);

  IF v_tributos_qt <> v_ctrl_trib_qt OR v_tributos_rs IS DISTINCT FROM v_ctrl_trib_rs THEN
    RAISE EXCEPTION 'ABORTADO: oraculo divergiu na linha Tributos — tool (% contas, R$ %) x '
                    'controle (% contas, R$ %)',
                    v_tributos_qt, v_tributos_rs, v_ctrl_trib_qt, v_ctrl_trib_rs;
  END IF;

  -- P3 — INVARIANTE DE ORIGEM (migration 104): a soma das linhas 1..6 tem de fechar com o
  -- "Total de saídas" (linha 9) — o CASE continua MUTUAMENTE EXCLUSIVO e EXAUSTIVO depois da
  -- mudança. Ampla o suficiente para cobrir toda a base (2000-01-01 até 10 anos à frente).
  SELECT COALESCE(sum(total_amount) FILTER (WHERE line_order <> 9), 0),
         COALESCE(sum(total_amount) FILTER (WHERE line_order = 9), 0)
    INTO v_soma_linhas, v_total_linha
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento');

  IF v_soma_linhas IS DISTINCT FROM v_total_linha THEN
    RAISE EXCEPTION 'ABORTADO: a soma das linhas (R$ %) não fecha com o Total de saídas (R$ %)',
                    v_soma_linhas, v_total_linha;
  END IF;

  -- P4 — GRANTS sobrevivem ao CREATE OR REPLACE (assinatura idêntica; sem DROP não há por que
  -- terem sumido, mas a lição da 116/124/anteriores é NUNCA supor, sempre medir).
  SELECT has_function_privilege('authenticated',
           'analytics.demonstrativo_despesas(date,date,text,bigint)', 'EXECUTE'),
         has_function_privilege('anon',
           'analytics.demonstrativo_despesas(date,date,text,bigint)', 'EXECUTE')
    INTO v_grant_auth, v_grant_anon;

  IF NOT v_grant_auth THEN
    RAISE EXCEPTION 'ABORTADO: authenticated perdeu EXECUTE em demonstrativo_despesas';
  END IF;
  IF v_grant_anon THEN
    RAISE EXCEPTION 'ABORTADO: anon ganhou EXECUTE em demonstrativo_despesas (vazamento)';
  END IF;

  RAISE NOTICE 'OK: Custos de Importação = % contas / R$ % · Tributos recalculado = % contas / '
               'R$ % · soma das linhas fecha com o total (R$ %) · grants intactos '
               '(authenticated sim, anon não)',
               v_custos_imp_qt, v_custos_imp_rs, v_tributos_qt, v_tributos_rs, v_total_linha;
END $$;
