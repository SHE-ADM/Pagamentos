-- 123_pontualidade_aviso_min_contas.sql
--
-- CORRECAO DE DOIS ACHADOS DO CODE REVIEW DA ONDA 9
-- (docs/review/2026-08-13-Features-light-onda9.md — B1 bloqueante e R1 recomendado).
--
-- ---------------------------------------------------------------------------
-- 🔴 B1 — O AVISO MENTIA QUANDO `min_contas` ESVAZIAVA O AGRUPAMENTO
-- ---------------------------------------------------------------------------
-- A 121 introduziu, de proposito, uma linha de aviso para o periodo cujas contas pagas estao
-- TODAS fora da cobertura: devolver ZERO linhas faria o modelo responder "nao houve pagamento no
-- periodo", que e falso e inverte a conclusao. A ideia esta certa; a CONDICAO ficou larga demais.
--
-- O ramo do UNION ALL testava `NOT EXISTS (SELECT 1 FROM agrupado)`, e `agrupado` ja passou pelo
-- `HAVING count(*) >= p_min_contas`. Ou seja, "vazio" ali significa DUAS coisas distintas:
--
--     (a) nao ha populacao confiavel no periodo          <- e para isto que o aviso existe
--     (b) ha populacao, mas nenhum grupo atingiu o piso   <- e aqui o aviso vira MENTIRA
--
-- Medido no banco em 2026-08-13, com os parametros que a DESCRICAO DA TOOL recomenda ao modelo
-- ("use `min_contas` em group_by=fornecedor"):
--
--     7 dias  + min_contas=10  ->  118 contas confiaveis reais  ->  devolvia a linha de aviso
--     2 dias  + min_contas=5   ->   54 contas confiaveis reais  ->  devolvia a linha de aviso
--     30 dias + min_contas=25  ->  221 contas confiaveis reais  ->  devolvia a linha de aviso
--
-- Nenhuma das 8 sondas da 121 pegou, e o motivo e util registrar: TODAS elas exercitam
-- `p_min_contas` no default (1), valor em que o defeito e inalcancavel — com piso 1, populacao
-- confiavel nao-vazia sempre produz ao menos um grupo.
--
-- A CORRECAO E DE UMA LINHA: testar `confiaveis` (a populacao ANTES do agrupamento) em vez de
-- `agrupado`. `confiaveis` vazio implica `agrupado` vazio, entao o caso (a) — o unico que o aviso
-- deve cobrir — continua valendo exatamente como a sonda P5b da 121 provou. No caso (b) o retorno
-- passa a ser VAZIO, que ali e a resposta honesta ("nenhum grupo qualificou"), e nao uma afirmacao
-- falsa sobre a existencia de dado.
--
-- ---------------------------------------------------------------------------
-- 🔴 R1 — A SONDA P4b DA 122 NAO PROVAVA O QUE DIZIA PROVAR
-- ---------------------------------------------------------------------------
-- A 122 criou a trigger `trg_roadmap_snapshot_touch` para que o UPSERT do dia AVANCE
-- `measured_at` (o DEFAULT so vale no INSERT). A trigger funciona — o catalogo confirma que ela
-- esta instalada como BEFORE UPDATE. O que nao funciona e a PROVA: a sonda capturava `v_marco`
-- ANTES do 1o INSERT e comparava o valor final contra ele. Como o `measured_at` do 1o INSERT ja
-- vem de `clock_timestamp()`, ele ja e maior que `v_marco` — a assercao passa com ou sem trigger.
--
-- E o modo de falha classico da Regra 2 do CLAUDE.md: verde que faz parar de olhar. A sonda P5
-- deste arquivo compara o carimbo do 2o UPSERT contra O DO PRIMEIRO, que e a unica comparacao
-- capaz de distinguir "a trigger disparou" de "a trigger nao existe".
--
-- A 122 NAO e editada (migration aplicada e imutavel); a sonda corrigida vive aqui.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENTE. `CREATE OR REPLACE` — a assinatura e o `RETURNS TABLE` sao IDENTICOS aos da 121,
-- entao o PostgreSQL aceita a substituicao e OS GRANTS SOBREVIVEM (nao ha DROP; e o inverso da
-- armadilha da 116, onde o tipo de retorno mudou e o par DROP+CREATE apagou os privilegios).
-- Os GRANT/REVOKE sao reemitidos ao fim assim mesmo: sao idempotentes, custam nada, e deixam o
-- arquivo autossuficiente para quem o ler isolado.
--
-- Nenhuma sonda escreve na base: as duas que precisam gravar rodam em subtransacao desfeita.

