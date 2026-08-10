-- 116_analytics_total_encontrado.sql
--
-- CORREÇÃO da ONDA 6 (achado B1 do code review de 2026-08-10) — docs/review/2026-08-10-Features-light-onda6.md
--
-- PROBLEMA: as duas funções da migration 115 truncam a resposta no `LIMIT` e **não declaram o
-- corte**. Medido no banco em 2026-08-10:
--     analytics.fornecedores_recorrentes()                     -> 50 linhas
--     analytics.fornecedores_recorrentes(3,5,NULL,NULL,1e6)    -> 63 linhas
-- Ou seja: 13 fornecedores recorrentes somem sem erro, sem aviso e sem nenhum campo que permita
-- perceber a falta. Quem contar as linhas responde "50 fornecedores recorrentes" — um número
-- errado, plausível e indefensável.
--
-- É a MESMA armadilha que o projeto já corrigiu duas vezes:
--   `gasto_por_fornecedor` (Onda 1) — ranking truncado cuja soma NÃO dá o total do período;
--   `documentos_fiscais`  (Onda 3, migration 108) — resolvida com `total_encontrado`.
-- Esta migration aplica a MESMA solução às duas funções da 115.
--
-- Guardas deste arquivo: tests/test_onda6_campos_derivados.py (G7, G9).
--
-- ---------------------------------------------------------------------------
-- 🔴 POR QUE UMA MIGRATION NOVA, E NÃO EDITAR A 115
-- ---------------------------------------------------------------------------
-- A 115 já está APLICADA. Migration aplicada é artefato imutável (regra de ouro do projeto:
-- "nunca alterar migrations existentes — criar nova migration para mudanças"). Editá-la faria o
-- arquivo descrever um estado que o banco não teve, quebrando a reprodutibilidade da cadeia.
--
-- ---------------------------------------------------------------------------
-- 🔴 POR QUE `DROP` E NÃO `CREATE OR REPLACE`
-- ---------------------------------------------------------------------------
-- Acrescentar coluna ao `RETURNS TABLE` MUDA O TIPO DE RETORNO, e o PostgreSQL recusa
-- `CREATE OR REPLACE` nesse caso (42P13: cannot change return type of existing function). O par
-- DROP + CREATE é obrigatório.
--
-- 🔴 CONSEQUÊNCIA QUE NÃO PODE SER ESQUECIDA: **`DROP FUNCTION` LEVA OS GRANTS JUNTO.** Recriar
-- sem reemitir GRANT/REVOKE deixaria a função executável por `PUBLIC` (default do PostgreSQL) e
-- INEXECUTÁVEL por `authenticated` — isto é, aberta para quem não deveria e quebrada para quem
-- deveria. Os grants estão no fim deste arquivo e são parte da correção, não burocracia.
--
-- Verificado que o DROP é seguro: nenhum consumidor. As duas funções não estão em
-- `apps/api-backend/lib/ai-chat/tools.ts` (9 tools, nenhuma delas) nem em qualquer .ts do
-- monorepo. Não há view, coluna gerada ou trigger dependente.
--
-- IDEMPOTENTE (DROP ... IF EXISTS + CREATE). Reexecutar é no-op. Todo o arquivo roda numa única
-- transação implícita: se o CREATE falhar, o DROP volta atrás e a função antiga permanece.

-- ---------------------------------------------------------------------------
-- 6.6 (corrigida) — Recorrência por CADÊNCIA, agora com o total declarado
-- ---------------------------------------------------------------------------
-- Corpo idêntico ao da 115 — as decisões de negócio NÃO mudam. Três acréscimos, todos de
-- robustez, marcados com [B1], [DET] e [CLAMP] no ponto de uso.

DROP FUNCTION IF EXISTS analytics.fornecedores_recorrentes(integer, integer, date, date, integer);

