-- 125_pontualidade_mes_parcial.sql
--
-- `analytics.pontualidade_pagamento` com group_by='mes' passa a DECLARAR o mes incompleto.
--
-- ---------------------------------------------------------------------------
-- 🔴 AQUI A TRUNCAGEM E PIOR QUE A DA 124 — O ROTULO MENTE SOZINHO
-- ---------------------------------------------------------------------------
-- Na 124 o balde parcial de `gasto_por_periodo` vinha rotulado por uma DATA (2026-08-10), e quem
-- lesse com atencao podia desconfiar. Aqui o rotulo e "2026-07", que se le como JULHO INTEIRO.
-- Medido em 2026-08-13, com group_by='mes' e sem filtro nenhum:
--
--     2026-07 ->  38 contas, R$   190.417,09, pontualidade 31,58 pct   ... 3 de 31 dias
--     2026-08 -> 187 contas, R$ 4.717.027,40, pontualidade 42,25 pct   ... 13 de 31 dias
--
-- Um modelo que receba isso responde "agosto explodiu: 5x mais contas e 25x mais dinheiro que
-- julho". Falso — julho tem TRES DIAS de dado. E note que nem sequer e o filtro do usuario que
-- corta julho: e o proprio CORTE DE COBERTURA da 121 (`payment_date_confiavel_desde()` = 29/07),
-- que a funcao ja declara no agregado (`fora_da_cobertura`) mas nao declarava POR MES.
--
-- Sao TRES truncagens distintas, e todas colapsam na mesma conta:
--   (a) o corte de cobertura      — morde o PRIMEIRO mes (o mais enganoso, porque e invisivel);
--   (b) o presente                — morde o ULTIMO mes (o mes corrente esta sempre em curso);
--   (c) p_date_from / p_date_to   — mordem as bordas quando o usuario filtra.
--
-- ---------------------------------------------------------------------------
-- O QUE E, E O QUE NAO E, AFETADO
-- ---------------------------------------------------------------------------
-- `contas` e `valor_total` sao SOMAS: um mes de 3 dias tem mecanicamente menos que um de 31, e e
-- ai que a comparacao inverte a conclusao. Ja `pct_pontualidade`, `atraso_medio_dias` e
-- `desvio_medio_dias` sao RAZOES — nao encolhem com o numero de dias, mas ficam ruidosas em
-- amostra pequena, e o numero de dias e justamente o que permite julgar isso. A descricao da tool
-- diz as duas coisas, porque um modelo que so souber "e parcial" nao sabe o que fazer com a
-- informacao.
--
-- ---------------------------------------------------------------------------
-- 🔴 O "HOJE" E `America/Sao_Paulo`, NUNCA `CURRENT_DATE` (a mesma medicao da 124)
-- ---------------------------------------------------------------------------
-- A sessao deste banco roda em UTC. Das 21h a meia-noite em Sao Paulo o UTC ja e o dia seguinte:
-- no ultimo dia do mes, o mes corrente passaria a ser considerado COMPLETO — errando exatamente
-- na virada, e de um jeito que some quando se vai conferir no dia seguinte.
--
-- ---------------------------------------------------------------------------
-- ESCOPO: SO O EIXO 'mes' TEM PERIODO PROPRIO
-- ---------------------------------------------------------------------------
-- Em 'geral', 'fornecedor', 'empresa' e 'faixa' o grupo nao delimita periodo algum — a janela e a
-- da consulta inteira, e ela ja e declarada por `cobertura_desde`/`fora_da_cobertura`. Nesses
-- eixos as tres colunas novas vem NULL, e a descricao da tool diz isso. Preenche-las com o
-- periodo do filtro seria pior que deixa-las vazias: daria a impressao de uma ressalva por grupo
-- que nao existe.
--
-- ---------------------------------------------------------------------------
-- 🔴 DROP + CREATE, E OS GRANTS SAO PARTE OBRIGATORIA DO ARQUIVO
-- ---------------------------------------------------------------------------
-- Coluna nova no `RETURNS TABLE` muda o TIPO DE RETORNO: `CREATE OR REPLACE` e recusado com
-- 42P13, e o DROP APAGA OS GRANTS. Licao da 116, exercitada na 118 e de novo na 124. ACL medida
-- antes desta migration: `{postgres=X, authenticated=X}` — e ela que a secao de GRANT restaura.
--
-- IDEMPOTENTE: `DROP FUNCTION IF EXISTS` + `CREATE`; o DO final so le e sonda.