-- ---------------------------------------------------------------------------
-- A TOOL — corpo identico ao da 121, exceto a condicao do ramo do aviso
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.pontualidade_pagamento(
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
    total_encontrado        integer
)
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
    WITH corte AS (
        SELECT analytics.payment_date_confiavel_desde() AS desde
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
    -- 🔴 A CONDICAO OLHA `confiaveis`, NAO `agrupado` (correcao do achado B1 — ver o cabecalho).
    -- `agrupado` ja passou pelo HAVING de `p_min_contas`, entao vazio ali tambem significa "ha
    -- populacao, mas nenhum grupo atingiu o piso" — e nesse caso o aviso afirmaria, com todas as
    -- letras, que nao existe dado confiavel no periodo em que existem 118 contas medidas.
    -- `confiaveis` vazio implica `agrupado` vazio, entao o caso legitimo continua coberto.
    --
    -- A linha de aviso so aparece quando ha conta paga no filtro E nenhuma delas e confiavel; um
    -- periodo genuinamente sem pagamento continua devolvendo vazio, que ali e a resposta correta.
    linhas AS (
        SELECT a.grupo, a.contas, a.valor_total, a.em_dia, a.atrasadas, a.antecipadas,
               a.pct_pontualidade, a.atraso_medio_dias, a.atraso_mediano_dias,
               a.atraso_maximo_dias, a.desvio_medio_dias
          FROM agrupado a
         UNION ALL
        SELECT '(nenhuma conta com data de pagamento confiavel no periodo)',
               0, 0::numeric(15,2), 0, 0, 0,
               NULL::numeric(5,2), NULL::numeric(6,2), NULL::numeric(6,2),
               NULL::integer, NULL::numeric(6,2)
         WHERE NOT EXISTS (SELECT 1 FROM confiaveis)
           AND EXISTS (SELECT 1 FROM pagas)
           -- 🔴 Eixo INVALIDO continua devolvendo vazio. Sem esta linha, a propria correcao acima
           -- quebrava o dominio fechado: `agrupado` fica vazio por eixo invalido, `pagas` nao
           -- esta vazio, e o aviso apareceria — trocando "parametro errado" por uma resposta de
           -- aparencia legitima. Foi a sonda P3 que pegou, no ensaio, antes de aplicar.
           AND (SELECT e.valido FROM eixo e)
    )
    SELECT
        a.grupo, a.contas, a.valor_total, a.em_dia, a.atrasadas, a.antecipadas,
        a.pct_pontualidade, a.atraso_medio_dias, a.atraso_mediano_dias,
        a.atraso_maximo_dias, a.desvio_medio_dias,
        c.desde, c.fora, c.excluidas,
        -- Contagem REAL antes do LIMIT — 5a ocorrencia da armadilha da truncagem silenciosa
        -- (gasto_por_fornecedor, documentos_fiscais, fornecedores_recorrentes, auditoria_*).
        -- JANELA, nunca subconsulta repetindo o corpo: a subconsulta herdaria o LIMIT e devolveria
        -- o total TRUNCADO — o mesmo defeito com cara de correcao.
        (count(*) OVER ())::integer
      FROM linhas a, cobertura c
     -- Faixa tem ordem PROPRIA (do melhor para o pior); os demais eixos ordenam por dinheiro.
     -- O `grupo` fecha a ordem TOTAL: sem ele, empate + LIMIT devolve conjuntos diferentes entre
     -- execucoes, e o ranking "muda sozinho" (licao de stableOrder/applyOrder, valendo no banco).
     ORDER BY
        CASE WHEN p_group_by = 'faixa' THEN
            CASE a.grupo
                WHEN 'antecipado'      THEN 1
                WHEN 'em dia'          THEN 2
                WHEN 'atraso 1-7 dias' THEN 3
                WHEN 'atraso 8-30 dias' THEN 4
                ELSE 5
            END
        END NULLS FIRST,
        a.valor_total DESC,
        a.grupo ASC
     -- Clamp: p_limit vem de parametro de tool (LLM), e LIMIT negativo levanta 2201W em runtime.
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

COMMENT ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) IS
  'Pontualidade de pagamento (Onda 9; corrigida pela 123): quanto se paga em dia, com que atraso e '
  'onde. NAO e DPO — DPO exige CMV e o passivo contabil da empresa; aqui a base e o que chegou por '
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
  'Piso nao atingido devolve VAZIO, que significa "nenhum grupo qualificou", nao "nao ha dado".';