CREATE FUNCTION analytics.fornecedores_recorrentes(
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
    valor_variacao_pct     numeric,
    -- [B1] Quantos fornecedores atendem ao critério ANTES do LIMIT. Vem em TODA linha (não há
    -- outro lugar onde caiba, numa RETURNS TABLE) e é o que separa "são 50" de "são 63, mostrando
    -- 50". Sem ele, truncar é indistinguível de não haver mais nada.
    total_encontrado       integer
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
                ELSE round((100.0 * (c.valor_max - c.valor_min) / c.valor_med::numeric), 1) END,
           -- [B1] Função de JANELA, não subconsulta: o PostgreSQL avalia a janela DEPOIS do
           -- WHERE/GROUP BY e ANTES do ORDER BY/LIMIT. É exatamente essa ordem que faz o número
           -- ser o total REAL e não o total das linhas que sobreviveram ao corte. Os parênteses
           -- externos são obrigatórios: `count(*) OVER ()::integer` casta a janela vazia.
           (count(*) OVER ())::integer
      FROM classificado c
     -- [DET] Desempate pela PK. `ocorrencias` + `supplier_name` NÃO formam ordem total (fornecedor
     -- homônimo existe, e `supplier_name` pode ser NULL), e sem ordem total o conjunto truncado
     -- pelo LIMIT varia conforme o plano de execução: a mesma chamada devolve fornecedores
     -- diferentes entre execuções, sem erro. É a mesma lição de `lib/stableOrder.ts` e do
     -- `applyOrder` da Next API — só que aqui o sintoma seria "o ranking mudou sozinho".
     ORDER BY c.ocorrencias DESC, c.supplier_name, c.sk_supplier
     -- [CLAMP] `LIMIT` negativo é ERRO em runtime no PostgreSQL (2201W). Um p_limit vindo de
     -- parâmetro de tool/LLM não é confiável; o GREATEST transforma um erro em resposta vazia.
     LIMIT GREATEST(COALESCE(p_limit, 50), 0);
$$;

COMMENT ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) IS
  'Fornecedores com despesa recorrente, classificados pela CADÊNCIA entre vencimentos — nunca pelo '
  'valor (só 3 de 11 recorrentes têm valor estável; classificar por valor perderia os outros 8). '
  'SECURITY INVOKER: conta apenas o que o usuário do JWT enxerga. `confianca` = ''provavel'' só '
  'quando TODOS os intervalos cabem na banda, não só a mediana. Com o histórico atual (máx. 5 '
  'meses) apenas cadência mensal/quinzenal/semanal é detectável; bimestral sai ''insuficiente'' e '
  'trimestral/anual não é detectável. `parcelamento_provavel` = TRUE indica CARNÊ (um contrato '
  'parcelado), que produz cadência mensal perfeita e NÃO é fornecedor recorrente. '
  '🔴 `total_encontrado` é quantos atendem ao critério ANTES do LIMIT: se for maior que o número '
  'de linhas recebidas, a resposta está TRUNCADA e não se pode contá-la nem somá-la.';

-- ---------------------------------------------------------------------------
-- 6.3 (complemento, corrigido) — parcelamento OBSERVADO, com o total declarado
-- ---------------------------------------------------------------------------
-- Hoje devolve 10 de 10 grupos e NÃO trunca. Recebe o mesmo tratamento porque o defeito é
-- ESTRUTURAL, não uma contagem infeliz: o `LIMIT` já está lá, e o dia em que a base passar de 50
-- carnês a função passa a mentir sem que nada mude no código. Corrigir só a que já dói deixaria a
-- segunda esperando para repetir o mesmo achado.

DROP FUNCTION IF EXISTS analytics.parcelamentos(bigint, integer);