DROP FUNCTION IF EXISTS analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer);

CREATE FUNCTION analytics.pontualidade_pagamento(
    p_date_from  date    DEFAULT NULL,   -- filtra por payment_date (a data do PAGAMENTO)
    p_date_to    date    DEFAULT NULL,
    p_group_by   text    DEFAULT 'geral',
    p_sk_company bigint  DEFAULT NULL,
    p_min_contas integer DEFAULT 1,
    p_limit      integer DEFAULT 50
)
RETURNS TABLE (
    grupo                   text,
    contas                  integer,
    valor_total             numeric(15,2),
    em_dia                  integer,
    atrasadas               integer,
    antecipadas             integer,
    pct_pontualidade        numeric(5,2),
    atraso_medio_dias       numeric(6,2),
    atraso_mediano_dias     numeric(6,2),
    atraso_maximo_dias      integer,
    desvio_medio_dias       numeric(6,2),
    cobertura_desde         date,
    fora_da_cobertura       integer,
    excluidas_venc_alterado integer,
    total_encontrado        integer,
    -- ---------- colunas ACRESCENTADAS pela 125 (sempre no FIM) ----------
    -- NULL fora do eixo 'mes': ali o grupo nao delimita periodo.
    dias_cobertos           integer,
    dias_totais             integer,
    mes_parcial             boolean
)
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
    WITH corte AS (
        SELECT analytics.payment_date_confiavel_desde()      AS desde,
               -- Fuso EXPLICITO: a sessao roda em UTC, e `CURRENT_DATE` faria o mes corrente
               -- parecer completo das 21h a meia-noite do ultimo dia do mes.
               (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje
    ),
    -- O dominio fechado do eixo, avaliado UMA vez. Repetir a lista nos dois lugares que precisam
    -- dela (o agregado e a linha de aviso) criaria a 2a fonte de verdade classica: acrescentar um
    -- eixo em um so faria o outro discordar em silencio.
    eixo AS (
        SELECT p_group_by IN ('geral', 'fornecedor', 'empresa', 'mes', 'faixa') AS valido
    ),
    -- TODAS as contas pagas no filtro — inclusive as do backfill. E daqui que sai a contagem do
    -- que foi excluido: uma metrica que esconde a propria cobertura nao e auditavel.
    pagas AS (
        SELECT v.payable_id, v.payment_date, v.due_date, v.days_late, v.amount,
               v.supplier_name, v.company_name, v.sk_company
          FROM analytics.vw_payables v
         WHERE v.status_id = 8
           AND v.payment_date IS NOT NULL
           AND (p_date_from  IS NULL OR v.payment_date >= p_date_from)
           AND (p_date_to    IS NULL OR v.payment_date <= p_date_to)
           AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
    ),
    -- Vencimento alterado DEPOIS do pagamento ⇒ days_late deixou de medir atraso. Detectavel
    -- desde a Onda 7; o `@>` usa o indice GIN de campos_alterados. A subconsulta roda com o
    -- papel do usuario (SECURITY INVOKER), e a policy da audit_log espelha a mesma visibilidade
    -- da fato — entao o usuario restrito enxerga os eventos das contas que ele proprio ve.
    suspeitas AS (
        SELECT DISTINCT a.registro_id
          FROM public.audit_log a
          JOIN pagas p ON p.payable_id = a.registro_id
         WHERE a.tabela = 'financial_account_control'
           AND a.campos_alterados @> ARRAY['due_date']
           AND a.criado_em::date >= p.payment_date
    ),
    confiaveis AS (
        SELECT p.*
          FROM pagas p, corte c
         WHERE p.payment_date >= c.desde
           AND NOT EXISTS (SELECT 1 FROM suspeitas s WHERE s.registro_id = p.payable_id)
    ),
    -- Contagens de cobertura, calculadas UMA vez e repetidas em cada linha (mesmo padrao de
    -- `total_encontrado`): o consumidor e um modelo de linguagem, e ressalva que nao vem junto
    -- do numero nao e dita ao usuario.
    cobertura AS (
        SELECT
            (SELECT c.desde FROM corte c)                                     AS desde,
            (SELECT c.hoje  FROM corte c)                                     AS hoje,
            (SELECT count(*) FROM pagas p, corte c
              WHERE p.payment_date < c.desde)::integer                        AS fora,
            (SELECT count(*) FROM pagas p, corte c
              WHERE p.payment_date >= c.desde
                AND EXISTS (SELECT 1 FROM suspeitas s
                             WHERE s.registro_id = p.payable_id))::integer    AS excluidas
    ),
    agrupado AS (
        SELECT
            -- Despacho por CASE + dominio fechado, nunca SQL dinamico: valor fora do dominio
            -- devolve VAZIO em vez de agregar errado em silencio (regra da camada analytics).
            CASE p_group_by
                WHEN 'geral'      THEN 'Geral'
                WHEN 'fornecedor' THEN COALESCE(f.supplier_name, '(sem fornecedor)')
                WHEN 'empresa'    THEN COALESCE(f.company_name, '(sem empresa)')
                WHEN 'mes'        THEN to_char(f.payment_date, 'YYYY-MM')
                WHEN 'faixa'      THEN CASE
                                          WHEN f.days_late <  0 THEN 'antecipado'
                                          WHEN f.days_late =  0 THEN 'em dia'
                                          WHEN f.days_late <= 7 THEN 'atraso 1-7 dias'
                                          WHEN f.days_late <= 30 THEN 'atraso 8-30 dias'
                                          ELSE 'atraso 31+ dias'
                                       END
            END                                                              AS grupo,
            -- O 1o dia do mes do grupo, so no eixo 'mes'. Sai do DADO (date_trunc sobre a propria
            -- payment_date), nunca de um `to_date` do rotulo: converter o texto de volta para data
            -- criaria uma 2a fonte de verdade que divergiria no dia em que o rotulo mudasse.
            -- Dentro de um grupo 'mes' todas as linhas caem no mesmo mes, entao min() E o mes.
            CASE WHEN p_group_by = 'mes'
                 THEN min(date_trunc('month', f.payment_date))::date
            END                                                              AS mes_ini,
            count(*)::integer                                                AS contas,
            COALESCE(sum(f.amount), 0)::numeric(15,2)                        AS valor_total,
            count(*) FILTER (WHERE f.days_late = 0)::integer                 AS em_dia,
            count(*) FILTER (WHERE f.days_late > 0)::integer                 AS atrasadas,
            count(*) FILTER (WHERE f.days_late < 0)::integer                 AS antecipadas,
            -- Pontualidade = pagou ATE o vencimento (antecipado tambem e pontual).
            round(100.0 * count(*) FILTER (WHERE f.days_late <= 0)
                        / NULLIF(count(*), 0), 2)::numeric(5,2)              AS pct_pontualidade,
            -- 🔴 "Atraso medio" so pode somar o que E atraso. Incluir as antecipacoes (days_late
            -- negativo) produziria um numero menor que o atraso real — e com o nome de atraso.
            -- Quem quiser o liquido tem `desvio_medio_dias`, que existe justamente para isso.
            round(avg(f.days_late) FILTER (WHERE f.days_late > 0), 2)::numeric(6,2)
                                                                             AS atraso_medio_dias,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY f.days_late)
                   FILTER (WHERE f.days_late > 0))::numeric, 2)::numeric(6,2)
                                                                             AS atraso_mediano_dias,
            max(f.days_late) FILTER (WHERE f.days_late > 0)::integer         AS atraso_maximo_dias,
            round(avg(f.days_late), 2)::numeric(6,2)                         AS desvio_medio_dias
          FROM confiaveis f
         WHERE (SELECT e.valido FROM eixo e)
         GROUP BY 1
        HAVING count(*) >= GREATEST(COALESCE(p_min_contas, 1), 1)
    ),
    -- 🔴 O PERIODO SEM COBERTURA NAO PODE DEVOLVER VAZIO — foi o defeito achado na autorrevisao
    -- adversarial da Onda 9, e reproduzido no banco antes de existir esta CTE: junho/2026 tem
    -- **113 contas pagas**, todas anteriores ao corte, e a funcao devolvia ZERO linhas. Um modelo
    -- que recebe zero linha responde "nao houve pagamento no periodo" — falso, e invertendo a
    -- conclusao: houve 113, elas so nao sao MENSURAVEIS. A diferenca entre "nao existe" e "existe
    -- mas nao da para medir" e justamente o que esta tool foi feita para preservar.
    --
    -- 🔴 A CONDICAO OLHA `confiaveis`, NAO `agrupado` (correcao do achado B1 da 123).
    -- `agrupado` ja passou pelo HAVING de `p_min_contas`, entao vazio ali tambem significa "ha
    -- populacao, mas nenhum grupo atingiu o piso" — e nesse caso o aviso afirmaria, com todas as
    -- letras, que nao existe dado confiavel no periodo em que existem contas medidas.
    -- `confiaveis` vazio implica `agrupado` vazio, entao o caso legitimo continua coberto.
    --
    -- A linha de aviso so aparece quando ha conta paga no filtro E nenhuma delas e confiavel; um
    -- periodo genuinamente sem pagamento continua devolvendo vazio, que ali e a resposta correta.
    linhas AS (
        SELECT a.grupo, a.mes_ini, a.contas, a.valor_total, a.em_dia, a.atrasadas, a.antecipadas,
               a.pct_pontualidade, a.atraso_medio_dias, a.atraso_mediano_dias,
               a.atraso_maximo_dias, a.desvio_medio_dias
          FROM agrupado a
         UNION ALL
        SELECT '(nenhuma conta com data de pagamento confiavel no periodo)',
               NULL::date,
               0, 0::numeric(15,2), 0, 0, 0,
               NULL::numeric(5,2), NULL::numeric(6,2), NULL::numeric(6,2),
               NULL::integer, NULL::numeric(6,2)
         WHERE NOT EXISTS (SELECT 1 FROM confiaveis)
           AND EXISTS (SELECT 1 FROM pagas)
           -- 🔴 Eixo INVALIDO continua devolvendo vazio. Sem esta linha, a correcao do aviso
           -- quebrava o dominio fechado: `agrupado` fica vazio por eixo invalido, `pagas` nao
           -- esta vazio, e o aviso apareceria — trocando "parametro errado" por uma resposta de
           -- aparencia legitima.
           AND (SELECT e.valido FROM eixo e)
    ),
    -- A janela EFETIVA do mes, calculada UMA vez para nao repetir a expressao em tres colunas.
    -- As tres truncagens entram aqui juntas: corte de cobertura, filtro do usuario e presente.
    com_janela AS (
        SELECT a.*,
               c.desde, c.fora, c.excluidas,
               -- 🔴 O `CASE WHEN mes_ini IS NULL` NAO e redundante: **LEAST e GREATEST IGNORAM
               -- NULL**, ao contrario dos operadores aritmeticos. Sem ele, fora do eixo 'mes'
               -- (onde mes_ini e nulo) `LEAST(NULL, p_date_to, hoje)` devolve `hoje` e
               -- `GREATEST(NULL, ..., corte)` devolve `corte` — e a coluna sai preenchida com a
               -- largura da JANELA DA CONSULTA, um numero plausivel e sem sentido nenhum ali.
               -- Reproduzido no ensaio desta migration: 11 linhas de 'geral'/'faixa'/'fornecedor'
               -- vieram com dias_cobertos preenchido; foi a sonda P3 que pegou, antes de aplicar.
               CASE WHEN a.mes_ini IS NULL THEN NULL ELSE
                   LEAST((a.mes_ini + interval '1 month')::date - 1,
                         COALESCE(p_date_to, 'infinity'::date),
                         c.hoje)
                   - GREATEST(a.mes_ini,
                              COALESCE(p_date_from, '-infinity'::date),
                              c.desde) + 1
               END                                          AS cobertos,
               CASE WHEN a.mes_ini IS NULL THEN NULL ELSE
                   (a.mes_ini + interval '1 month')::date - a.mes_ini
               END                                          AS totais
          FROM linhas a, cobertura c
    )
    SELECT
        x.grupo, x.contas, x.valor_total, x.em_dia, x.atrasadas, x.antecipadas,
        x.pct_pontualidade, x.atraso_medio_dias, x.atraso_mediano_dias,
        x.atraso_maximo_dias, x.desvio_medio_dias,
        x.desde, x.fora, x.excluidas,
        -- Contagem REAL antes do LIMIT — 5a ocorrencia da armadilha da truncagem silenciosa
        -- (gasto_por_fornecedor, documentos_fiscais, fornecedores_recorrentes, auditoria_*).
        -- JANELA, nunca subconsulta repetindo o corpo: a subconsulta herdaria o LIMIT e devolveria
        -- o total TRUNCADO — o mesmo defeito com cara de correcao.
        (count(*) OVER ())::integer,
        x.cobertos::integer,
        x.totais::integer,
        -- NULL propaga sozinho fora do eixo 'mes' (mes_ini nulo), que e o que se quer: ali nao ha
        -- periodo por grupo, e afirmar "completo" seria tao errado quanto afirmar "parcial".
        (x.cobertos < x.totais)
      FROM com_janela x
     -- Faixa tem ordem PROPRIA (do melhor para o pior); os demais eixos ordenam por dinheiro.
     -- O `grupo` fecha a ordem TOTAL: sem ele, empate + LIMIT devolve conjuntos diferentes entre
     -- execucoes, e o ranking "muda sozinho" (licao de stableOrder/applyOrder, valendo no banco).
     ORDER BY
        CASE WHEN p_group_by = 'faixa' THEN
            CASE x.grupo
                WHEN 'antecipado'      THEN 1
                WHEN 'em dia'          THEN 2
                WHEN 'atraso 1-7 dias' THEN 3
                WHEN 'atraso 8-30 dias' THEN 4
                ELSE 5
            END
        END NULLS FIRST,
        x.valor_total DESC,
        x.grupo ASC
     -- Clamp: p_limit vem de parametro de tool (LLM), e LIMIT negativo levanta 2201W em runtime.
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

