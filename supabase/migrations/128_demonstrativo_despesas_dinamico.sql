-- 128_demonstrativo_despesas_dinamico.sql
--
-- Torna analytics.demonstrativo_despesas DINÂMICA: em vez de decorar os ids do catálogo
-- financial_type_group num CASE (migrations 104 e 127), a função passa a LER duas colunas
-- novas do próprio catálogo — demonstrativo_line_order e demonstrativo_line_label — via LEFT
-- JOIN. Um tipo novo, cadastrado só por SQL/service_role (não há CRUD para financial_type_group),
-- passa a aparecer como linha nova no demonstrativo SEM exigir nova migration.
--
-- ---------------------------------------------------------------------------
-- POR QUE ISTO AGORA — o bug que a 127 corrigiu vai SE REPETIR sem isto
-- ---------------------------------------------------------------------------
-- O tipo 9 ("Custos de Importações") foi criado direto no banco em 2026-08-14, sem migration —
-- e o CASE hardcoded da 104 não sabia dele: 23 contas caíram em "Não classificado" e 6 contas
-- foram contadas erradamente como "Tributos" (achado completo no cabeçalho da 127). A 127
-- corrigiu ACRESCENTANDO o tipo 9 ao CASE — o que significa que o PRÓXIMO tipo novo (10, 11...)
-- reproduz o MESMO bug, porque a lista de linhas continua decorada em código. Esta migration
-- fecha essa classe de bug: o CASE vira leitura de catálogo.
--
-- DECISÃO DE ARQUITETURA: nada de "dinamismo cego" (uma linha para QUALQUER type_group_id que
-- apareça nos dados) — isso vazaria categorias sem sentido num relatório de despesas (ex.:
-- "Receitas", "Ativo") se alguma conta for classificada errado no cadastro. Em vez disso, o
-- catálogo ganha OPT-IN EXPLÍCITO: um tipo só vira linha própria quando alguém marcar essa
-- intenção nas duas colunas novas abaixo. Isso preserva o controle editorial do relatório e
-- ainda assim elimina a classe de bug (a função para de decorar ids).
--
-- ---------------------------------------------------------------------------
-- SCHEMA NOVO — duas colunas em financial_type_group (migrations 088/094)
-- ---------------------------------------------------------------------------
-- demonstrativo_line_order  SMALLINT (nullable) — NULL = este tipo NÃO vira linha própria no
--   demonstrativo (preserva o comportamento atual: Receitas/Despesas-genérico/Ativo/Custo-
--   genérico e o sentinela 0 continuam caindo em "Não classificado", como já caíam). UNIQUE
--   parcial (ignora NULL): dois tipos não podem reivindicar a mesma linha. CHECK: > 0 e fora de
--   {900, 999} (sentinelas reservados pela função — ver abaixo).
-- demonstrativo_line_label  VARCHAR(60) (nullable) — override do rótulo exibido; NULL usa
--   type_group_description da própria linha. Necessário porque dois rótulos HISTÓRICOS do
--   demonstrativo DIVERGEM do texto do catálogo: "Custos de Importação" (singular) vs.
--   "Custos de Importações" (plural, catálogo); "Tributos (passivo tributário)" vs. "Passivo"
--   (catálogo). Sem o override, esta migration mudaria o TEXTO do demonstrativo — regressão que
--   o oráculo P1 abaixo pegaria.
--
-- Sentinelas RESERVADOS por CHECK: 900 = "Não classificado" (sintetizado pela função quando
-- nenhum JOIN casa); 999 = "Total de saídas" (sintetizado por UNION ALL). Antes eram os números
-- 6 e 9 (migration 127) — baixos demais, colidiriam com uma 7ª/8ª linha real do catálogo. 900/999
-- deixam bastante espaço abaixo para o catálogo crescer sem esbarrar neles.
--
-- 🔴 Índice parcial: se algum dia existir `ON CONFLICT (demonstrativo_line_order) DO ...` contra
-- esta tabela, ele PRECISA repetir a cláusula `WHERE demonstrativo_line_order IS NOT NULL` —
-- sem ela o Postgres não acha índice de arbitragem e erra "no unique or exclusion constraint
-- matching the ON CONFLICT specification".
--
-- Idempotente (ADD COLUMN IF NOT EXISTS, DROP+ADD CONSTRAINT, CREATE INDEX IF NOT EXISTS,
-- UPDATE por id — reaplicar não duplica nem diverge).

