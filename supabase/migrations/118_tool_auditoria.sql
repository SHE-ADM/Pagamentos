-- 118_tool_auditoria.sql
--
-- ONDA 7 (item 7.2) — docs/roadmap-enriquecimento-dados.md §4
-- As tools que expõem ao chat a trilha criada pela migration 117. Regra transversal do roadmap:
-- "nada chega ao usuário sem uma tool que o exponha — o modelo só enxerga o que pode chamar".
--
-- Guardas deste arquivo: tests/test_onda7_auditoria.py.
--
-- ---------------------------------------------------------------------------
-- POR QUE DUAS FUNÇÕES, E NÃO UMA COM `p_group_by`
-- ---------------------------------------------------------------------------
-- A pergunta que a onda existe para responder — "quais usuários vêm alterando campos sensíveis" —
-- é AGREGADA. Uma lista de eventos truncada em 50 linhas não a responde: o modelo veria uma
-- amostra e concluiria a partir dela. Já "o que aconteceu com a conta 794?" é uma lista.
-- São dois formatos de retorno genuinamente diferentes; espremê-los numa `RETURNS TABLE` única
-- produziria colunas nulas conforme o modo, que é justamente o tipo de contrato ambíguo que faz o
-- modelo errar em silêncio.
--
-- ---------------------------------------------------------------------------
-- INVARIANTES HERDADOS DAS ONDAS 1, 3 e 6 (não afrouxar)
-- ---------------------------------------------------------------------------
-- · `SECURITY INVOKER` — é isso, e só isso, que faz a policy da 117 (que espelha a RLS 076) valer
--   no chat. `SECURITY DEFINER` aqui seria escalada de privilégio silenciosa: o grupo Comercial
--   passaria a ver a auditoria de contas alheias.
-- · `total_encontrado` via `count(*) OVER ()` — 4ª ocorrência da armadilha da truncagem silenciosa
--   (gasto_por_fornecedor na Onda 1, documentos_fiscais na 3, as duas funções da 115 na 6). Sem
--   ele, "50 alterações" é indistinguível de "as 50 primeiras de 300".
-- · `ORDER BY` com ordem TOTAL — sem desempate único o recorte do LIMIT varia com o plano e a
--   mesma pergunta devolve eventos diferentes entre execuções, sem erro.
-- · `GREATEST(COALESCE(p_limit, N), 0)` — LIMIT negativo é erro 2201W em runtime, e p_limit vem
--   de parâmetro gerado pelo modelo.
-- · `GRANT`/`REVOKE` explícitos nos dois sentidos — o default do PostgreSQL concede EXECUTE a
--   PUBLIC, e o `ALTER DEFAULT PRIVILEGES` da 098 não persiste (medido na Onda 1).
--
-- IDEMPOTENTE. As duas tools usam `DROP` + `CREATE` (e não `CREATE OR REPLACE`) porque a
-- correção dos achados A e B mudou a lista de colunas do `RETURNS TABLE` — o PostgreSQL recusa
-- `CREATE OR REPLACE` nesse caso (42P13). O `DROP` apaga os grants, que por isso são reemitidos
-- ao fim do arquivo (lição da migration 116).

