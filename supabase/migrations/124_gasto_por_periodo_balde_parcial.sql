-- 124_gasto_por_periodo_balde_parcial.sql
--
-- `analytics.gasto_por_periodo` passa a DECLARAR quais baldes da serie estao incompletos.
--
-- ---------------------------------------------------------------------------
-- 🔴 O PROBLEMA: O NUMERO ESTA CERTO E A CONCLUSAO SAI INVERTIDA
-- ---------------------------------------------------------------------------
-- A tool agrupa por dia/semana/mes/trimestre e devolve o total de cada balde — sem dizer que os
-- baldes das BORDAS quase sempre cobrem menos dias que os do meio. Sao duas truncagens diferentes:
--
--   (a) o PRIMEIRO balde e cortado por `p_date_from` — a semana comeca antes do filtro;
--   (b) o ULTIMO balde e cortado pelo PRESENTE — dias que ainda nao aconteceram.
--
-- Medido em 2026-08-13, serie semanal por emissao de 01/07 a 31/08:
--
--     29/06 ->  50 contas   (5 de 7 dias — cortado pelo filtro)
--     06/07 ->  54 contas   (7 de 7)
--     13/07 ->  84 contas   (7 de 7)
--     20/07 ->  83 contas   (7 de 7)
--     27/07 -> 110 contas   (7 de 7)
--     03/08 ->  84 contas   (7 de 7)
--     10/08 ->  42 contas   (4 de 7 dias — cortado pelo presente)
--
-- Lida sem ressalva, a ultima semana "caiu 50 pct" contra a anterior. Nao caiu: faltam 3 dias. E a
-- mesma classe de erro de comparar um mes inteiro com 13 dias do seguinte, e a mesma que
-- `fora_da_cobertura` resolveu na Onda 9 (migration 121) — o dado nao mente, a AUSENCIA DA
-- RESSALVA e que faz o leitor concluir o oposto. Num comparativo semanal isso morde toda semana.
--
-- ---------------------------------------------------------------------------
-- 🔴 O TETO DO PRESENTE SO VALE PARA `pagamento` E `emissao`
-- ---------------------------------------------------------------------------
-- Para `vencimento`, dia futuro e dado LEGITIMO — sao as contas a vencer, que ja existem na base.
-- Marcar como parcial o balde de vencimentos futuros inverteria o sentido da coluna: diria "faltam
-- dias" onde o dado esta completo. So os dois campos retrospectivos sao limitados por hoje.
--
-- ---------------------------------------------------------------------------
-- 🔴 O "HOJE" E `America/Sao_Paulo`, NUNCA `CURRENT_DATE`
-- ---------------------------------------------------------------------------
-- Medido: a sessao deste banco roda em **UTC** (`current_setting('TimeZone') = 'UTC'`). Das 21h a
-- meia-noite em Sao Paulo o UTC ja e o dia seguinte, e o balde da semana corrente passaria a ser
-- considerado COMPLETO — errando exatamente na janela em que alguem confere o fechamento do dia, e
-- de um jeito que some quando se vai conferir de manha. E a mesma armadilha do `todayISO` do
-- frontend e o motivo de as migrations 095 e 122 fixarem o fuso explicitamente.
--
-- ---------------------------------------------------------------------------
-- ROBUSTEZ: O DOMINIO DOS DOIS PARAMETROS DE DESPACHO ESTAVA ABERTO
-- ---------------------------------------------------------------------------
-- O corpo da 098 usava `ELSE 'month'` e `ELSE v.due_date`: granularidade invalida virava MES e
-- campo de data invalido virava VENCIMENTO, em silencio. Isso contradiz o invariante ja registrado
-- da camada — "valor fora do dominio devolve VAZIO em vez de agregar errado em silencio" —, que as
-- tools das ondas 6 a 9 cumprem. O Zod de `tools.ts` ja barra antes, entao nao ha caminho
-- exploravel pelo app; a mudanca e defesa em profundidade e alinha o codigo a regua.
--
-- ---------------------------------------------------------------------------
-- 🔴 DROP + CREATE, E OS GRANTS SAO PARTE OBRIGATORIA DO ARQUIVO
-- ---------------------------------------------------------------------------
-- Acrescentar coluna ao `RETURNS TABLE` muda o TIPO DE RETORNO: o PostgreSQL recusa
-- `CREATE OR REPLACE` com 42P13, entao o par DROP+CREATE e inevitavel — e o DROP APAGA OS GRANTS.
-- Recriar sem reemitir deixaria a funcao executavel por `PUBLIC` (default do PostgreSQL) e
-- inexecutavel por `authenticated`: aberta para quem nao deve, quebrada para quem deve. E a licao
-- da 116, exercitada de novo na 118. ACL medida antes desta migration:
-- `{postgres=X/postgres, authenticated=X/postgres}` — e exatamente ela que a secao de GRANT
-- ao fim restaura.
--
-- IDEMPOTENTE: `DROP FUNCTION IF EXISTS` + `CREATE`; o DO final so le e sonda.