-- ---------------------------------------------------------------------------
-- GRANTS — reemitidos por baixo custo (o CREATE OR REPLACE acima ja os preserva)
-- ---------------------------------------------------------------------------
GRANT  EXECUTE ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICACAO — a migration ABORTA se qualquer invariante nao valer
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_confiaveis   integer;
  v_maior_grupo  integer;
  v_grupos       integer;
  v_piso         integer;
  v_com_piso     integer;
  v_aviso_piso   integer;
  v_pre_corte    integer;
  v_aviso_linhas integer;
  v_aviso_contas integer;
  v_aviso_fora   integer;
  v_dominio      integer;
  v_tool_contas  integer;
  v_tool_atraso  integer;
  v_ctrl_contas  integer;
  v_ctrl_atraso  integer;
  v_ts1          timestamptz;
  v_ts2          timestamptz;
  v_usuario      uuid;
  v_uid          uuid;
  v_como_auth    integer := -1;
  v_p6_executou  boolean := false;
  v_corte        date := analytics.payment_date_confiavel_desde();
BEGIN
  -- P0 ANTI-VACUIDADE: sem populacao confiavel, TODA sonda abaixo passaria medindo o vazio — que
  -- e exatamente o estado em que este item ficou adiado por meses.
  SELECT count(*)::integer INTO v_confiaveis
    FROM public.financial_account_control
   WHERE status_id = 8 AND payment_date >= v_corte;

  IF v_confiaveis = 0 THEN
    RAISE EXCEPTION 'ABORTADO: nenhuma conta paga com carimbo real (>= %) — a tool responderia '
                    'sempre vazio e as sondas nao provariam nada', v_corte;
  END IF;

  -- -------------------------------------------------------------------------
  -- P1 🔴 O ACHADO B1: piso alto NAO pode produzir a linha de aviso.
  -- -------------------------------------------------------------------------
  -- O piso e DERIVADO do dado (maior grupo + 1), nunca um numero fixo: com um literal, a sonda
  -- deixaria de exercitar o defeito assim que o acervo crescesse — e ficaria verde por inercia.
  --
  -- 🔴 O maior grupo sai de uma QUERY DE CONTROLE, nao do retorno da tool. A tool tem `LIMIT`
  -- (teto 200) e ordena por VALOR, entao com mais de 200 fornecedores o grupo mais NUMEROSO pode
  -- estar fora da janela devolvida — o piso sairia baixo demais, algum grupo sobreviveria, e a
  -- sonda ou passaria vazia (vacuidade) ou abortaria sem defeito algum. E a 6a aparicao da
  -- armadilha da truncagem silenciosa neste projeto; nao repeti-la dentro da propria sonda.
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

  SELECT count(*)::integer INTO v_grupos
    FROM analytics.pontualidade_pagamento(p_group_by => 'fornecedor', p_limit => 200);

  IF v_grupos = 0 THEN
    RAISE EXCEPTION 'ABORTADO: o eixo fornecedor nao devolveu grupo algum havendo % conta(s) '
                    'confiavel(is) — a sonda P1 nao teria o que exercitar', v_confiaveis;
  END IF;

  -- ANTI-VACUIDADE DA PROPRIA SONDA: com maior_grupo = 0 o piso viraria 1 (o default), e a P1
  -- passaria sem nunca exercitar o caminho parametrizado — que e exatamente como o defeito B1
  -- atravessou as 8 sondas da 121.
  IF v_maior_grupo = 0 THEN
    RAISE EXCEPTION 'ABORTADO: a query de controle nao achou grupo algum enquanto a tool devolveu '
                    '% — as duas leem a mesma populacao; divergir aqui invalida a sonda', v_grupos;
  END IF;

  v_piso := v_maior_grupo + 1;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE grupo = '(nenhuma conta com data de pagamento confiavel no periodo)')::integer
    INTO v_com_piso, v_aviso_piso
    FROM analytics.pontualidade_pagamento(
           p_group_by => 'fornecedor', p_min_contas => v_piso, p_limit => 200);

  IF v_aviso_piso <> 0 THEN
    RAISE EXCEPTION 'ABORTADO (B1): com p_min_contas = % e % conta(s) confiavel(is) no periodo, a '
                    'tool devolveu a LINHA DE AVISO — ela afirma que nao ha dado confiavel onde '
                    'ha. Piso nao atingido tem de devolver vazio', v_piso, v_confiaveis;
  END IF;
  IF v_com_piso <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: piso acima do maior grupo (%) devolveu % linha(s); esperava vazio',
      v_maior_grupo, v_com_piso;
  END IF;

  -- -------------------------------------------------------------------------
  -- P2 NAO REGREDIR A P5b DA 121: periodo 100 pct fora da cobertura segue com o aviso.
  -- -------------------------------------------------------------------------
  -- E a metade do invariante que a correcao NAO pode ter quebrado. O periodo e derivado do dado
  -- (tudo ate a vespera do corte), nunca um mes fixo que pode esvaziar amanha.
  SELECT count(*)::integer INTO v_pre_corte
    FROM public.financial_account_control
   WHERE status_id = 8 AND payment_date < v_corte;

  IF v_pre_corte = 0 THEN
    RAISE NOTICE 'pontualidade: nao ha conta paga anterior ao corte — sonda P2 pulada';
  ELSE
    SELECT count(*)::integer, max(contas), max(fora_da_cobertura)
      INTO v_aviso_linhas, v_aviso_contas, v_aviso_fora
      FROM analytics.pontualidade_pagamento(
             p_date_to => v_corte - 1, p_group_by => 'geral');

    IF v_aviso_linhas <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: periodo 100 pct fora da cobertura devolveu % linha(s); esperava '
                      'UMA linha de aviso. Vazio faria o modelo dizer que nao houve pagamento',
                      v_aviso_linhas;
    END IF;
    IF v_aviso_contas <> 0 OR v_aviso_fora <> v_pre_corte THEN
      RAISE EXCEPTION 'ABORTADO: a linha de aviso veio com % conta(s) medida(s) e % fora; '
                      'esperava 0 medidas e % fora', v_aviso_contas, v_aviso_fora, v_pre_corte;
    END IF;

    -- E o aviso tem de sobreviver ao piso alto: ali NAO ha populacao confiavel, entao a razao do
    -- vazio e a cobertura, nao o `min_contas` — os dois motivos coexistem e o certo prevalece.
    SELECT count(*)::integer INTO v_aviso_linhas
      FROM analytics.pontualidade_pagamento(
             p_date_to => v_corte - 1, p_group_by => 'fornecedor', p_min_contas => 999);
    IF v_aviso_linhas <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: periodo sem cobertura + piso alto devolveu % linha(s); o aviso '
                      'tem de valer, porque ali o vazio E por falta de cobertura', v_aviso_linhas;
    END IF;
  END IF;

  -- P3: dominio fechado. Eixo invalido devolve VAZIO, nunca um agregado nem o aviso.
  SELECT count(*)::integer INTO v_dominio
    FROM analytics.pontualidade_pagamento(p_group_by => 'centro_de_custo_inexistente');
  IF v_dominio <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: eixo invalido devolveu % linha(s) — deveria devolver vazio', v_dominio;
  END IF;

  -- P4 🔴 ORACULO DIFERENCIAL: a tool e uma query de controle equivalente tem de concordar.
  -- Nunca numero absoluto — o dado deriva em 24 h (o reader roda a cada 5 min).
  SELECT contas, COALESCE(atrasadas, 0) INTO v_tool_contas, v_tool_atraso
    FROM analytics.pontualidade_pagamento(p_group_by => 'geral');

  SELECT count(*)::integer,
         count(*) FILTER (WHERE days_late > 0)::integer
    INTO v_ctrl_contas, v_ctrl_atraso
    FROM public.financial_account_control f
   WHERE f.status_id = 8
     AND f.payment_date >= v_corte
     AND NOT EXISTS (
           SELECT 1 FROM public.audit_log a
            WHERE a.tabela = 'financial_account_control'
              AND a.registro_id = f.id
              AND a.campos_alterados @> ARRAY['due_date']
              AND a.criado_em::date >= f.payment_date);

  IF v_tool_contas <> v_ctrl_contas OR v_tool_atraso <> v_ctrl_atraso THEN
    RAISE EXCEPTION 'ABORTADO: oraculo divergiu — tool (% contas, % atrasadas) x controle '
                    '(% contas, % atrasadas)', v_tool_contas, v_tool_atraso,
                    v_ctrl_contas, v_ctrl_atraso;
  END IF;

  -- -------------------------------------------------------------------------
  -- P5 🔴 O ACHADO R1: a trigger de touch da 122, provada de verdade.
  -- -------------------------------------------------------------------------
  -- A comparacao e o 2o carimbo CONTRA O PRIMEIRO. Comparar contra um marco anterior aos dois
  -- (como a P4b da 122 fazia) passa com ou sem trigger, porque o carimbo do 1o INSERT ja vem de
  -- clock_timestamp(). Subtransacao desfeita: nada persiste.
  BEGIN
    INSERT INTO analytics.roadmap_trigger_snapshot (trigger_key, measured_on, fired, metrics, criterion)
    VALUES ('nfse', DATE '1999-01-02', false, '{"n":1}'::jsonb, 'sonda P5 da migration 123')
    ON CONFLICT (trigger_key, measured_on) DO UPDATE
       SET fired = EXCLUDED.fired, metrics = EXCLUDED.metrics;

    SELECT measured_at INTO v_ts1
      FROM analytics.roadmap_trigger_snapshot
     WHERE trigger_key = 'nfse' AND measured_on = DATE '1999-01-02';

    INSERT INTO analytics.roadmap_trigger_snapshot (trigger_key, measured_on, fired, metrics, criterion)
    VALUES ('nfse', DATE '1999-01-02', true, '{"n":2}'::jsonb, 'sonda P5 da migration 123')
    ON CONFLICT (trigger_key, measured_on) DO UPDATE
       SET fired = EXCLUDED.fired, metrics = EXCLUDED.metrics;

    SELECT measured_at INTO v_ts2
      FROM analytics.roadmap_trigger_snapshot
     WHERE trigger_key = 'nfse' AND measured_on = DATE '1999-01-02';

    RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;   -- desfaz a linha; as variaveis plpgsql sobrevivem ao rollback
  END;

  IF v_ts1 IS NULL OR v_ts2 IS NULL THEN
    RAISE EXCEPTION 'ABORTADO: a sonda P5 nao chegou a ler os carimbos (ts1=%, ts2=%) — sem eles '
                    'a assercao abaixo ficaria sem avaliar', v_ts1, v_ts2;
  END IF;
  IF v_ts2 <= v_ts1 THEN
    RAISE EXCEPTION 'ABORTADO (R1): measured_at nao avancou entre o 1o e o 2o UPSERT do mesmo dia '
                    '(% -> %) — a trigger trg_roadmap_snapshot_touch nao esta pegando, e a coluna '
                    'informaria o horario da PRIMEIRA medicao', v_ts1, v_ts2;
  END IF;

  -- -------------------------------------------------------------------------
  -- P6 🔴 COMPORTAMENTO SOB O PAPEL REAL — refeito, porque a FUNCAO mudou.
  -- -------------------------------------------------------------------------
  -- A 121 provou isto para o corpo dela; este arquivo substitui o corpo, entao a prova precisa
  -- valer para o corpo NOVO. Privilegio concedido e consulta que RESPONDE sao perguntas
  -- diferentes (licao da 111: GRANT sem policy devolve zero linhas, em silencio). A funcao e
  -- SECURITY INVOKER e le vw_payables + audit_log: se faltar SELECT em qualquer uma, so o papel
  -- `authenticated` revela.
  SELECT id INTO v_usuario FROM auth.users ORDER BY created_at LIMIT 1;
  IF v_usuario IS NULL THEN
    RAISE NOTICE 'pontualidade: sem usuarios em auth.users — sonda P6 pulada';
  ELSE
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', v_usuario, 'role', 'authenticated')::text, true);
      v_uid := auth.uid();
      SELECT count(*)::integer INTO v_como_auth
        FROM analytics.pontualidade_pagamento(p_group_by => 'faixa');
      v_p6_executou := true;
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- devolve o papel anterior; as variaveis plpgsql sobrevivem ao rollback
    END;

    IF NOT v_p6_executou THEN
      RAISE EXCEPTION 'ABORTADO: a sonda P6 nao chegou ao fim — excecao sob o papel authenticated '
                      'deixaria a assercao sem avaliar (permission denied em vw_payables ou em '
                      'audit_log apareceria aqui)';
    END IF;
    IF v_uid IS DISTINCT FROM v_usuario THEN
      RAISE EXCEPTION 'ABORTADO: auth.uid() = % sob claims de % — a sonda mediria o vazio',
        v_uid, v_usuario;
    END IF;
    -- Nao se exige linha > 0: o primeiro usuario pode ser de um grupo restrito e legitimamente
    -- nao ver nenhuma conta paga. O que se exige e que a chamada NAO levante.
    RAISE NOTICE 'pontualidade: sob authenticated a tool respondeu % balde(s)', v_como_auth;
  END IF;

  RAISE NOTICE 'pontualidade 123 OK: % conta(s) confiavel(is); maior grupo %, piso da sonda %; '
               'aviso sai so por cobertura; touch da 122 provado (% -> %)',
               v_confiaveis, v_maior_grupo, v_piso, v_ts1, v_ts2;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICACAO (apos aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
-- 1. Chamar a tool com um recorte estreito e piso alto (por exemplo, ultimos 7 dias, eixo
--    fornecedor, min_contas 10) e conferir que o retorno e VAZIO — nunca a linha de aviso.
-- 2. Chamar com p_date_to igual a vespera de analytics.payment_date_confiavel_desde() e conferir
--    que continua saindo UMA linha de aviso, com contas zero e fora_da_cobertura maior que zero.
-- 3. Nada muda no cache de schema do PostgREST: a assinatura e o tipo de retorno sao os mesmos da
--    121, entao a tool ja exposta continua respondendo sem nenhum passo extra.