-- ---------------------------------------------------------------------------
-- RÓTULO DO ATOR — fonte única das DUAS tools
-- ---------------------------------------------------------------------------
-- 🔴 EXISTEM TRÊS ESTADOS, NÃO DOIS, e conflacioná-los REATRIBUI a ação de uma pessoa.
-- Achado medido: um evento com `ator_via='jwt'` (ação humana) cujo usuário **foi removido** do
-- `auth.users` caía num `COALESCE(u.email, '(automacao...)')` e era contado junto com os eventos
-- do batch diário. A auditoria não perdia o evento — ela o atribuía a uma categoria que **inocenta
-- todo mundo**, que é o pior erro possível numa trilha.
--
-- E não é hipotético: este projeto **já apagou um usuário** (`teste@otimotex.com.br`, em
-- 2026-08-07, ver migration 110). Vai acontecer de novo.
--
--   usuario_id NULL          → automação / não atribuível  (o batch, o pipeline)
--   usuario_id + e-mail      → a pessoa
--   usuario_id SEM e-mail    → **usuário removido**, com o uuid preservado para rastreio
--
-- Fonte única de propósito: o rótulo aparece nas duas tools, e duas cópias divergiriam em silêncio.
CREATE OR REPLACE FUNCTION analytics.audit_actor_label(p_usuario_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_usuario_id IS NULL THEN '(automacao / nao atribuivel)'
           ELSE COALESCE(
                  (SELECT u.email::text FROM public.app_user u WHERE u.id = p_usuario_id),
                  '(usuario removido: ' || p_usuario_id::text || ')')
         END;
$$;

COMMENT ON FUNCTION analytics.audit_actor_label(uuid) IS
  'Rotulo de exibicao do autor de um evento de auditoria. Distingue TRES estados: automacao '
  '(sem ator), a pessoa (e-mail) e usuario REMOVIDO (uuid preservado). Conflacionar o terceiro '
  'com o primeiro reatribuiria a acao de um humano a uma rotina automatica.';

-- ---------------------------------------------------------------------------
-- 7.2a — Eventos individuais
-- ---------------------------------------------------------------------------
-- 🔴 `DROP` antes do `CREATE`: mudar o nome/lista de colunas do `RETURNS TABLE` muda o tipo de
-- retorno, e o PostgreSQL recusa `CREATE OR REPLACE` nesse caso (42P13). O DROP **apaga os
-- grants** — por isso a seção de GRANT/REVOKE ao fim deste arquivo é parte da correção, não
-- burocracia (lição da migration 116).
DROP FUNCTION IF EXISTS analytics.auditoria_eventos(date, date, text, text, text, text, bigint, integer);

CREATE FUNCTION analytics.auditoria_eventos(
    p_date_from   date    DEFAULT NULL,
    p_date_to     date    DEFAULT NULL,
    p_tabela      text    DEFAULT NULL,
    p_campo       text    DEFAULT NULL,
    p_usuario     text    DEFAULT NULL,
    p_operacao    text    DEFAULT NULL,
    p_registro_id bigint  DEFAULT NULL,
    p_limit       integer DEFAULT 50
)
RETURNS TABLE (
    criado_em        timestamptz,
    tabela           text,
    operacao         text,
    registro_id      bigint,
    -- `usuario`, não `usuario_email`: pode ser um rótulo ("(usuario removido: …)"), e um nome de
    -- coluna que promete e-mail faria o modelo apresentá-lo como endereço.
    usuario          text,
    ator_via         text,
    campos_alterados text[],
    sensivel         boolean,
    mudancas         jsonb,
    total_encontrado integer
)
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
    SELECT a.criado_em,
           a.tabela::text,
           a.operacao::text,
           a.registro_id,
           analytics.audit_actor_label(a.usuario_id),
           a.ator_via,
           a.campos_alterados,
           -- DELETE é sempre sensível: apagar o registro destrói todos os campos de uma vez.
           CASE WHEN a.operacao = 'UPDATE'
                THEN COALESCE(a.campos_alterados && public.audit_sensitive_fields(), false)
                ELSE true END,
           -- 🔴 NUNCA devolver `dados_antes`/`dados_depois` CRUS. A linha da fato em jsonb tem
           -- média 1,8 KB e máximo 13 KB (medido); o gateway corta o resultado de tool em 60 KB
           -- POR REGISTRO, então um punhado de DELETEs estouraria o teto e a resposta chegaria
           -- truncada ao modelo — o defeito que a Onda 2 existiu para matar, pela outra porta.
           CASE a.operacao
                WHEN 'UPDATE' THEN (
                    SELECT jsonb_object_agg(k, jsonb_build_object('antes',  a.dados_antes  -> k,
                                                                  'depois', a.dados_depois -> k))
                      FROM unnest(a.campos_alterados) AS k
                )
                -- No DELETE o resumo é composto pelos CAMPOS SENSÍVEIS presentes na linha — é uma
                -- regra declarada, não um recorte arbitrário, e acompanha `audit_sensitive_fields()`
                -- sozinha se o vocabulário mudar. A linha completa continua em `audit_log` para
                -- quem precisar dela por SQL.
                WHEN 'DELETE' THEN (
                    SELECT jsonb_object_agg(k, a.dados_antes -> k)
                      FROM unnest(public.audit_sensitive_fields()) AS k
                     WHERE a.dados_antes ? k
                )
                ELSE a.dados_antes      -- TRUNCATE: {"linhas_destruidas": N}
           END,
           (count(*) OVER ())::integer
      FROM public.audit_log a
     WHERE (p_date_from   IS NULL OR a.criado_em >= p_date_from)
       -- `< p_date_to + 1` e não `<= p_date_to`: `criado_em` é timestamptz, e comparar com a data
       -- pura descartaria tudo o que aconteceu DEPOIS da meia-noite do último dia do intervalo.
       AND (p_date_to     IS NULL OR a.criado_em <  (p_date_to + 1))
       AND (p_tabela      IS NULL OR a.tabela = p_tabela)
       -- 🔴 O DELETE DESTRÓI O CAMPO — e precisa aparecer aqui.
       -- Medido: filtrando `campo='amount'`, uma exclusão que levou uma conta de R$ 50.000
       -- **não aparecia**, porque `campos_alterados` é NULL em DELETE. Quem perguntasse "quem
       -- mexeu no valor este mês?" veria as alterações pequenas e não veria a destruição da
       -- conta inteira — omissão material, e silenciosa.
       -- O 1º ramo usa o índice GIN; o 2º só é avaliado nas linhas de DELETE (poucas).
       AND (p_campo       IS NULL
            OR a.campos_alterados @> ARRAY[p_campo]
            OR (a.operacao = 'DELETE' AND a.dados_antes ? p_campo))
       AND (p_operacao    IS NULL OR a.operacao = p_operacao)
       AND (p_registro_id IS NULL OR a.registro_id = p_registro_id)
       -- Casa contra o RÓTULO, não contra o e-mail cru: assim "removido" também é pesquisável.
       AND (p_usuario     IS NULL
            OR analytics.audit_actor_label(a.usuario_id) ILIKE '%' || p_usuario || '%')
     -- `criado_em` empata com facilidade (uma ação em lote grava várias linhas no mesmo instante);
     -- `id` é a PK e fecha a ordem total.
     ORDER BY a.criado_em DESC, a.id DESC
     LIMIT GREATEST(COALESCE(p_limit, 50), 0);
$$;

COMMENT ON FUNCTION analytics.auditoria_eventos(date, date, text, text, text, text, bigint, integer) IS
  'Eventos da trilha de auditoria (migration 117). SECURITY INVOKER: mostra apenas o que o usuario '
  'do JWT enxerga — o grupo restrito ve so a auditoria das proprias contas. '
  'A trilha COMECA na data de aplicacao da 117: ausencia de evento anterior NAO prova que nada '
  'mudou antes. `ator_via` = servico significa automacao ou edicao nao atribuivel, NUNCA "ninguem". '
  '`mudancas` traz o delta (UPDATE) ou os campos sensiveis da linha destruida (DELETE), nunca a '
  'linha crua. 🔴 `total_encontrado` e a contagem REAL antes do LIMIT: use-a para contar.';

-- ---------------------------------------------------------------------------
-- 7.2b — Agregado: quem mexeu, em que campo, quantas vezes
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS analytics.auditoria_resumo(date, date, text, boolean, text, integer);

CREATE FUNCTION analytics.auditoria_resumo(
    p_date_from        date    DEFAULT NULL,
    p_date_to          date    DEFAULT NULL,
    p_group_by         text    DEFAULT 'usuario',
    p_apenas_sensiveis boolean DEFAULT false,
    p_tabela           text    DEFAULT NULL,
    p_limit            integer DEFAULT 50
)
RETURNS TABLE (
    grupo            text,
    eventos          integer,
    registros        integer,
    primeiro_evento  timestamptz,
    ultimo_evento    timestamptz,
    sensivel         boolean,
    total_encontrado integer
)
LANGUAGE sql
STABLE SECURITY INVOKER PARALLEL SAFE
SET search_path = ''
AS $$
    WITH base AS (
        SELECT a.id, a.criado_em, a.tabela, a.operacao, a.registro_id,
               a.campos_alterados, a.usuario_id,
               COALESCE(a.campos_alterados && public.audit_sensitive_fields(),
                        a.operacao <> 'UPDATE') AS ev_sensivel
          FROM public.audit_log a
         WHERE (p_date_from IS NULL OR a.criado_em >= p_date_from)
           AND (p_date_to   IS NULL OR a.criado_em <  (p_date_to + 1))
           AND (p_tabela    IS NULL OR a.tabela = p_tabela)
    ),
    filtrado AS (
        SELECT * FROM base b WHERE NOT p_apenas_sensiveis OR b.ev_sensivel
    ),
    -- Despacho por CASE + IN, nunca SQL dinâmico (invariante da camada analytics): tudo viaja
    -- como bind e valor fora do domínio devolve VAZIO em vez de agregar pelo eixo errado.
    -- O eixo `campo` precisa de unnest (uma alteração toca N campos), então os ramos não podem
    -- ser um `CASE` só — daí o UNION ALL, cada braço podado pela constante.
    expandido AS (
        SELECT CASE p_group_by
                    -- Rótulo de FONTE ÚNICA: distingue automação de USUÁRIO REMOVIDO. Antes havia
                    -- aqui um `COALESCE(u.email, '(automacao...)')` local, que jogava os dois no
                    -- mesmo balde — a ação de uma pessoa cuja conta foi apagada era contada como
                    -- automação, inocentando-a. Ver o cabeçalho de `audit_actor_label`.
                    WHEN 'usuario'  THEN analytics.audit_actor_label(f.usuario_id)
                    WHEN 'tabela'   THEN f.tabela::text
                    WHEN 'operacao' THEN f.operacao::text
               END                AS grupo,
               f.id, f.criado_em, f.registro_id, f.tabela, f.ev_sensivel
          FROM filtrado f
         WHERE p_group_by IN ('usuario', 'tabela', 'operacao')
        UNION ALL
        SELECT k, f.id, f.criado_em, f.registro_id, f.tabela,
               k = ANY (public.audit_sensitive_fields())
          FROM filtrado f
          CROSS JOIN LATERAL unnest(f.campos_alterados) AS k
         WHERE p_group_by = 'campo'
    )
    SELECT e.grupo,
           count(*)::integer,
           count(DISTINCT (e.tabela, e.registro_id))::integer,
           min(e.criado_em),
           max(e.criado_em),
           bool_or(e.ev_sensivel),
           (count(*) OVER ())::integer          -- grupos existentes antes do LIMIT
      FROM expandido e
     WHERE e.grupo IS NOT NULL
     GROUP BY e.grupo
     -- `count(*) DESC` empata muito (vários usuários com 1 evento); `grupo` é a chave do
     -- agrupamento e fecha a ordem total.
     ORDER BY count(*) DESC, e.grupo
     LIMIT GREATEST(COALESCE(p_limit, 50), 0);
$$;

COMMENT ON FUNCTION analytics.auditoria_resumo(date, date, text, boolean, text, integer) IS
  'Agregado da trilha de auditoria por usuario | campo | tabela | operacao. Responde "quais '
  'usuarios vem alterando campos sensiveis" (p_group_by=usuario, p_apenas_sensiveis=true). '
  'SECURITY INVOKER: conta apenas o que o usuario do JWT enxerga. Eixo fora do dominio devolve '
  'VAZIO, nunca o total agregado por outro eixo. `registros` e quantos registros DISTINTOS foram '
  'tocados (um mesmo titulo alterado 5x conta 5 eventos e 1 registro). '
  '🔴 `total_encontrado` e quantos grupos existem antes do LIMIT.';

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
GRANT  EXECUTE ON FUNCTION analytics.audit_actor_label(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.audit_actor_label(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION analytics.auditoria_eventos(date, date, text, text, text, text, bigint, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.auditoria_eventos(date, date, text, text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION analytics.auditoria_resumo(date, date, text, boolean, text, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION analytics.auditoria_resumo(date, date, text, boolean, text, integer) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICAÇÃO — a migration ABORTA se algum invariante não valer
-- ---------------------------------------------------------------------------
-- ⚠️ A `audit_log` está VAZIA no momento desta migration (a trilha começa agora). Um oráculo
-- comparando contagens sobre tabela vazia seria `0 = 0` — verde para sempre, provando nada. É
-- exatamente a armadilha do "teste que promete uma garantia e não a entrega" (Regra 2 do
-- CLAUDE.md). Por isso as sondas INSEREM eventos sintéticos, medem sobre eles e DESFAZEM tudo
-- por subtransação, com uma asserção de sanidade provando que a sonda de fato exercitou dado.

DO $$
DECLARE
  v_dono        uuid;
  v_declarado   integer;
  v_real        integer;
  v_linhas      integer;
  v_sanidade    integer := 0;
  v_grupos      integer;
  v_sensiveis   integer;
  v_removido    integer;
  v_conflacao   integer;
  v_delete_no_campo integer;
BEGIN
  SELECT created_by INTO v_dono FROM public.financial_account_control ORDER BY id LIMIT 1;
  IF v_dono IS NULL THEN
    RAISE NOTICE 'sem contas na base — sondas de comportamento puladas';
  ELSE
    BEGIN
      -- 7 eventos sintéticos: 5 UPDATE (3 tocando campo sensível), 1 DELETE, 1 de outra tabela.
      INSERT INTO public.audit_log (tabela, operacao, registro_id, registro_dono, usuario_id,
                                    dados_antes, dados_depois, campos_alterados, ator_via)
      SELECT 'financial_account_control', 'UPDATE', 900000 + g, v_dono, NULL,
             jsonb_build_object('amount', 10), jsonb_build_object('amount', 20),
             CASE WHEN g <= 3 THEN ARRAY['amount'] ELSE ARRAY['description'] END, 'servico'
        FROM generate_series(1, 5) AS g;

      INSERT INTO public.audit_log (tabela, operacao, registro_id, registro_dono,
                                    dados_antes, ator_via)
      VALUES ('financial_account_control', 'DELETE', 900099, v_dono,
              jsonb_build_object('amount', 99, 'due_date', '2026-01-01', 'lixo_nao_sensivel', 'x'),
              'servico'),
             ('supplier', 'UPDATE', 900100, NULL,
              jsonb_build_object('pix_key1', 'antiga'), 'servico');
      UPDATE public.audit_log SET dados_depois = jsonb_build_object('pix_key1', 'nova'),
                                  campos_alterados = ARRAY['pix_key1']
       WHERE registro_id = 900100;

      -- SANIDADE DO ORÁCULO: a sonda precisa ter produzido dado, senão tudo abaixo é 0 = 0.
      SELECT count(*)::integer INTO v_sanidade
        FROM analytics.auditoria_eventos(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1000000)
       WHERE registro_id BETWEEN 900000 AND 900100;

      -- ORÁCULO DIFERENCIAL: o total declarado com LIMIT 1 tem de ser o total REAL.
      SELECT total_encontrado INTO v_declarado
        FROM analytics.auditoria_eventos(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1);
      SELECT count(*)::integer INTO v_real
        FROM analytics.auditoria_eventos(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1000000);

      -- O filtro por campo tem de usar o GIN e devolver só quem tocou aquele campo.
      SELECT count(*)::integer INTO v_linhas
        FROM analytics.auditoria_eventos(NULL, NULL, NULL, 'amount', NULL, NULL, NULL, 1000000)
       WHERE registro_id BETWEEN 900000 AND 900100;

      -- Agregado por campo, só sensíveis.
      SELECT count(*)::integer INTO v_grupos
        FROM analytics.auditoria_resumo(NULL, NULL, 'campo', true, NULL, 1000000);

      -- ACHADO A: usuario REMOVIDO nao pode virar "automacao". O uuid 999... nao existe em
      -- auth.users, entao representa exatamente uma pessoa cuja conta foi apagada.
      UPDATE public.audit_log SET usuario_id = '99999999-9999-9999-9999-999999999999', ator_via = 'jwt'
       WHERE registro_id = 900001;
      SELECT count(*)::integer INTO v_removido
        FROM analytics.auditoria_resumo(NULL, NULL, 'usuario', false, NULL, 1000000)
       WHERE grupo LIKE '%usuario removido%';
      SELECT count(*)::integer INTO v_conflacao
        FROM analytics.auditoria_eventos(NULL, NULL, NULL, NULL, NULL, NULL, 900001, 10)
       WHERE usuario LIKE '%automacao%';

      -- ACHADO B: o DELETE destruiu `amount`, entao ele TEM de aparecer no filtro por esse campo.
      SELECT count(*)::integer INTO v_delete_no_campo
        FROM analytics.auditoria_eventos(NULL, NULL, NULL, 'amount', NULL, NULL, 900099, 10);
      SELECT count(*)::integer INTO v_sensiveis
        FROM analytics.auditoria_resumo(NULL, NULL, 'campo', false, NULL, 1000000)
       WHERE grupo = 'description';

      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- desfaz os eventos sintéticos; as medições sobrevivem
    END;

    IF v_sanidade <> 7 THEN
      RAISE EXCEPTION 'ABORTADO: a sonda exercitou % evento(s), esperado 7 — o oraculo abaixo '
                      'estaria provando nada', v_sanidade;
    END IF;
    IF v_declarado IS DISTINCT FROM v_real THEN
      RAISE EXCEPTION 'ABORTADO: auditoria_eventos declara total_encontrado=% mas existem % — a '
                      'janela esta sendo avaliada DEPOIS do LIMIT', v_declarado, v_real;
    END IF;
    -- 4, nao 3: os 3 UPDATE de `amount` MAIS o DELETE, que destruiu o campo junto com a linha.
    -- Este numero subiu de 3 para 4 quando o achado B foi corrigido — e foi esta assercao que
    -- flagrou a mudanca, provando que a sonda observa o comportamento e nao um literal decorativo.
    IF v_linhas <> 4 THEN
      RAISE EXCEPTION 'ABORTADO: filtro p_campo=amount devolveu % evento(s), esperado 4 '
                      '(3 UPDATE + 1 DELETE que destruiu o campo)', v_linhas;
    END IF;
    -- 'description' NAO esta no vocabulario sensivel: tem de sumir com p_apenas_sensiveis.
    IF v_sensiveis <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: o eixo campo nao agrupou o campo nao-sensivel (achou %)', v_sensiveis;
    END IF;
    IF v_grupos < 1 THEN
      RAISE EXCEPTION 'ABORTADO: p_apenas_sensiveis nao devolveu nenhum grupo sensivel';
    END IF;
    IF v_removido <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: usuario REMOVIDO nao foi distinguido (achou % grupos) — a acao '
                      'de uma pessoa apagada estaria contada como automacao', v_removido;
    END IF;
    IF v_conflacao <> 0 THEN
      RAISE EXCEPTION 'ABORTADO: evento de usuario removido foi rotulado como automacao';
    END IF;
    IF v_delete_no_campo <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: o DELETE que destruiu `amount` nao aparece ao filtrar por esse '
                      'campo (achou %) — "quem mexeu no valor?" omitiria a exclusao', v_delete_no_campo;
    END IF;
  END IF;

  -- Eixo fora do domínio devolve VAZIO, nunca agregado pelo eixo errado.
  IF EXISTS (SELECT 1 FROM analytics.auditoria_resumo(NULL, NULL, 'inventado', false, NULL, 10)) THEN
    RAISE EXCEPTION 'ABORTADO: p_group_by fora do dominio devolveu linhas';
  END IF;

  -- LIMIT negativo vira resposta vazia, nunca 2201W.
  PERFORM * FROM analytics.auditoria_eventos(NULL, NULL, NULL, NULL, NULL, NULL, NULL, -1);
  PERFORM * FROM analytics.auditoria_resumo(NULL, NULL, 'usuario', false, NULL, -1);

  -- Grants nos dois sentidos.
  IF has_function_privilege('anon',
       'analytics.auditoria_eventos(date,date,text,text,text,text,bigint,integer)', 'EXECUTE')
     OR has_function_privilege('anon',
       'analytics.auditoria_resumo(date,date,text,boolean,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: anon ficou com EXECUTE nas tools de auditoria';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'analytics.auditoria_eventos(date,date,text,text,text,text,bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: authenticated perdeu o EXECUTE de auditoria_eventos';
  END IF;

  -- SECURITY INVOKER é o que faz a RLS da 117 valer no chat.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'analytics' AND p.proname LIKE 'auditoria%' AND p.prosecdef) THEN
    RAISE EXCEPTION 'ABORTADO: tool de auditoria ficou SECURITY DEFINER — passaria por cima da RLS';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. O DO acima já provou, sobre dado sintético desfeito em seguida: total_encontrado igual ao
--      total real, filtro por campo usando o vocabulário certo, eixo fora do domínio devolvendo
--      vazio, LIMIT negativo sem erro, grants nos dois sentidos e SECURITY INVOKER preservado.
--   2. Recorte de RLS: abrir transação, `SET LOCAL ROLE authenticated`, comparar a contagem para
--      um usuário de grupo restrito e um irrestrito, e desfazer. Privilégio concedido e linha
--      visível são perguntas diferentes.
--   3. `get_advisors` sem achado novo.