CREATE FUNCTION analytics.parcelamentos(
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
    valor_total_observado   numeric,
    -- [B1] Quantos CARNÊS existem antes do LIMIT (a janela roda depois do GROUP BY, então conta
    -- grupos, não contas).
    total_encontrado        integer
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
           sum(p.amount),
           (count(*) OVER ())::integer                                    -- [B1]
      FROM analytics.vw_payables p
     WHERE p.installment_number IS NOT NULL
       AND NOT p.is_cancelled
       AND (p_sk_supplier IS NULL OR p.sk_supplier = p_sk_supplier)
     GROUP BY p.sk_supplier, p.installment_base
     -- [DET] `count(*) DESC, min(due_date)` empata com facilidade (a maioria dos carnês tem 1
     -- parcela observada), e o par do GROUP BY é a chave única do grupo — com ele a ordem é total
     -- e o recorte do LIMIT deixa de depender do plano.
     ORDER BY count(*) DESC, min(p.due_date), p.sk_supplier, p.installment_base
     LIMIT GREATEST(COALESCE(p_limit, 50), 0);                            -- [CLAMP]
$$;

COMMENT ON FUNCTION analytics.parcelamentos(bigint, integer) IS
  'Parcelamentos (carnês) agrupados por documento. `parcelas_observadas` é o que ESTE usuário '
  'enxerga sob RLS — NUNCA apresentar como "parcela X de N": o total não existe na origem (o '
  'reader grava doc/ordinal, sem total). `parcelas_faltando` lista os buracos em 1..maior: um '
  'carnê {1,3} tem a 2ª parcela sem conta cadastrada, que é um passivo invisível. '
  '🔴 `total_encontrado` é quantos carnês existem ANTES do LIMIT — se exceder o número de linhas '
  'recebidas, a resposta está truncada.';

-- ---------------------------------------------------------------------------
-- 🔴 GRANTS — o DROP acima os apagou; sem esta seção a correção vira um furo de segurança
-- ---------------------------------------------------------------------------
-- Guardrail 2 do roadmap, explícito nos DOIS sentidos: o PostgreSQL concede EXECUTE a PUBLIC por
-- default e o ALTER DEFAULT PRIVILEGES da 098 não persiste neste schema (medido na Onda 1: 4
-- funções recriadas pela 104 nasceram chamáveis com a anon key PÚBLICA, sem login).

GRANT  EXECUTE ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.fornecedores_recorrentes(integer, integer, date, date, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION analytics.parcelamentos(bigint, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.parcelamentos(bigint, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICAÇÃO — a migration ABORTA se `total_encontrado` não for o total REAL
-- ---------------------------------------------------------------------------
-- Oráculo diferencial: pedir UMA linha e conferir que o total declarado continua sendo o de TODAS.
-- É a prova direta de que a janela é avaliada antes do LIMIT — a única propriedade da qual toda
-- esta migration depende. Se alguém trocar `count(*) OVER ()` por uma subconsulta que herde o
-- LIMIT, ou reintroduzir o truncamento silencioso, é aqui que aparece — na aplicação, não meses
-- depois, numa resposta errada ao usuário.
--
-- Note que os números NÃO são fixados (63, 10): eles derivam a cada conta lançada. O oráculo
-- compara os dois caminhos entre si, que é o que continua verdadeiro amanhã.

DO $$
DECLARE
    declarado integer;
    real_     integer;
BEGIN
    SELECT total_encontrado INTO declarado
      FROM analytics.fornecedores_recorrentes(3, 5, NULL, NULL, 1);
    SELECT count(*)::integer INTO real_
      FROM analytics.fornecedores_recorrentes(3, 5, NULL, NULL, 1000000);
    IF declarado IS DISTINCT FROM real_ THEN
        RAISE EXCEPTION
          'ABORTADO: fornecedores_recorrentes declara total_encontrado=% mas existem % — a janela '
          'esta sendo avaliada DEPOIS do LIMIT', declarado, real_;
    END IF;

    SELECT total_encontrado INTO declarado
      FROM analytics.parcelamentos(NULL, 1);
    SELECT count(*)::integer INTO real_
      FROM analytics.parcelamentos(NULL, 1000000);
    IF declarado IS DISTINCT FROM real_ THEN
        RAISE EXCEPTION
          'ABORTADO: parcelamentos declara total_encontrado=% mas existem %', declarado, real_;
    END IF;

    -- LIMIT negativo tem de virar resposta vazia, nunca 2201W (o [CLAMP]).
    PERFORM * FROM analytics.fornecedores_recorrentes(3, 5, NULL, NULL, -1);
    PERFORM * FROM analytics.parcelamentos(NULL, -1);

    -- O grant tem de ter sobrevivido ao DROP, nos dois sentidos.
    IF NOT has_function_privilege('authenticated',
           'analytics.fornecedores_recorrentes(integer,integer,date,date,integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'ABORTADO: authenticated perdeu o EXECUTE de fornecedores_recorrentes';
    END IF;
    IF has_function_privilege('anon',
           'analytics.parcelamentos(bigint,integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'ABORTADO: anon ficou com EXECUTE em parcelamentos';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. O `DO $$` acima já provou o essencial na própria aplicação. Repetir à mão só se quiser ver
--      os números: `fornecedores_recorrentes()` com o LIMIT padrão devolve 50 linhas, e cada uma
--      traz `total_encontrado = 63` (medição de 2026-08-10) — é essa diferença que antes era
--      invisível.
--   2. `has_function_privilege('anon', ...)` = false para as duas; `authenticated` = true.
--   3. O conjunto devolvido não mudou: `fornecedores_recorrentes(3,5,NULL,NULL,1000000)` continua
--      batendo com `SELECT sk_supplier FROM analytics.vw_payables WHERE NOT is_cancelled AND
--      due_date IS NOT NULL GROUP BY 1 HAVING count(DISTINCT due_date) >= 3` (63, EXCEPT vazio nos
--      dois sentidos). Esta migration acrescenta uma coluna e fixa a ordem; NÃO muda a regra.
--   4. `get_advisors` sem achado novo (em especial: nenhuma função SECURITY DEFINER acidental).