COMMENT ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) IS
  'Pontualidade de pagamento (Onda 9; 123 corrigiu o aviso, 125 acrescentou o mes parcial): '
  'quanto se paga em dia, com que atraso e onde. '
  'NAO e DPO — DPO exige CMV e o passivo contabil da empresa; aqui a base e o que chegou por '
  'e-mail. SECURITY INVOKER: o grupo restrito ve apenas as proprias contas. '
  '🔴 COBERTURA PARCIAL POR CONSTRUCAO: so entram contas pagas a partir de '
  'analytics.payment_date_confiavel_desde() — antes disso payment_date veio do backfill da 096 '
  '(= vencimento) e produziria atraso zero artificial. `fora_da_cobertura` e `excluidas_venc_alterado` '
  'dizem quantas ficaram de fora e por que; cite-as ao responder. '
  '`atraso_medio_dias` soma SO as atrasadas (NULL quando nao houve nenhuma); `desvio_medio_dias` '
  'e o liquido com sinal, incluindo antecipacoes. `total_encontrado` e a contagem real antes do '
  'LIMIT: use-a para contar, nunca o numero de linhas. '
  '🔴 A linha de aviso "(nenhuma conta com data de pagamento confiavel no periodo)" sai APENAS '
  'quando nenhuma conta paga do periodo tem carimbo real — nunca por efeito de `p_min_contas`. '
  '🔴 Em group_by=mes, `mes_parcial` diz se o mes esta INCOMPLETO, com `dias_cobertos` de '
  '`dias_totais`: o primeiro mes costuma ser cortado pelo corte de cobertura e o ultimo pelo '
  'presente. `contas` e `valor_total` de um mes de 3 dias nao se comparam com os de um mes cheio. '
  'Nos demais eixos as tres colunas vem NULL — ali o grupo nao delimita periodo.';

