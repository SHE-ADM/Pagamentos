-- 121_pontualidade_pagamento.sql
--
-- ONDA 9 — docs/roadmap-enriquecimento-dados.md §4, item "DPO / pontualidade real".
--
-- ---------------------------------------------------------------------------
-- POR QUE AGORA: O GATILHO FOI MEDIDO, NAO PRESUMIDO
-- ---------------------------------------------------------------------------
-- A Onda 9 e CONDICIONAL: cada item so entra quando o gatilho dele ocorre. O deste item era
-- "historico pos-096 acumulado" — quando o plano foi escrito havia 2 dias de dado real e 97% das
-- contas pagas carregavam a data do BACKFILL. Medido em 2026-08-13, contra o banco:
--
--   658 contas pagas no total
--   217 com carimbo REAL da trigger (33%), em 3 semanas CONTINUAS (40 / 100 / 77)
--   132 delas com payment_date <> due_date  → ha sinal de desvio, nao so zeros
--   media 1,73 dia · mediana 1 · minimo -4 · maximo 31
--
-- Os outros seis gatilhos da onda foram medidos na mesma passada e NAO dispararam: CF-e/NFC-e
-- (0 documentos modelo 59/65 contra 133 NF-e e 169 CT-e), NFS-e (1 conta), text-to-SQL (8
-- interacoes no ai_chat_log, ZERO erro/truncada/sem-tool — ou seja, as tools cobriram tudo o que
-- foi perguntado), tabelas agregadas (2,2 a 7,0 ms server-side contra o teto de 500 ms), receitas
-- (0 linhas de entrada) e conciliacao bancaria (sem integracao). Este arquivo entrega SO o item
-- que disparou.
--
-- ---------------------------------------------------------------------------
-- 🔴 POR QUE NAO SE CHAMA "DPO"
-- ---------------------------------------------------------------------------
-- DPO (Days Payable Outstanding) e um indicador CONTABIL: saldo medio de contas a pagar dividido
-- pelo CMV do periodo, vezes os dias. Aqui o "saldo de contas a pagar" e apenas o que chegou por
-- E-MAIL e foi extraido — nao o passivo da empresa. Publicar isso com o nome consagrado repetiria
-- exatamente o erro que a decisao do DRE evitou (§5 do roadmap): numero com o nome de uma coisa
-- que ele nao e. O que este arquivo entrega e PONTUALIDADE DE PAGAMENTO, medida conta a conta, e
-- o nome diz isso.
--
-- ---------------------------------------------------------------------------
-- 🔴 AS DUAS ARMADILHAS DO DADO — e por que a funcao e mais complicada do que parece
-- ---------------------------------------------------------------------------
-- (1) O BACKFILL DA 096 GRAVOU `payment_date := due_date` nas 441 contas ja pagas. Nelas
--     `days_late` e ZERO POR CONSTRUCAO. Agregar as duas populacoes juntas devolveria "atraso
--     medio proximo de zero" — confiantemente falso, e e o motivo de o roadmap ter adiado o item.
--     Por isso toda metrica aqui sai SO da populacao com carimbo real, e a funcao DECLARA quantas
--     ficaram de fora: omitir a exclusao seria trocar um numero errado por um numero mudo.
--
-- (2) 🔴 `payment_date <> due_date` NAO PROVA carimbo real. Foi a primeira hipotese de
--     discriminador (o backfill sempre iguala, logo desvio ⇒ trigger) e o banco a REFUTOU: ha
--     **13** contas pagas ANTES do corte com desvio, a primeira em 2026-05-06. Todas com
--     `status_changed_at = 2026-07-16` e `updated_at = 2026-08-04` — o `due_date` foi ALTERADO
--     depois do pagamento (reemissao de boleto atualiza o vencimento da conta existente; e a
--     curadoria pode corrigi-lo). O `payment_date` ficou com o vencimento ANTIGO.
--
--     A consequencia vale para o futuro, nao so para essas 13: vencimento alterado depois do
--     pagamento transforma `days_late` em RUIDO — ele passa a medir "o vencimento mudou", nao
--     "pagamos com atraso". Desde a Onda 7 isso e DETECTAVEL (audit_log registra `due_date` em
--     `campos_alterados`), entao a funcao exclui esses casos e conta quantos foram. Hoje sao 0;
--     a exclusao existe para que continue correto quando deixarem de ser.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTE ARQUIVO CRIA
-- ---------------------------------------------------------------------------
--   1) analytics.payment_date_confiavel_desde()  — a data de corte, em UM lugar so
--   2) analytics.pontualidade_pagamento(...)     — a 12a tool do chat
--
-- IDEMPOTENTE. `CREATE OR REPLACE` na primeira; `DROP FUNCTION IF EXISTS` + `CREATE` na segunda
-- (assinatura nova). O DO final so le e sonda em subtransacao desfeita.
--
-- 🔴 O DROP APAGA OS GRANTS — a secao de GRANT/REVOKE ao fim e parte obrigatoria do arquivo, nao
-- enfeite (licao da 116, exercitada de novo na 118).