ALTER TABLE public.financial_type_group
  ADD COLUMN IF NOT EXISTS demonstrativo_line_order SMALLINT,
  ADD COLUMN IF NOT EXISTS demonstrativo_line_label VARCHAR(60);

ALTER TABLE public.financial_type_group
  DROP CONSTRAINT IF EXISTS chk_financial_type_group_demonstrativo_reserved;
ALTER TABLE public.financial_type_group
  ADD CONSTRAINT chk_financial_type_group_demonstrativo_reserved
  CHECK (
    demonstrativo_line_order IS NULL
    OR (demonstrativo_line_order > 0 AND demonstrativo_line_order NOT IN (900, 999))
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_type_group_demonstrativo_line_order
  ON public.financial_type_group (demonstrativo_line_order)
  WHERE demonstrativo_line_order IS NOT NULL;

COMMENT ON COLUMN public.financial_type_group.demonstrativo_line_order IS
  'Ordem da linha própria no demonstrativo de custos e despesas (analytics.demonstrativo_despesas, '
  'migration 128). NULL = este tipo cai em "Não classificado" (comportamento padrão). Reservado: '
  '900 e 999 (sentinelas sintetizados pela função — ver CHECK). UNIQUE parcial: se usar '
  'ON CONFLICT contra esta coluna, repita "WHERE demonstrativo_line_order IS NOT NULL".';
COMMENT ON COLUMN public.financial_type_group.demonstrativo_line_label IS
  'Override do rótulo exibido nessa linha do demonstrativo (migration 128). NULL usa '
  'type_group_description da própria linha.';

-- ---------------------------------------------------------------------------
-- SEED idempotente — reproduz EXATAMENTE a classificação/rótulos da migration 127, para o
-- resultado da função não mudar UM CENTAVO nesta migration (só o MECANISMO muda). Tipos 0
-- (Não informado) / 1 (Receitas) / 2 (Despesas) / 3 (Ativo) / 8 (Custo) permanecem com
-- demonstrativo_line_order NULL — não viram linha própria, exatamente como hoje.
-- ---------------------------------------------------------------------------
UPDATE public.financial_type_group SET demonstrativo_line_order = 1, demonstrativo_line_label = NULL
 WHERE type_group_id = 7;  -- Custos de Mercadorias — rótulo do catálogo já bate, sem override
UPDATE public.financial_type_group SET demonstrativo_line_order = 2, demonstrativo_line_label = 'Custos de Importação'
 WHERE type_group_id = 9;  -- catálogo diz "Custos de Importações" (plural) — preserva o singular histórico
UPDATE public.financial_type_group SET demonstrativo_line_order = 3, demonstrativo_line_label = NULL
 WHERE type_group_id = 5;  -- Despesas Fixas — rótulo do catálogo já bate
UPDATE public.financial_type_group SET demonstrativo_line_order = 4, demonstrativo_line_label = NULL
 WHERE type_group_id = 6;  -- Despesas Variáveis — rótulo do catálogo já bate
UPDATE public.financial_type_group SET demonstrativo_line_order = 5, demonstrativo_line_label = 'Tributos (passivo tributário)'
 WHERE type_group_id = 4;  -- catálogo diz "Passivo" — preserva o rótulo histórico do demonstrativo

-- ---------------------------------------------------------------------------
-- FUNÇÃO — CREATE OR REPLACE, MESMA assinatura (parâmetros e RETURNS TABLE inalterados): os
-- GRANTs sobrevivem sem precisar reemitir REVOKE/GRANT (mesma lógica documentada na 127).
-- ---------------------------------------------------------------------------
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
            -- SUBGRUPO vence GRUPO na precedência (mesma regra documentada nas migrations
            -- 104/127) — por isso sg_tg entra ANTES de g_tg na COALESCE. Os dois LEFT JOINs
            -- filtram "AND demonstrativo_line_order IS NOT NULL": é o que garante que ordem e
            -- rótulo sempre saem da MESMA linha do catálogo — sem esse filtro, um tipo mal
            -- atribuído (ex.: subgrupo com o type_group_id de um tipo "de grupo") casaria pelo
            -- id mas a ordem viria de outra fonte via COALESCE, descasando rótulo × contagem.
            COALESCE(sg_tg.demonstrativo_line_order, g_tg.demonstrativo_line_order, 900)::integer
                AS line_order,
            COALESCE(sg_tg.demonstrativo_line_label, sg_tg.type_group_description,
                     g_tg.demonstrativo_line_label,  g_tg.type_group_description,
                     'Não classificado')::text
                AS line_label,
            v.amount
        FROM analytics.vw_payables v
        LEFT JOIN public.financial_type_group sg_tg
               ON sg_tg.type_group_id = v.chart_subgroup_type_id
              AND sg_tg.demonstrativo_line_order IS NOT NULL
              -- 🔴 GUARDA DE ESCOPO (achado do code review de 2026-08-14): sem isto, um
              -- SUBGRUPO cujo type_group_id apontasse por engano para um tipo GROUP-only (ex.:
              -- id 4 "Passivo", applies_to='group') seria classificado como "Tributos" via o
              -- caminho de subgrupo — nada no banco impede essa atribuição cruzada (o CHECK de
              -- `applies_to` só valida o valor na PRÓPRIA linha do catálogo; a validação de
              -- ESCOPO é só na app, `validateTypeGroupScope`, e não protege escrita direta por
              -- service_role/SQL — o MESMO caminho que criou o tipo 9 sem migration). Hoje é
              -- NO-OP (nenhum subgrupo real referencia um tipo 'group'-only — provado pela P1).
              AND sg_tg.applies_to IN ('subgroup', 'both')
        LEFT JOIN public.financial_type_group g_tg
               ON g_tg.type_group_id = v.chart_group_nature_id
              AND g_tg.demonstrativo_line_order IS NOT NULL
              -- Mesma guarda, sentido inverso: um GRUPO não pode ser classificado por um tipo
              -- 'subgroup'-only (ex.: id 7 "Custos de Mercadorias").
              AND g_tg.applies_to IN ('group', 'both')
        WHERE (CASE p_date_field
                   WHEN 'pagamento' THEN v.payment_date
                   WHEN 'emissao'   THEN v.issue_date
                   ELSE v.due_date
               END) BETWEEN p_date_from AND p_date_to
          AND NOT v.is_cancelled
          AND (p_sk_company IS NULL OR v.sk_company = p_sk_company)
    )
    SELECT b.line_order, b.line_label, count(*), COALESCE(sum(b.amount), 0)::numeric(15,2)
    FROM base b
    GROUP BY 1, 2
    UNION ALL
    SELECT 999, 'Total de saídas'::text, count(*), COALESCE(sum(b.amount), 0)::numeric(15,2)
    FROM base b
    ORDER BY 1;