DROP FUNCTION IF EXISTS analytics.gasto_por_periodo(date, date, text, text, text[], bigint);

CREATE FUNCTION analytics.gasto_por_periodo(
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
    total_amount  numeric,
    -- ---------- colunas ACRESCENTADAS pela 124 (sempre no FIM, como a 103 fez na vw_payables) ----
    bucket_end    date,      -- ultimo dia NATURAL do balde (o `bucket` ja e o primeiro)
    days_covered  integer,   -- dias do balde efetivamente cobertos pela consulta
    days_total    integer,   -- dias que o balde teria se completo (7 na semana, 28-31 no mes...)
    is_partial    boolean    -- days_covered < days_total
)
LANGUAGE sql
STABLE
SECURITY INVOKER
PARALLEL SAFE
SET search_path = ''
AS $$
    WITH dominio AS (
        -- 🔴 Dominio FECHADO nos dois eixos de despacho. Fora dele a serie sai VAZIA, nunca
        -- agregada por um default que ninguem pediu (era `ELSE 'month'` / `ELSE due_date`).
        SELECT p_granularity IN ('dia', 'semana', 'mes', 'trimestre') AS gran_ok,
               p_date_field  IN ('vencimento', 'pagamento', 'emissao') AS campo_ok,
               CASE p_granularity
                   WHEN 'dia'       THEN 'day'
                   WHEN 'semana'    THEN 'week'
                   WHEN 'trimestre' THEN 'quarter'
                   ELSE                  'month'
               END AS unidade,
               CASE p_granularity
                   WHEN 'dia'       THEN interval '1 day'
                   WHEN 'semana'    THEN interval '1 week'
                   WHEN 'trimestre' THEN interval '3 months'
                   ELSE                  interval '1 month'
               END AS passo,
               -- Teto do presente SO para os campos retrospectivos. Em `vencimento`, dia futuro e
               -- conta a vencer — dado real, balde completo.
               CASE WHEN p_date_field IN ('pagamento', 'emissao')
                    THEN (now() AT TIME ZONE 'America/Sao_Paulo')::date
                    ELSE 'infinity'::date
               END AS teto_presente
    ),
    -- Aliases CURTOS de proposito: `bucket`/`account_count`/`total_amount` sao os nomes das
    -- colunas do RETURNS TABLE e ficam em escopo no corpo da funcao — reusa-los aqui convidaria
    -- ambiguidade de resolucao de nome numa funcao SQL.
    agregado AS (
        SELECT
            date_trunc(d.unidade,
                (CASE p_date_field
                     WHEN 'pagamento' THEN v.payment_date
                     WHEN 'emissao'   THEN v.issue_date
                     ELSE                  v.due_date
                 END)::timestamp
            )::date                                   AS b,
            count(*)                                  AS n,
            COALESCE(sum(v.amount), 0)::numeric(15,2) AS total
        FROM analytics.vw_payables v, dominio d
        WHERE d.gran_ok AND d.campo_ok
          AND (CASE p_date_field
                   WHEN 'pagamento' THEN v.payment_date
                   WHEN 'emissao'   THEN v.issue_date
                   ELSE                  v.due_date
               END) BETWEEN p_date_from AND p_date_to
          -- sem p_status explicito, cancelado fica fora
          AND (p_status IS NOT NULL OR NOT v.is_cancelled)
          AND (p_status IS NULL     OR v.status_name = ANY(p_status))
          AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
        GROUP BY 1
    )
    SELECT
        c.b,
        c.n,
        c.total,
        c.fim,
        c.cobertos::integer,
        c.totais::integer,
        (c.cobertos < c.totais)
    FROM (
        SELECT
            a.b, a.n, a.total,
            ((a.b + d.passo)::date - 1)              AS fim,
            -- Dias cobertos = da MAIOR das duas aberturas (inicio do balde x inicio do filtro) ate
            -- a MENOR dos tres fechamentos (fim do balde x fim do filtro x hoje). O `+ 1` porque o
            -- intervalo e fechado nas duas pontas: 10/08 a 13/08 sao 4 dias, nao 3.
            (LEAST((a.b + d.passo)::date - 1, p_date_to, d.teto_presente)
             - GREATEST(a.b, p_date_from) + 1)       AS cobertos,
            ((a.b + d.passo)::date - a.b)            AS totais
        FROM agregado a, dominio d
    ) c
    ORDER BY c.b;