-- ---------------------------------------------------------------------------
-- 1) A DATA DE CORTE — fonte unica
-- ---------------------------------------------------------------------------
-- Espalhar `DATE '2026-07-29'` pelo corpo da funcao criaria um literal magico em N lugares, e a
-- proxima pessoa a mexer nao teria como saber de onde ele veio. Aqui ele vive numa funcao
-- IMMUTABLE, com a procedencia no COMMENT e verificada pela sonda P5 abaixo.
--
-- POR QUE 29/07 E NAO 28/07 (a data em que a 096 foi aplicada): o corte e CONSERVADOR de
-- proposito. Uma conta paga no proprio dia 28, depois da migration, tem carimbo real e sera
-- classificada como backfill — perde-se um dado, nao se inventa nenhum. O erro na direcao oposta
-- (incluir backfill na populacao confiavel) contaminaria TODAS as metricas com zeros artificiais.

CREATE OR REPLACE FUNCTION analytics.payment_date_confiavel_desde()
RETURNS date
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$ SELECT DATE '2026-07-29' $$;

COMMENT ON FUNCTION analytics.payment_date_confiavel_desde() IS
  'Data a partir da qual public.financial_account_control.payment_date foi carimbado pela TRIGGER '
  '(dado real), e nao pelo backfill da migration 096 (que gravou payment_date := due_date e '
  'produz days_late = 0 artificial). A 096 foi aplicada em 2026-07-28; o corte e 29/07 por ser '
  'conservador — classificar um carimbo real como backfill perde dado, o inverso inventa dado. '
  'Toda metrica de pontualidade tem de partir daqui; ver analytics.pontualidade_pagamento.';

-- ---------------------------------------------------------------------------
-- 2) A TOOL
-- ---------------------------------------------------------------------------
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
    -- adversarial desta onda, e reproduzido no banco antes de existir esta CTE: junho/2026 tem
    -- **113 contas pagas**, todas anteriores ao corte, e a funcao devolvia ZERO linhas. Um modelo
    -- que recebe zero linha responde "nao houve pagamento no periodo" — falso, e invertendo a
    -- conclusao: houve 113, elas so nao sao MENSURAVEIS. A diferenca entre "nao existe" e "existe
    -- mas nao da para medir" e justamente o que esta tool foi feita para preservar.
    --
    -- A linha de aviso so aparece quando ha conta paga no filtro E nenhum grupo sobreviveu; um
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
         WHERE NOT EXISTS (SELECT 1 FROM agrupado)
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
  'Pontualidade de pagamento (Onda 9): quanto se paga em dia, com que atraso e onde. '
  'NAO e DPO — DPO exige CMV e o passivo contabil da empresa; aqui a base e o que chegou por '
  'e-mail. SECURITY INVOKER: o grupo restrito ve apenas as proprias contas. '
  '🔴 COBERTURA PARCIAL POR CONSTRUCAO: so entram contas pagas a partir de '
  'analytics.payment_date_confiavel_desde() — antes disso payment_date veio do backfill da 096 '
  '(= vencimento) e produziria atraso zero artificial. `fora_da_cobertura` e `excluidas_venc_alterado` '
  'dizem quantas ficaram de fora e por que; cite-as ao responder. '
  '`atraso_medio_dias` soma SO as atrasadas (NULL quando nao houve nenhuma); `desvio_medio_dias` '
  'e o liquido com sinal, incluindo antecipacoes. `total_encontrado` e a contagem real antes do '
  'LIMIT: use-a para contar, nunca o numero de linhas.';