$$;

COMMENT ON FUNCTION analytics.demonstrativo_despesas(date, date, text, bigint) IS
  'Demonstrativo de Custos e Despesas do período — NÃO é um DRE (o sistema tem 0 receitas). '
  'As linhas são DINÂMICAS desde a migration 128: vêm de financial_type_group.'
  'demonstrativo_line_order/demonstrativo_line_label, não de um CASE decorado — um tipo novo '
  'cadastrado no catálogo (só via SQL/service_role, sem CRUD) aparece como linha nova sem exigir '
  'migration. Linhas mutuamente exclusivas e exaustivas (SUBGRUPO vence GRUPO na precedência), '
  'com Não classificado (sentinela 900) e Total de saídas (sentinela 999) sempre presentes, de '
  'modo que a soma SEMPRE fecha com o total. Tool: demonstrativo_despesas.';

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO — 8 sondas (P0-P7), RAISE EXCEPTION aborta a migration inteira em qualquer
-- divergência. P7 (guarda de escopo por applies_to) foi acrescentada pelo achado R1 do
-- /meu-code-review light de 2026-08-14, antes do primeiro commit deste diff.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_seed_rows      integer;
  v_seed_bad       integer;
  v_mismatch       integer;
  v_soma_linhas    numeric(15,2);
  v_total_linha    numeric(15,2);
  v_baseline_qt    bigint;
  v_baseline_rs    numeric(15,2);
  v_mut_qt         bigint;
  v_mut_rs         numeric(15,2);
  v_restore_label  varchar(60);
  v_dominio        text;
  v_order_receitas smallint;
  v_grant_auth     boolean;
  v_grant_anon     boolean;