-- ---------------------------------------------------------------------------
-- GRANTS — o DROP acima os apagou; sem esta secao a funcao fica aberta a PUBLIC
-- ---------------------------------------------------------------------------
GRANT  EXECUTE ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICACAO — a migration ABORTA se qualquer invariante nao valer
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_hoje         date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_corte        date := analytics.payment_date_confiavel_desde();
  v_meses        integer;
  v_divergencias integer;
  v_parciais     integer;
  v_completos    integer;
  v_nulos        integer;
  v_aviso_nulo   integer;
  v_pre_corte    integer;
  v_aviso_linhas integer;
  v_maior_grupo  integer;
  v_piso         integer;
  v_com_piso     integer;
  v_aviso_piso   integer;
  v_dominio      integer;
  v_tool_contas  integer;
  v_ctrl_contas  integer;
  v_anon         boolean;
  v_usuario      uuid;
  v_uid          uuid;
  v_como_auth    integer := -1;
  v_p7_executou  boolean := false;
BEGIN
  -- P0 ANTI-VACUIDADE: sem populacao confiavel, TODA sonda abaixo mediria o vazio.
  --
  -- O filtro `mes_parcial IS NOT NULL` descarta a LINHA DE AVISO sem repetir o literal dela (que
  -- viraria 2a fonte de verdade). Ele faz dupla funcao: se a coluna nao estivesse sendo calculada,
  -- a contagem daria 0 e a migration abortaria aqui — o que e o desfecho certo.
  --
  -- Isso tambem garante que a sonda P2 nunca veja o rotulo do aviso: ele so aparece quando NAO ha
  -- mes real, e P0 exige que haja. Sem essa exclusividade, o `to_date(grupo, 'YYYY-MM')` do
  -- oraculo tentaria converter "(nenhuma conta ...)" e a migration morreria com erro de formato,
  -- que aponta para o lugar errado.
  SELECT count(*)::integer INTO v_meses
    FROM analytics.pontualidade_pagamento(p_group_by => 'mes')
   WHERE mes_parcial IS NOT NULL;
  IF v_meses = 0 THEN
    RAISE EXCEPTION 'ABORTADO: nenhuma conta paga com carimbo real (>= %) chegou ao eixo mes — ou '
                    'a populacao confiavel esta vazia, ou a coluna mes_parcial nao esta sendo '
                    'calculada. Nos dois casos as sondas abaixo nao provariam nada', v_corte;
  END IF;

  -- -------------------------------------------------------------------------
  -- P1 🔴 ORACULO DIFERENCIAL: os agregados NAO PODEM ter mudado.
  -- -------------------------------------------------------------------------
  -- Esta migration acrescenta ressalva; mexer no numero seria regressao. O controle reproduz o
  -- recorte da 121/123 (carimbo real + vencimento nao alterado depois do pagamento).
  SELECT sum(contas)::integer INTO v_tool_contas
    FROM analytics.pontualidade_pagamento(p_group_by => 'mes');

  SELECT count(*)::integer INTO v_ctrl_contas
    FROM public.financial_account_control f
   WHERE f.status_id = 8
     AND f.payment_date >= v_corte
     AND NOT EXISTS (
           SELECT 1 FROM public.audit_log a
            WHERE a.tabela = 'financial_account_control'
              AND a.registro_id = f.id
              AND a.campos_alterados @> ARRAY['due_date']
              AND a.criado_em::date >= f.payment_date);

  IF v_tool_contas <> v_ctrl_contas THEN
    RAISE EXCEPTION 'ABORTADO: oraculo divergiu — a reescrita mexeu no agregado: a soma dos meses '
                    'da % contas e a query de controle da %', v_tool_contas, v_ctrl_contas;
  END IF;

  -- -------------------------------------------------------------------------
  -- P2 🔴 ORACULO ARITMETICO SOBRE **TODOS** OS MESES.
  -- -------------------------------------------------------------------------
  -- Recalcula a janela efetiva de forma independente do corpo da funcao, a partir do ROTULO do
  -- grupo. As tres truncagens entram: corte de cobertura, filtro (aqui ausente) e presente.
  SELECT count(*)::integer INTO v_divergencias
    FROM analytics.pontualidade_pagamento(p_group_by => 'mes') p
   WHERE p.dias_totais <> ((to_date(p.grupo, 'YYYY-MM') + interval '1 month')::date
                           - to_date(p.grupo, 'YYYY-MM'))
      OR p.dias_cobertos <> (LEAST((to_date(p.grupo, 'YYYY-MM') + interval '1 month')::date - 1,
                                   v_hoje)
                             - GREATEST(to_date(p.grupo, 'YYYY-MM'), v_corte) + 1)
      OR p.mes_parcial <> (p.dias_cobertos < p.dias_totais);
  IF v_divergencias > 0 THEN
    RAISE EXCEPTION 'ABORTADO: % mes(es) com dias_cobertos/mes_parcial fora da aritmetica da '
                    'janela efetiva — a coluna informaria dia que o mes nao cobre', v_divergencias;
  END IF;

  -- P2b A DISCRIMINACAO. Hoje TODOS os meses sao parciais por construcao (o corte e 29/07 e o mes
  -- corrente esta em curso), entao nao ha como exercitar o ramo `false` com dado real — e dizer
  -- isso e melhor que fingir que se provou. A assercao de P2 cobre o ramo automaticamente no dia
  -- em que existir um mes inteiro dentro da cobertura.
  SELECT count(*) FILTER (WHERE mes_parcial)::integer,
         count(*) FILTER (WHERE NOT mes_parcial)::integer
    INTO v_parciais, v_completos
    FROM analytics.pontualidade_pagamento(p_group_by => 'mes');
  IF v_parciais = 0 THEN
    RAISE EXCEPTION 'ABORTADO: nenhum mes marcado parcial, com corte em % e hoje % — ou a coluna '
                    'nao esta sendo calculada, ou a cobertura mudou de natureza', v_corte, v_hoje;
  END IF;
  IF v_completos = 0 THEN
    RAISE NOTICE 'pontualidade: os % mes(es) sao parciais (corte % / hoje %) — o ramo `completo` '
                 'sera exercitado por P2 quando houver mes inteiro dentro da cobertura',
                 v_parciais, v_corte, v_hoje;
  END IF;

  -- -------------------------------------------------------------------------
  -- P3 🔴 FORA DO EIXO 'mes' as tres colunas vem NULL.
  -- -------------------------------------------------------------------------
  -- Preenche-las com o periodo do filtro daria a impressao de uma ressalva por grupo que nao
  -- existe — e num eixo como 'fornecedor' isso seria simplesmente falso.
  SELECT count(*)::integer INTO v_nulos
    FROM (
      SELECT dias_cobertos, dias_totais, mes_parcial
        FROM analytics.pontualidade_pagamento(p_group_by => 'geral')
      UNION ALL
      SELECT dias_cobertos, dias_totais, mes_parcial
        FROM analytics.pontualidade_pagamento(p_group_by => 'faixa')
      UNION ALL
      SELECT dias_cobertos, dias_totais, mes_parcial
        FROM analytics.pontualidade_pagamento(p_group_by => 'fornecedor', p_limit => 5)
    ) t
   WHERE dias_cobertos IS NOT NULL OR dias_totais IS NOT NULL OR mes_parcial IS NOT NULL;
  IF v_nulos > 0 THEN
    RAISE EXCEPTION 'ABORTADO: % linha(s) fora do eixo mes vieram com as colunas de periodo '
                    'preenchidas — ali o grupo nao delimita periodo algum', v_nulos;
  END IF;

  -- -------------------------------------------------------------------------
  -- P4 NAO REGREDIR A 123: periodo 100 pct fora da cobertura segue com UMA linha de aviso, e ela
  -- tambem vem com as colunas novas NULL (nao ha mes a declarar).
  -- -------------------------------------------------------------------------
  SELECT count(*)::integer INTO v_pre_corte
    FROM public.financial_account_control
   WHERE status_id = 8 AND payment_date < v_corte;

  IF v_pre_corte = 0 THEN
    RAISE NOTICE 'pontualidade: nao ha conta paga anterior ao corte — sonda P4 pulada';
  ELSE
    SELECT count(*)::integer,
           count(*) FILTER (WHERE dias_cobertos IS NULL AND dias_totais IS NULL
                              AND mes_parcial IS NULL)::integer
      INTO v_aviso_linhas, v_aviso_nulo
      FROM analytics.pontualidade_pagamento(p_date_to => v_corte - 1, p_group_by => 'mes');

    IF v_aviso_linhas <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: periodo 100 pct fora da cobertura devolveu % linha(s); esperava '
                      'UMA linha de aviso (regressao da 123)', v_aviso_linhas;
    END IF;
    IF v_aviso_nulo <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: a linha de aviso veio com coluna de periodo preenchida — ela nao '
                      'representa mes nenhum';
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- P4b 🔴 NAO REGREDIR O ACHADO B1 DA 123 — o corpo foi reescrito, entao tem de ser re-provado.
  -- -------------------------------------------------------------------------
  -- Piso alto NAO pode produzir a linha de aviso: `agrupado` vazio por `p_min_contas` significa
  -- "nenhum grupo atingiu o piso", nao "nao ha dado confiavel". Foi o bloqueante do review da
  -- Onda 9, e uma reescrita do corpo e exatamente onde ele voltaria sem ninguem notar.
  --
  -- O piso sai de uma QUERY DE CONTROLE, nao do retorno da tool: a tool tem LIMIT e ordena por
  -- VALOR, entao com muitos fornecedores o grupo mais NUMEROSO pode ficar fora da janela e o piso
  -- sairia baixo demais (a armadilha da truncagem, dentro da propria sonda).
  SELECT COALESCE(max(t.n), 0)::integer INTO v_maior_grupo
    FROM (
      SELECT count(*) AS n
        FROM analytics.vw_payables v
       WHERE v.status_id = 8
         AND v.payment_date >= v_corte
         AND NOT EXISTS (
               SELECT 1 FROM public.audit_log a
                WHERE a.tabela = 'financial_account_control'
                  AND a.registro_id = v.payable_id
                  AND a.campos_alterados @> ARRAY['due_date']
                  AND a.criado_em::date >= v.payment_date)
       GROUP BY COALESCE(v.supplier_name, '(sem fornecedor)')
    ) t;

  IF v_maior_grupo = 0 THEN
    RAISE EXCEPTION 'ABORTADO: a query de controle nao achou grupo de fornecedor algum, embora o '
                    'eixo mes tenha devolvido % — as duas leem a mesma populacao', v_meses;
  END IF;

  v_piso := v_maior_grupo + 1;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE grupo = '(nenhuma conta com data de pagamento confiavel no periodo)')::integer
    INTO v_com_piso, v_aviso_piso
    FROM analytics.pontualidade_pagamento(
           p_group_by => 'fornecedor', p_min_contas => v_piso, p_limit => 200);

  IF v_aviso_piso <> 0 THEN
    RAISE EXCEPTION 'ABORTADO (B1): com p_min_contas = % a tool devolveu a LINHA DE AVISO — ela '
                    'afirma que nao ha dado confiavel onde ha. Piso nao atingido tem de devolver '
                    'vazio (regressao do bloqueante corrigido pela 123)', v_piso;
  END IF;
  IF v_com_piso <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: piso acima do maior grupo (%) devolveu % linha(s); esperava vazio',
      v_maior_grupo, v_com_piso;
  END IF;

  -- P5 dominio fechado: eixo invalido devolve VAZIO, nunca um agregado nem o aviso.
  SELECT count(*)::integer INTO v_dominio
    FROM analytics.pontualidade_pagamento(p_group_by => 'centro_de_custo_inexistente');
  IF v_dominio <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: eixo invalido devolveu % linha(s) — deveria devolver vazio', v_dominio;
  END IF;

  -- P6 privilegios: o DROP apagou, o GRANT/REVOKE acima tem de ter restaurado.
  IF NOT has_function_privilege('authenticated',
         'analytics.pontualidade_pagamento(date,date,text,bigint,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: authenticated perdeu o EXECUTE — o DROP apagou os grants e o GRANT '
                    'nao os reemitiu; o chat responderia 42501';
  END IF;
  SELECT has_function_privilege('anon',
           'analytics.pontualidade_pagamento(date,date,text,bigint,integer,integer)', 'EXECUTE')
    INTO v_anon;
  IF v_anon THEN
    RAISE EXCEPTION 'ABORTADO: anon pode executar a tool — o REVOKE nao pegou';
  END IF;

  -- -------------------------------------------------------------------------
  -- P7 🔴 COMPORTAMENTO SOB O PAPEL REAL. Privilegio concedido e consulta que RESPONDE sao
  -- perguntas diferentes (licao da 111). A funcao e SECURITY INVOKER e le vw_payables + audit_log.
  -- -------------------------------------------------------------------------
  SELECT id INTO v_usuario FROM auth.users ORDER BY created_at LIMIT 1;
  IF v_usuario IS NULL THEN
    RAISE NOTICE 'pontualidade: sem usuarios em auth.users — sonda P7 pulada';
  ELSE
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', v_usuario, 'role', 'authenticated')::text, true);
      v_uid := auth.uid();
      SELECT count(*)::integer INTO v_como_auth
        FROM analytics.pontualidade_pagamento(p_group_by => 'mes');
      v_p7_executou := true;
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- devolve o papel anterior; as variaveis plpgsql sobrevivem ao rollback
    END;

    IF NOT v_p7_executou THEN
      RAISE EXCEPTION 'ABORTADO: a sonda P7 nao chegou ao fim — permission denied em vw_payables '
                      'ou em audit_log sob o papel authenticated apareceria aqui';
    END IF;
    IF v_uid IS DISTINCT FROM v_usuario THEN
      RAISE EXCEPTION 'ABORTADO: auth.uid() = % sob claims de % — a sonda mediria o vazio',
        v_uid, v_usuario;
    END IF;
    RAISE NOTICE 'pontualidade: sob authenticated o eixo mes devolveu % grupo(s)', v_como_auth;
  END IF;

  RAISE NOTICE 'pontualidade 125 OK: % mes(es), % parcial(is) e % completo(s); corte %, hoje %; '
               'agregados identicos ao controle (% contas)',
               v_meses, v_parciais, v_completos, v_corte, v_hoje, v_tool_contas;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICACAO (apos aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
-- 1. group_by=mes sem filtro: o mes do corte vem com poucos dias cobertos de 31 e o mes corrente
--    com os dias ja decorridos, ambos com mes_parcial verdadeiro.
-- 2. A soma de `contas` dos meses continua igual a contagem de contas pagas com carimbo real —
--    esta migration acrescenta ressalva, nao altera numero.
-- 3. Nos eixos geral/faixa/fornecedor/empresa as tres colunas novas vem NULL.
-- 4. Pelo PostgREST com a anon key: 42501, e nao PGRST202 — prova que o cache de schema ja
--    enxerga a assinatura nova E que anon segue barrado.
-- 5. Ordem de implantacao: migration -> conferir o cache -> deploy da Next API (tools.ts).