-- ---------------------------------------------------------------------------
-- GRANTS — os dois sentidos, explicitos
-- ---------------------------------------------------------------------------
-- O PostgreSQL concede EXECUTE a PUBLIC por DEFAULT em funcao nova: sem o REVOKE, `anon` executa
-- com a anon key (que e publica). Ja aconteceu com as 4 funcoes recriadas pela 104 e com
-- audit_sensitive_fields na 117 — nao confiar no default privilege, pela quinta vez.
GRANT  EXECUTE ON FUNCTION analytics.payment_date_confiavel_desde() TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.payment_date_confiavel_desde() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICACAO — a migration ABORTA se qualquer invariante nao valer
-- ---------------------------------------------------------------------------
-- Padrao das 116/117/118/120. Nenhuma sonda escreve na base; a P7 usa subtransacao desfeita
-- apenas para trocar de papel.

DO $$
DECLARE
  v_confiaveis   integer;
  v_linhas       integer;
  v_tool_contas  integer;
  v_ctrl_contas  integer;
  v_tool_atraso  integer;
  v_ctrl_atraso  integer;
  v_faixas       integer;
  v_dominio      integer;
  v_anon         boolean;
  v_pct_antes    numeric;
  v_pct_depois   numeric;
  v_pre_corte    integer;
  v_aviso_linhas integer;
  v_aviso_contas integer;
  v_aviso_fora   integer;
  v_usuario      uuid;
  v_uid          uuid;
  v_como_auth    integer := -1;
  v_p7_executou  boolean := false;
  v_corte        date := analytics.payment_date_confiavel_desde();