BEGIN
  -- ========================================================================================
  -- P0 — O SEED PEGOU, E SÓ NOS 5 TIPOS ESPERADOS (nada a mais, nada a menos).
  -- ========================================================================================
  SELECT count(*) INTO v_seed_rows
    FROM public.financial_type_group WHERE demonstrativo_line_order IS NOT NULL;
  IF v_seed_rows <> 5 THEN
    RAISE EXCEPTION 'ABORTADO: esperava exatamente 5 tipos com demonstrativo_line_order '
                    'preenchido (7,9,5,6,4), achei %. O cadastro pode ter mudado entre a escrita '
                    'desta migration e a aplicação; investigar antes de seguir.', v_seed_rows;
  END IF;

  SELECT count(*) INTO v_seed_bad
    FROM public.financial_type_group
   WHERE type_group_id IN (7,9,5,6,4)
     AND demonstrativo_line_order IS DISTINCT FROM (CASE type_group_id
           WHEN 7 THEN 1 WHEN 9 THEN 2 WHEN 5 THEN 3 WHEN 6 THEN 4 WHEN 4 THEN 5 END);
  IF v_seed_bad <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: % tipo(s) entre 7/9/5/6/4 com demonstrativo_line_order fora do '
                    'esperado — o seed gravou o número errado', v_seed_bad;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.financial_type_group
     WHERE type_group_id IN (0,1,2,3,8) AND demonstrativo_line_order IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ABORTADO: um tipo que deveria ficar em "Não classificado" (0/1/2/3/8) '
                    'ganhou demonstrativo_line_order — mudaria o comportamento atual';
  END IF;

  -- ========================================================================================
  -- P1 — ORÁCULO DE REGRESSÃO: a função NOVA (dinâmica) bate, linha a linha (rótulo, contagem,
  -- valor), com o CASE ANTIGO hardcoded (migration 127), sobre TODA a base histórica. O CASE
  -- antigo é reproduzido aqui como controle independente, numa CTE inline (não CREATE TEMP
  -- TABLE — PL/pgSQL exige EXECUTE para DDL dentro de um bloco DO) — a função antiga já foi
  -- substituída por este CREATE OR REPLACE, não dá para chamá-la.
  -- ========================================================================================
  WITH oraculo_antigo AS (
      WITH base AS (
          SELECT
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
          WHERE v.due_date BETWEEN DATE '2000-01-01' AND CURRENT_DATE + 3650
            AND NOT v.is_cancelled
      )
      SELECT
          (CASE b.line_order
              WHEN 1 THEN 'Custos de Mercadorias'
              WHEN 2 THEN 'Custos de Importação'
              WHEN 3 THEN 'Despesas Fixas'
              WHEN 4 THEN 'Despesas Variáveis'
              WHEN 5 THEN 'Tributos (passivo tributário)'
              ELSE        'Não classificado'
           END)::text                                AS line_label,
          count(*)::bigint                           AS account_count,
          COALESCE(sum(b.amount), 0)::numeric(15,2)   AS total_amount
      FROM base b
      GROUP BY 1
      UNION ALL
      SELECT 'Total de saídas'::text, count(*)::bigint, COALESCE(sum(b.amount), 0)::numeric(15,2)
      FROM base b
  ),
  novo AS (
      SELECT line_label, account_count, total_amount
        FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento')
  )
  SELECT count(*) INTO v_mismatch FROM (
      (SELECT * FROM oraculo_antigo EXCEPT SELECT * FROM novo)
      UNION ALL
      (SELECT * FROM novo EXCEPT SELECT * FROM oraculo_antigo)
  ) diff;

  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: a função dinâmica diverge do CASE antigo em % linha(s) — mudei '
                    'o mecanismo E o resultado, não só o mecanismo', v_mismatch;
  END IF;

  -- ========================================================================================
  -- P2 — INVARIANTE HERDADO (migration 104): a soma das linhas reais fecha com "Total de
  -- saídas". Sentinela do total agora é 999 (era 9) — ver o cabeçalho.
  -- ========================================================================================
  SELECT COALESCE(sum(total_amount) FILTER (WHERE line_order <> 999), 0),
         COALESCE(sum(total_amount) FILTER (WHERE line_order = 999), 0)
    INTO v_soma_linhas, v_total_linha
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento');

  IF v_soma_linhas IS DISTINCT FROM v_total_linha THEN
    RAISE EXCEPTION 'ABORTADO: a soma das linhas (R$ %) não fecha com o Total de saídas (R$ %)',
                    v_soma_linhas, v_total_linha;
  END IF;

  -- ========================================================================================
  -- P3 — PROVA DE DINAMISMO: mutar o rótulo de um tipo JÁ EXISTENTE (id 6, Despesas Variáveis),
  -- sem tocar na função nem criar migration nova, e ver o rótulo novo aparecer com a MESMA
  -- contagem/valor. RESTAURA explicitamente no mesmo bloco (não depende de rollback implícito)
  -- e CONFIRMA a restauração antes de seguir. Ordem deliberada: o UPDATE de restauração vem
  -- logo após a medição, ANTES de qualquer IF que possa abortar — a mutação não pode sobreviver
  -- ao caminho de SUCESSO desta migration.
  -- ========================================================================================
  SELECT COALESCE(sum(account_count), 0)::bigint, COALESCE(sum(total_amount), 0)::numeric(15,2)
    INTO v_baseline_qt, v_baseline_rs
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento')
   WHERE line_label = 'Despesas Variáveis';

  UPDATE public.financial_type_group
     SET demonstrativo_line_label = '__SONDA_DINAMISMO_128__'
   WHERE type_group_id = 6;

  SELECT COALESCE(sum(account_count), 0)::bigint, COALESCE(sum(total_amount), 0)::numeric(15,2)
    INTO v_mut_qt, v_mut_rs
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento')
   WHERE line_label = '__SONDA_DINAMISMO_128__';

  -- Restaura ANTES de qualquer IF que possa abortar.
  UPDATE public.financial_type_group
     SET demonstrativo_line_label = NULL
   WHERE type_group_id = 6;

  SELECT demonstrativo_line_label INTO v_restore_label
    FROM public.financial_type_group WHERE type_group_id = 6;

  IF v_restore_label IS NOT NULL THEN
    RAISE EXCEPTION 'ABORTADO: a sonda de dinamismo não restaurou demonstrativo_line_label do '
                    'tipo 6 (achei %, esperava NULL) — o catálogo ficaria com rótulo de teste',
                    v_restore_label;
  END IF;

  IF v_mut_qt = 0 THEN
    RAISE EXCEPTION 'ABORTADO: mudar demonstrativo_line_label do tipo 6 não produziu linha '
                    'nova na função — ela NÃO está lendo o catálogo dinamicamente';
  END IF;

  IF v_mut_qt <> v_baseline_qt OR v_mut_rs IS DISTINCT FROM v_baseline_rs THEN
    RAISE EXCEPTION 'ABORTADO: a linha mutada (% contas, R$ %) não bate com a baseline de '
                    'Despesas Variáveis (% contas, R$ %) — o rótulo mudou o CONJUNTO de contas, '
                    'não só o texto', v_mut_qt, v_mut_rs, v_baseline_qt, v_baseline_rs;
  END IF;

  PERFORM 1
    FROM analytics.demonstrativo_despesas('2000-01-01', CURRENT_DATE + 3650, 'vencimento')
   WHERE line_label = 'Despesas Variáveis'
     AND account_count = v_baseline_qt
     AND total_amount IS NOT DISTINCT FROM v_baseline_rs;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ABORTADO: pós-restauração, "Despesas Variáveis" não voltou com os números '
                    'da baseline (% contas, R$ %)', v_baseline_qt, v_baseline_rs;
  END IF;

  -- ========================================================================================
  -- P4 — CONSTRAINT UNIQUE dispara para número de linha duplicado. Savepoint implícito do
  -- PL/pgSQL (BEGIN…EXCEPTION) — mesmo padrão da migration 122. UPDATE, não INSERT: não avança
  -- a sequence IDENTITY (a ressalva registrada no README da 120).
  -- ========================================================================================
  BEGIN
    UPDATE public.financial_type_group SET demonstrativo_line_order = 5  -- já usado pelo id 4
     WHERE type_group_id = 1;  -- Receitas, hoje NULL
    v_dominio := 'ACEITOU';
  EXCEPTION
    WHEN unique_violation THEN v_dominio := 'ok';
  END;

  IF v_dominio <> 'ok' THEN
    RAISE EXCEPTION 'ABORTADO: dois tipos reivindicaram a mesma demonstrativo_line_order sem '
                    'erro — a UNIQUE parcial não está travando';
  END IF;

  SELECT demonstrativo_line_order INTO v_order_receitas
    FROM public.financial_type_group WHERE type_group_id = 1;
  IF v_order_receitas IS NOT NULL THEN
    RAISE EXCEPTION 'ABORTADO: o tipo Receitas (id 1) ficou com demonstrativo_line_order = % '
                    'após a sonda P4 — deveria ter permanecido NULL', v_order_receitas;
  END IF;

  -- ========================================================================================
  -- P5 — CONSTRAINT CHECK dispara para os sentinelas reservados (900/999). Mesmo padrão.
  -- ========================================================================================
  BEGIN
    UPDATE public.financial_type_group SET demonstrativo_line_order = 900
     WHERE type_group_id = 1;
    v_dominio := 'ACEITOU';
  EXCEPTION
    WHEN check_violation THEN v_dominio := 'ok';
  END;

  IF v_dominio <> 'ok' THEN
    RAISE EXCEPTION 'ABORTADO: um tipo assumiu demonstrativo_line_order = 900 (sentinela '
                    'reservado) sem erro — o CHECK não está travando';
  END IF;

  SELECT demonstrativo_line_order INTO v_order_receitas
    FROM public.financial_type_group WHERE type_group_id = 1;
  IF v_order_receitas IS NOT NULL THEN
    RAISE EXCEPTION 'ABORTADO: o tipo Receitas (id 1) ficou com demonstrativo_line_order = % '
                    'após a sonda P5 — deveria ter permanecido NULL', v_order_receitas;
  END IF;

  -- ========================================================================================
  -- P6 — GRANTS sobrevivem ao CREATE OR REPLACE (assinatura idêntica; a lição repetida do
  -- projeto é NUNCA supor, sempre medir).
  -- ========================================================================================
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

  -- ========================================================================================
  -- P7 — GUARDA DE ESCOPO (achado do code review de 2026-08-14): a condição `applies_to`
  -- adicionada aos dois JOINs realmente impede o cruzamento subgrupo↔grupo. Não precisa mutar
  -- `financial_chart_of_account_subgroup`/`_group` (dado real de cadastro) — a guarda é uma
  -- propriedade da condição do JOIN sobre o CATÁLOGO, então testá-la contra o catálogo já
  -- prova o comportamento: id 4 (Passivo, `applies_to='group'`) nunca pode casar pelo lado do
  -- SUBGRUPO, e id 7 (Custos de Mercadorias, `applies_to='subgroup'`) nunca pelo lado do GRUPO.
  -- ========================================================================================
  IF EXISTS (
    SELECT 1 FROM public.financial_type_group
     WHERE type_group_id = 4 AND demonstrativo_line_order IS NOT NULL
       AND applies_to IN ('subgroup', 'both')
  ) THEN
    RAISE EXCEPTION 'ABORTADO: guarda de escopo falhou — id 4 (Passivo, applies_to=group) '
                    'casaria pelo lado do SUBGRUPO';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.financial_type_group
     WHERE type_group_id = 7 AND demonstrativo_line_order IS NOT NULL
       AND applies_to IN ('group', 'both')
  ) THEN
    RAISE EXCEPTION 'ABORTADO: guarda de escopo falhou — id 7 (Custos de Mercadorias, '
                    'applies_to=subgroup) casaria pelo lado do GRUPO';
  END IF;

  RAISE NOTICE 'OK: seed 5/5 · oráculo de regressão 0 divergências · soma das linhas fecha '
               '(R$ %) · prova de dinamismo OK (mutou/mediu/restaurou/confirmou tipo 6) · '
               'UNIQUE e CHECK travam duplicata/sentinela · guarda de escopo (applies_to) OK · '
               'grants intactos (authenticated sim, anon não)', v_total_linha;
END $$;