$$;

COMMENT ON FUNCTION analytics.gasto_por_periodo(date, date, text, text, text[], bigint) IS
  'Total agregado por periodo (serie temporal). p_date_field: vencimento|pagamento|emissao; '
  'p_granularity: dia|semana|mes|trimestre. Valor fora desses dominios devolve VAZIO, nunca um '
  'default silencioso. '
  '🔴 CADA BALDE DECLARA SE ESTA INCOMPLETO: `is_partial`, com `days_covered` de `days_total` '
  'dias. O primeiro balde costuma ser cortado por p_date_from e o ultimo pelo PRESENTE — comparar '
  'um balde parcial com um completo e o erro que estas colunas existem para impedir (uma semana '
  'de 4 dias parece "queda de 50 pct" ao lado de uma de 7). O teto do presente so se aplica a '
  'pagamento e emissao: em vencimento, dia futuro e conta a vencer, e o balde esta completo.';

-- ---------------------------------------------------------------------------
-- GRANTS — o DROP acima os apagou; sem esta secao a funcao fica aberta a PUBLIC
-- ---------------------------------------------------------------------------
GRANT  EXECUTE ON FUNCTION analytics.gasto_por_periodo(date, date, text, text, text[], bigint) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.gasto_por_periodo(date, date, text, text, text[], bigint) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICACAO — a migration ABORTA se qualquer invariante nao valer
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_hoje         date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_de           date;
  v_ate          date;
  v_baldes       integer;
  v_parciais     integer;
  v_completos    integer;
  v_ctrl_baldes  integer;
  v_divergencias integer;
  v_ultimo       record;
  v_futuro       integer;
  v_vazio        integer;
  v_anon         boolean;
  v_auth         boolean;
  v_como_auth    integer := -1;
  v_p7_executou  boolean := false;
  v_usuario      uuid;
  v_uid          uuid;