BEGIN
  -- P0 ANTI-VACUIDADE: sem populacao confiavel, TODA sonda abaixo passaria medindo o vazio — que
  -- e exatamente o estado em que este item ficou adiado por meses.
  SELECT count(*)::integer INTO v_confiaveis
    FROM public.financial_account_control
   WHERE status_id = 8 AND payment_date >= v_corte;

  IF v_confiaveis = 0 THEN
    RAISE EXCEPTION 'ABORTADO: nenhuma conta paga com carimbo real (>= %) — o gatilho da onda '
                    'nao vale neste banco e a tool responderia sempre vazio', v_corte;
  END IF;

  -- P1: a tool responde e o eixo 'geral' devolve exatamente UMA linha.
  SELECT count(*)::integer INTO v_linhas
    FROM analytics.pontualidade_pagamento(p_group_by => 'geral');
  IF v_linhas <> 1 THEN
    RAISE EXCEPTION 'ABORTADO: eixo geral devolveu % linha(s); esperava 1', v_linhas;
  END IF;

  -- P2 🔴 ORACULO DIFERENCIAL: a tool e uma query de controle equivalente tem de concordar.
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

  -- P3: dominio fechado. Eixo invalido devolve VAZIO, nunca um agregado errado.
  SELECT count(*)::integer INTO v_dominio
    FROM analytics.pontualidade_pagamento(p_group_by => 'centro_de_custo_inexistente');
  IF v_dominio <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: eixo invalido devolveu % linha(s) — deveria devolver vazio', v_dominio;
  END IF;

  -- P4: o eixo 'faixa' produz baldes, e mais de um (senao a faixa nao esta discriminando nada).
  SELECT count(*)::integer INTO v_faixas
    FROM analytics.pontualidade_pagamento(p_group_by => 'faixa');
  IF v_faixas < 2 THEN
    RAISE EXCEPTION 'ABORTADO: eixo faixa devolveu % balde(s) — sem discriminacao, a metrica '
                    'nao responde "onde esta o atraso"', v_faixas;
  END IF;

  -- P5 🔴 PLAUSIBILIDADE DA DATA DE CORTE. O backfill igualou payment_date a due_date, entao
  -- ANTES do corte quase tudo tem desvio zero; DEPOIS, o dado real espalha. Se alguem mover o
  -- corte para tras, o backfill entra na populacao "confiavel" e essa diferenca desaparece — e
  -- todas as metricas passam a ser diluidas por zeros artificiais, sem erro nenhum.
  SELECT round(100.0 * count(*) FILTER (WHERE payment_date = due_date) / NULLIF(count(*), 0), 1)
    INTO v_pct_antes
    FROM public.financial_account_control WHERE status_id = 8 AND payment_date < v_corte;

  SELECT round(100.0 * count(*) FILTER (WHERE payment_date = due_date) / NULLIF(count(*), 0), 1)
    INTO v_pct_depois
    FROM public.financial_account_control WHERE status_id = 8 AND payment_date >= v_corte;

  IF v_pct_antes IS NOT NULL AND v_pct_depois IS NOT NULL
     AND v_pct_depois > v_pct_antes - 20 THEN
    -- Sem simbolo de porcentagem no texto de proposito: em RAISE ele e placeholder, `%%` e o
    -- literal, e a contagem passa a depender de escape — um erro de compilacao que so aparece
    -- quando o bloco roda. Escrever "pct" custa nada e nao pode quebrar.
    RAISE EXCEPTION 'ABORTADO: sem fronteira detectavel no corte % — pagamento no vencimento e '
                    'de % pct antes e % pct depois. Ou a data de corte esta errada, ou o backfill '
                    'nao e mais distinguivel do dado real', v_corte, v_pct_antes, v_pct_depois;
  END IF;

  -- P5b 🔴 PERIODO SEM COBERTURA NAO DEVOLVE VAZIO. Reproduzido no banco antes da correcao:
  -- junho/2026 tinha 113 contas pagas, todas anteriores ao corte, e a funcao devolvia ZERO linhas
  -- — o modelo concluiria "nao houve pagamento", que e falso. O periodo da sonda e DERIVADO do
  -- dado (tudo ate a vespera do corte), nunca um mes fixo que pode esvaziar amanha.
  SELECT count(*)::integer INTO v_pre_corte
    FROM public.financial_account_control
   WHERE status_id = 8 AND payment_date < v_corte;

  IF v_pre_corte = 0 THEN
    RAISE NOTICE 'pontualidade: nao ha conta paga anterior ao corte — sonda P5b pulada';
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
  END IF;

  -- P6: `anon` NAO executa. O REVOKE acima e a unica coisa que impede a chamada com a anon key,
  -- que e publica por design.
  SELECT has_function_privilege('anon',
           'analytics.pontualidade_pagamento(date, date, text, bigint, integer, integer)', 'EXECUTE')
    INTO v_anon;
  IF v_anon THEN
    RAISE EXCEPTION 'ABORTADO: anon pode executar a tool — o REVOKE nao pegou';
  END IF;

  -- P7 🔴 COMPORTAMENTO SOB O PAPEL REAL. Privilegio concedido e consulta que RESPONDE sao
  -- perguntas diferentes (licao da 111: GRANT sem policy devolve zero linhas, em silencio). A
  -- funcao e SECURITY INVOKER e le vw_payables + audit_log: se faltar SELECT em qualquer uma,
  -- so o papel `authenticated` revela.
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
        FROM analytics.pontualidade_pagamento(p_group_by => 'faixa');
      v_p7_executou := true;
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- devolve o papel anterior; as variaveis plpgsql sobrevivem ao rollback
    END;

    IF NOT v_p7_executou THEN
      RAISE EXCEPTION 'ABORTADO: a sonda P7 nao chegou ao fim — excecao sob o papel authenticated '
                      'deixaria a assercao abaixo sem avaliar (permission denied em vw_payables '
                      'ou em audit_log apareceria aqui)';
    END IF;
    IF v_uid IS DISTINCT FROM v_usuario THEN
      RAISE EXCEPTION 'ABORTADO: auth.uid() = % sob claims de % — a sonda mediria o vazio',
        v_uid, v_usuario;
    END IF;
    -- Nao se exige linha > 0: o primeiro usuario pode ser de um grupo restrito e legitimamente
    -- nao ver nenhuma conta paga. O que se exige e que a chamada NAO levante.
    RAISE NOTICE 'pontualidade: sob authenticated a tool respondeu % balde(s)', v_como_auth;
  END IF;

  RAISE NOTICE 'pontualidade OK: % conta(s) confiavel(is) desde %; pagamento no vencimento em '
               '% pct das pagas antes do corte, contra % pct depois',
               v_confiaveis, v_corte, v_pct_antes, v_pct_depois;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICACAO (apos aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
-- 1. Chamar a tool nos cinco eixos e conferir que `fora_da_cobertura` bate com a contagem de
--    contas pagas anteriores a analytics.payment_date_confiavel_desde().
-- 2. Conferir pelo PostgREST (nao so por SQL) que o cache de schema ja enxerga a funcao: um POST
--    em /rest/v1/rpc/pontualidade_pagamento com header Content-Profile: analytics tem de
--    responder 200. Enquanto o cache estiver velho, a tool responde PGRST202 e o modelo recebe um
--    erro de ferramenta no meio do loop.
-- 3. Ordem de implantacao: migration -> conferir o cache -> deploy da Next API (tools.ts).
--    A API antes da migration faz a tool existir para o modelo e falhar na chamada.