BEGIN
  -- A janela da sonda e DERIVADA do dado: 6 semanas ate hoje. Datas fixas envelheceriam e a
  -- migration passaria a abortar por falta de dado no periodo, nao por defeito.
  v_ate := v_hoje;
  v_de  := date_trunc('week', (v_hoje - 35)::timestamp)::date + 2;   -- comeca numa QUARTA, para
                                                                     -- o 1o balde nascer truncado

  -- P0 ANTI-VACUIDADE: sem contas emitidas na janela, TODA sonda abaixo mediria o vazio.
  SELECT count(*)::integer INTO v_baldes
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'semana');
  IF v_baldes < 3 THEN
    RAISE EXCEPTION 'ABORTADO: a janela % a % produziu % balde(s) — a sonda precisa de pelo menos '
                    '3 (duas bordas e um meio) para provar alguma coisa', v_de, v_ate, v_baldes;
  END IF;

  -- -------------------------------------------------------------------------
  -- P1 🔴 ORACULO DIFERENCIAL: os agregados NAO PODEM ter mudado.
  -- -------------------------------------------------------------------------
  -- Esta migration existe para ACRESCENTAR ressalva, nao para mexer em numero. A query de controle
  -- reproduz o corpo da 098 (date_trunc + filtro + group by) e tem de bater balde a balde.
  SELECT count(*)::integer INTO v_ctrl_baldes
    FROM (
      SELECT date_trunc('week', v.issue_date::timestamp)::date AS b
        FROM analytics.vw_payables v
       WHERE v.issue_date BETWEEN v_de AND v_ate AND NOT v.is_cancelled
       GROUP BY 1
    ) t;

  SELECT count(*)::integer INTO v_divergencias
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'semana') f
    FULL JOIN (
      SELECT date_trunc('week', v.issue_date::timestamp)::date AS b,
             count(*)                                  AS n,
             COALESCE(sum(v.amount), 0)::numeric(15,2) AS total
        FROM analytics.vw_payables v
       WHERE v.issue_date BETWEEN v_de AND v_ate AND NOT v.is_cancelled
       GROUP BY 1
    ) c ON c.b = f.bucket
   WHERE f.bucket IS NULL OR c.b IS NULL
      OR f.account_count <> c.n OR f.total_amount <> c.total;

  IF v_baldes <> v_ctrl_baldes OR v_divergencias > 0 THEN
    RAISE EXCEPTION 'ABORTADO: a reescrita mexeu no agregado — % balde(s) na tool x % no controle, '
                    'com % divergencia(s) de contagem/valor', v_baldes, v_ctrl_baldes, v_divergencias;
  END IF;

  -- -------------------------------------------------------------------------
  -- P2 🔴 ORACULO ARITMETICO SOBRE **TODOS** OS BALDES.
  -- -------------------------------------------------------------------------
  -- Assertar "o PRIMEIRO balde e parcial" seria fragil: se a semana da borda nao tiver nenhuma
  -- conta, o primeiro balde devolvido e uma semana inteira e a sonda acusaria um defeito que nao
  -- existe. O que vale para TODO balde, sempre, e a formula — e e ela que se verifica aqui,
  -- recalculada de forma independente do corpo da funcao.
  SELECT count(*)::integer INTO v_divergencias
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'semana') f
   WHERE f.days_total <> 7                                    -- semana e sempre 7 dias
      OR f.bucket_end <> f.bucket + 6
      OR f.days_covered <> (LEAST(f.bucket_end, v_ate, v_hoje) - GREATEST(f.bucket, v_de) + 1)
      OR f.is_partial <> (f.days_covered < f.days_total);
  IF v_divergencias > 0 THEN
    RAISE EXCEPTION 'ABORTADO: % balde(s) com days_covered/is_partial fora da aritmetica do '
                    'intervalo — a coluna estaria informando dia que o balde nao cobre', v_divergencias;
  END IF;

  -- P2b ANTI-VACUIDADE DA COLUNA: uma flag que nunca e verdadeira (ou que e sempre) nao
  -- discrimina nada — e passaria neste teste tao bem quanto a implementacao correta.
  SELECT count(*) FILTER (WHERE is_partial)::integer,
         count(*) FILTER (WHERE NOT is_partial)::integer
    INTO v_parciais, v_completos
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'semana');
  IF v_parciais = 0 OR v_completos = 0 THEN
    RAISE EXCEPTION 'ABORTADO: a janela devolveu % parcial(is) e % completo(s) — a sonda precisa '
                    'dos DOIS para provar que is_partial discrimina', v_parciais, v_completos;
  END IF;

  -- P2c O balde da SEMANA CORRENTE e o que mais engana (parece queda) e tem de estar marcado.
  SELECT * INTO v_ultimo
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'semana') ORDER BY bucket DESC LIMIT 1;
  IF v_ultimo.bucket_end > v_hoje AND NOT v_ultimo.is_partial THEN
    RAISE EXCEPTION 'ABORTADO: o balde da semana corrente (% a %) termina depois de hoje (%) e nao '
                    'foi marcado parcial', v_ultimo.bucket, v_ultimo.bucket_end, v_hoje;
  END IF;

  -- -------------------------------------------------------------------------
  -- P3 🔴 `vencimento` NAO e limitado pelo presente: conta a vencer e dado real.
  -- -------------------------------------------------------------------------
  -- So contam os baldes INTEIRAMENTE dentro do filtro: os das bordas sao parciais por causa do
  -- filtro, legitimamente, e confundi-los com o efeito do presente inverteria o que se prova.
  SELECT count(*) FILTER (WHERE is_partial)::integer, count(*)::integer
    INTO v_futuro, v_vazio
    FROM analytics.gasto_por_periodo(v_hoje + 7, v_hoje + 90, 'vencimento', 'semana')
   WHERE bucket >= v_hoje + 7 AND bucket_end <= v_hoje + 90;

  IF v_vazio = 0 THEN
    -- Sem conta a vencer no trimestre a sonda seria vacua — e o silencio pareceria aprovacao.
    RAISE NOTICE 'gasto_por_periodo: nenhum balde de vencimento futuro inteiro na janela — P3 pulada';
  ELSIF v_futuro > 0 THEN
    RAISE EXCEPTION 'ABORTADO: % de % balde(s) de VENCIMENTO futuro marcado(s) como parcial(is) — '
                    'em vencimento o dia futuro e conta a vencer, e o balde esta completo',
                    v_futuro, v_vazio;
  END IF;

  -- -------------------------------------------------------------------------
  -- P4/P5 dominio fechado: fora dele a serie sai VAZIA, nunca por um default silencioso.
  -- -------------------------------------------------------------------------
  SELECT count(*)::integer INTO v_vazio
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'quinzena');
  IF v_vazio <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: granularidade invalida devolveu % linha(s) — antes virava MES em '
                    'silencio, e e isso que esta migration fecha', v_vazio;
  END IF;

  SELECT count(*)::integer INTO v_vazio
    FROM analytics.gasto_por_periodo(v_de, v_ate, 'competencia', 'semana');
  IF v_vazio <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: campo de data invalido devolveu % linha(s) — antes virava '
                    'VENCIMENTO em silencio', v_vazio;
  END IF;

  -- P6 privilegios: o DROP apagou, o GRANT/REVOKE acima tem de ter restaurado.
  v_auth := has_function_privilege('authenticated',
              'analytics.gasto_por_periodo(date,date,text,text,text[],bigint)', 'EXECUTE');
  v_anon := has_function_privilege('anon',
              'analytics.gasto_por_periodo(date,date,text,text,text[],bigint)', 'EXECUTE');
  IF NOT v_auth THEN
    RAISE EXCEPTION 'ABORTADO: authenticated perdeu o EXECUTE — o DROP apagou os grants e o GRANT '
                    'nao os reemitiu; o chat responderia 42501 em toda pergunta de serie';
  END IF;
  IF v_anon THEN
    RAISE EXCEPTION 'ABORTADO: anon pode executar a tool — o REVOKE nao pegou (o PostgreSQL concede '
                    'EXECUTE a PUBLIC por default em funcao nova)';
  END IF;

  -- -------------------------------------------------------------------------
  -- P7 🔴 COMPORTAMENTO SOB O PAPEL REAL. Privilegio concedido e consulta que RESPONDE sao
  -- perguntas diferentes (licao da 111). A funcao e SECURITY INVOKER e le vw_payables.
  -- -------------------------------------------------------------------------
  SELECT id INTO v_usuario FROM auth.users ORDER BY created_at LIMIT 1;
  IF v_usuario IS NULL THEN
    RAISE NOTICE 'gasto_por_periodo: sem usuarios em auth.users — sonda P7 pulada';
  ELSE
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', v_usuario, 'role', 'authenticated')::text, true);
      v_uid := auth.uid();
      SELECT count(*)::integer INTO v_como_auth
        FROM analytics.gasto_por_periodo(v_de, v_ate, 'emissao', 'semana');
      v_p7_executou := true;
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- devolve o papel anterior; as variaveis plpgsql sobrevivem ao rollback
    END;

    IF NOT v_p7_executou THEN
      RAISE EXCEPTION 'ABORTADO: a sonda P7 nao chegou ao fim — permission denied em vw_payables '
                      'sob o papel authenticated apareceria aqui';
    END IF;
    IF v_uid IS DISTINCT FROM v_usuario THEN
      RAISE EXCEPTION 'ABORTADO: auth.uid() = % sob claims de % — a sonda mediria o vazio',
        v_uid, v_usuario;
    END IF;
    RAISE NOTICE 'gasto_por_periodo: sob authenticated a serie devolveu % balde(s)', v_como_auth;
  END IF;

  RAISE NOTICE 'gasto_por_periodo 124 OK: % baldes de % a % (% parciais, % completos); balde '
               'corrente com % de % dias (hoje %); agregados identicos ao controle',
               v_baldes, v_de, v_ate, v_parciais, v_completos,
               v_ultimo.days_covered, v_ultimo.days_total, v_hoje;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICACAO (apos aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
-- 1. Serie semanal por emissao de 01/07 a 31/08: 7 baldes, o de 29/06 com 5 de 7 dias e o de 10/08
--    com 4 de 7, ambos com is_partial verdadeiro; os cinco do meio com 7 de 7.
-- 2. Os mesmos 7 valores de account_count e total_amount de antes da migration — esta mudanca
--    acrescenta ressalva, nao altera numero.
-- 3. Granularidade e campo de data fora do dominio devolvem VAZIO (antes caiam em mes/vencimento).
-- 4. Pelo PostgREST com a anon key: 42501, e nao PGRST202 — prova que o cache de schema ja
--    enxerga a assinatura nova E que anon segue barrado.
-- 5. Ordem de implantacao: migration -> conferir o cache -> deploy da Next API (tools.ts), para o
--    texto novo da tool chegar ao modelo.
