-- 120_ai_chat_gate_por_grupo.sql
--
-- ONDA 8 (item 8.3) — docs/roadmap-enriquecimento-dados.md §4
-- Gate de uso do chat de IA. Hoje QUALQUER sessao autenticada usa o assistente: o widget e
-- montado sem condicao no Layout e a rota /api/ai-chat so exige um usuario valido. O unico teto e
-- o rate limit GLOBAL da Onda 1 (30/h, 150/dia), igual para todo mundo. Nao existe resposta para
-- "este grupo nao deve usar IA" nem para "este grupo pode, mas com menos folga".
--
-- Guardas deste arquivo: tests/test_onda8_gate_ia.py.
--
-- ---------------------------------------------------------------------------
-- O QUE ESTE ARQUIVO CRIA
-- ---------------------------------------------------------------------------
--   1) public.user_group.ai_chat_enabled          — acesso ao chat (DEFAULT false = opt-in)
--   2) public.user_group.ai_chat_limit_per_hour   — cota propria do grupo (NULL = teto do .env)
--   3) public.user_group.ai_chat_limit_per_day    — idem
--   4) CHECK chk_user_group_ai_chat_limits        — dominio dos dois limites
--   5) semente: Administrador (1), Diretor (2) e Financeiro (7) ja saem habilitados
--
-- ---------------------------------------------------------------------------
-- POR QUE POR GRUPO, E NAO POR USUARIO
-- ---------------------------------------------------------------------------
-- Espelha `sees_only_own_accounts` (migration 076), que e o padrao ja estabelecido para "flag de
-- comportamento por grupo". Sao 9 grupos contra 13 usuarios, e o vinculo usuario -> grupo ja
-- existe e ja e mantido (public.user_profile, migration 065).
--
-- 🔴 AS DUAS FLAGS DE `user_group` SAO ORTOGONAIS — nao confundir, nem "unificar":
--   `sees_only_own_accounts` = quais LINHAS o usuario enxerga (visibilidade, imposta pela RLS)
--   `ai_chat_enabled`        = se ele pode CHAMAR uma feature paga (autorizacao, imposta na API)
-- Um grupo pode ver tudo e mesmo assim nao usar o chat, e vice-versa.
--
-- Alternativa REJEITADA — override por usuario (`user_profile.ai_chat_enabled` com COALESCE):
-- criaria uma segunda fonte de verdade e uma regra de precedencia para manter, sem nenhum caso
-- real que a justifique hoje. Se um dia existir, a resolucao entra em UM lugar so — o
-- `lib/ai-chat/gate.ts` —, nunca dividida entre TS e SQL.
--
-- ---------------------------------------------------------------------------
-- POR QUE OPT-IN (DEFAULT false), AO CONTRARIO DA 076
-- ---------------------------------------------------------------------------
-- A 076 usou `DEFAULT false` para "nao restringir quem ja trabalhava". Aqui o default seguro e o
-- INVERSO — negar —, porque o recurso protegido custa dinheiro por uso: grupo novo nascer com
-- acesso a Claude API sem ninguem ter decidido isso e exatamente o modo de falha a evitar.
--
-- A semente impede que "seguro" vire "quebrado": medido em 2026-08-12, o `analytics.ai_chat_log`
-- tem 8 interacoes de 2 usuarios, dos grupos 1 (Administrador) e 2 (Diretor). Liberando 1, 2 e 7
-- (Financeiro, o time dono do processo), ninguem que ja usava perde acesso — e a SONDA P1 abaixo
-- transforma essa afirmacao em condicao de aborto, em vez de deixa-la como esperanca.
--
-- 🔴 O Comercial (grupo 6) fica DELIBERADAMENTE de fora, e nao e so permissao: ele carrega
-- `sees_only_own_accounts`, entao o chat responderia sobre uma fatia (~48 contas) enquanto um
-- colega ve 578 — a mesma pergunta com totais diferentes, e o modelo nao tem como dizer por que.
-- Se um dia entrar, entra JUNTO com uma linha no SYSTEM_PROMPT declarando o recorte.
--
-- ---------------------------------------------------------------------------
-- POR QUE NAO HA FUNCAO HELPER NEM POLICY NOVA AQUI
-- ---------------------------------------------------------------------------
-- A tentacao e criar um `auth_group_ai_chat_enabled()` espelhando o `auth_group_sees_only_own()`
-- da 076. Seria peso morto:
--   (a) RLS responde "quais LINHAS este papel le"; o gate responde "este usuario pode chamar o
--       endpoint". Nao existe tabela cujas linhas devam sumir porque o chat esta desligado — o
--       proprio `analytics.ai_chat_log` continua precisando da policy que ja tem, inclusive para o
--       usuario NEGADO ler as proprias tentativas.
--   (b) Quem le e o `lib/ai-chat/gate.ts`, com service_role. Uma funcao SECURITY DEFINER baseada
--       em `auth.uid()` seria INALCANCAVEL pelo unico chamador.
--   (c) Viraria mais um SECURITY DEFINER que os advisors apontam e que ninguem consegue provar que
--       e morto — o caso do helper da 076, que o README registra como impossivel de revogar.
-- Por isso este arquivo NAO emite GRANT/REVOKE: ele nao cria funcao nem objeto novo, so acrescenta
-- coluna a uma tabela cujos privilegios ja estao corretos (SELECT para authenticated, escrita so
-- para service_role). A regra de emitir os dois sentidos continua valendo para a proxima migration
-- que criar funcao.
--
-- Alternativa REJEITADA — teto de CUSTO em tokens: exigiria somar `input_tokens + output_tokens`
-- por periodo, o que NAO e index-only (o `ix_ai_chat_log_user_created` cobre o predicado, nao o
-- payload), pediria politica propria de falha e, com 8 linhas de historico, nao ha base para
-- calibrar numero nenhum. Gatilho para reabrir: um unico usuario passar de ~1M tokens/dia, medido.
--
-- IDEMPOTENTE. Reexecutar e no-op: as colunas usam ADD COLUMN IF NOT EXISTS, o CHECK e criado
-- dentro de um DO guardado por pg_constraint (ADD CONSTRAINT nao aceita IF NOT EXISTS), a semente
-- e um UPDATE aditivo e as sondas do DO final desfazem tudo o que escrevem.

-- ---------------------------------------------------------------------------
-- 1) COLUNAS
-- ---------------------------------------------------------------------------

ALTER TABLE public.user_group
  ADD COLUMN IF NOT EXISTS ai_chat_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_chat_limit_per_hour smallint,
  ADD COLUMN IF NOT EXISTS ai_chat_limit_per_day  smallint;

-- ---------------------------------------------------------------------------
-- 2) DOMINIO DOS LIMITES
-- ---------------------------------------------------------------------------
-- 🔴 O `> 0` repete DE PROPOSITO a defesa que o `readLimit` (lib/ai-chat/rate-limit.ts) ja faz do
-- lado do TS: um limite **0** torna `count >= 0` sempre verdadeiro e devolve 429 para todos os
-- usuarios do grupo — o chat inteiro fora do ar, sem erro nenhum no caminho. Com a cota podendo
-- vir do banco, o banco passou a ser uma segunda fonte dessa constante e precisa da mesma trava.
--
-- O `per_day >= per_hour` bloqueia uma configuracao que esta errada SEM NUNCA dar erro: com o
-- teto diario abaixo do horario, o horario e inalcancavel e o operador acha que configurou algo
-- que nao vale.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_group_ai_chat_limits'
  ) THEN
    ALTER TABLE public.user_group
      ADD CONSTRAINT chk_user_group_ai_chat_limits CHECK (
            (ai_chat_limit_per_hour IS NULL OR ai_chat_limit_per_hour > 0)
        AND (ai_chat_limit_per_day  IS NULL OR ai_chat_limit_per_day  > 0)
        AND (ai_chat_limit_per_hour IS NULL OR ai_chat_limit_per_day IS NULL
             OR ai_chat_limit_per_day >= ai_chat_limit_per_hour)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.user_group.ai_chat_enabled IS
  'O grupo pode usar o assistente de IA? DEFAULT false (opt-in) porque o recurso e pago. '
  'Imposto no SERVIDOR por lib/ai-chat/gate.ts; o gate de UI (Layout) e cosmetico. '
  'ORTOGONAL a sees_only_own_accounts: aquela e visibilidade de linha, esta e acesso a feature.';

COMMENT ON COLUMN public.user_group.ai_chat_limit_per_hour IS
  'Cota horaria propria do grupo. NULL = usa AI_CHAT_RATE_LIMIT_PER_HOUR do ambiente. '
  'Zero e proibido pelo CHECK: zeraria o chat do grupo inteiro sem erro visivel.';

COMMENT ON COLUMN public.user_group.ai_chat_limit_per_day IS
  'Cota diaria propria do grupo. NULL = usa AI_CHAT_RATE_LIMIT_PER_DAY do ambiente. '
  'O CHECK exige >= a cota horaria: abaixo dela, a horaria seria inalcancavel.';

-- ---------------------------------------------------------------------------
-- 3) SEMENTE
-- ---------------------------------------------------------------------------
-- 🔴 A forma importa. `SET ai_chat_enabled = true WHERE group_id IN (...)` e ADITIVA: reexecutar
-- nao mexe em quem foi liberado depois, a mao. A forma alternativa
-- `SET ai_chat_enabled = (group_id IN (...))` tambem seria "idempotente" no sentido ingenuo — e
-- REVOGARIA em silencio todo grupo habilitado apos a aplicacao. Essa e a metade nao-obvia de
-- idempotencia aqui, e a razao de nao aceitar a versao "mais elegante".

UPDATE public.user_group
   SET ai_chat_enabled = true
 WHERE group_id IN (1, 2, 7)
   AND ai_chat_enabled IS DISTINCT FROM true;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICACAO — a migration ABORTA se qualquer invariante nao valer
-- ---------------------------------------------------------------------------
-- Padrao das 116/117/118. As sondas que escrevem rodam dentro de BEGIN..EXCEPTION (subtransacao)
-- e terminam levantando excecao de proposito; as variaveis plpgsql NAO sao transacionais, entao o
-- resultado medido sobrevive ao rollback. Nada fica na base (a Supabase e compartilhada dev+prod).
--
-- ⚠️ A SONDA P2 avanca a sequence IDENTITY de `user_group` de forma PERMANENTE — sequence nao e
-- transacional, entao o rollback devolve a linha mas nao o numero. Inocuo (nao ha requisito de
-- numeracao sem buracos), mas registrado aqui para nao ser lido como vazamento por quem revisar.

DO $$
DECLARE
  v_grupos          integer;
  v_habilitados     integer;
  v_historico       integer;
  v_sem_acesso      integer;
  v_novo_default    boolean;
  v_check           text := 'ACEITOU';
  v_usuario_real    uuid;
  v_uid_efetivo     uuid;
  v_ui_enxerga      integer := -1;
  v_escrita         text := 'nao executada';
  v_linhas          integer := -1;
  v_p4_executou     boolean := false;
  v_col_default     text;
  v_cols            integer;
  -- Usuarios cuja perda de acesso e DELIBERADA. Vazio de proposito: qualquer nome aqui e uma
  -- decisao explicita de revogar, nao um jeito de fazer a sonda passar.
  v_revogacao_deliberada uuid[] := ARRAY[]::uuid[];
BEGIN
  -- SONDA P0: anti-vacuidade. Sem grupo, ou sem nenhum habilitado, todas as sondas abaixo
  -- passariam medindo o vazio.
  SELECT count(*)::integer INTO v_grupos      FROM public.user_group;
  SELECT count(*)::integer INTO v_habilitados FROM public.user_group WHERE ai_chat_enabled;

  IF v_grupos = 0 THEN
    RAISE EXCEPTION 'ABORTADO: public.user_group esta vazia — a semente nao teria onde pegar';
  END IF;
  IF v_habilitados = 0 THEN
    RAISE EXCEPTION 'ABORTADO: nenhum grupo ficou habilitado — a semente nao pegou';
  END IF;

  -- SONDA P1 🔴: ninguem que JA USOU o chat pode perder acesso. Esta e a sonda mais valiosa do
  -- arquivo: ela pega uma semente errada AQUI, em vez de em producao, no dia seguinte, como
  -- "o assistente sumiu para o fulano".
  -- Usuario sem perfil cai no grupo 0 (sentinela), que nao esta na semente => contaria como
  -- perda de acesso, corretamente.
  SELECT count(DISTINCT user_id)::integer INTO v_historico FROM analytics.ai_chat_log;

  IF v_historico = 0 THEN
    RAISE NOTICE 'ai_chat_gate: sem historico em analytics.ai_chat_log — sonda P1 pulada';
  ELSE
    SELECT count(*)::integer INTO v_sem_acesso
      FROM (SELECT DISTINCT user_id FROM analytics.ai_chat_log) l
      LEFT JOIN public.user_profile p ON p.user_id = l.user_id
      LEFT JOIN public.user_group   g ON g.group_id = p.group_id
     WHERE coalesce(g.ai_chat_enabled, false) = false
       AND NOT (l.user_id = ANY (v_revogacao_deliberada));

    IF v_sem_acesso > 0 THEN
      RAISE EXCEPTION 'ABORTADO: % usuario(s) que ja usaram o chat ficariam sem acesso — '
                      'revise a semente do passo 3', v_sem_acesso;
    END IF;
  END IF;

  -- SONDA P2: o default e DENY. Grupo novo nasce SEM acesso ao recurso pago.
  BEGIN
    INSERT INTO public.user_group (group_name) VALUES ('sonda-120')
    RETURNING ai_chat_enabled INTO v_novo_default;
    RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;   -- desfaz a sonda; a variavel medida permanece
  END;

  IF v_novo_default IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORTADO: grupo NOVO nasceu com ai_chat_enabled = % — o default deveria '
                    'ser DENY', v_novo_default;
  END IF;

  -- SONDA P3: o CHECK morde. Ausencia de excecao e FALHA, nao aprovacao.
  BEGIN
    UPDATE public.user_group SET ai_chat_limit_per_hour = 0 WHERE group_id = 0;
    v_check := 'ACEITOU';
    RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN v_check := 'ok';
    WHEN raise_exception THEN NULL;
  END;

  IF v_check <> 'ok' THEN
    RAISE EXCEPTION 'ABORTADO: limite 0 foi aceito — reproduziria o bug que o readLimit evita '
                    '(429 para o grupo inteiro, sem erro)';
  END IF;

  -- SONDA P4 🔴: comportamento sob o PAPEL REAL. Privilegio concedido e linha visivel sao
  -- perguntas diferentes (licao da 117), e as duas importam aqui:
  --   (a) `authenticated` PRECISA enxergar a coluna — e dela que o gate de UI se alimenta;
  --   (b) `authenticated` NAO pode escreve-la, senao o usuario liga o proprio acesso.
  SELECT id INTO v_usuario_real FROM auth.users ORDER BY created_at LIMIT 1;

  IF v_usuario_real IS NULL THEN
    RAISE NOTICE 'ai_chat_gate: sem usuarios em auth.users — sonda P4 pulada';
  ELSE
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', v_usuario_real, 'role', 'authenticated')::text,
                         true);

      -- Anti-vacuidade: claims malformadas zerariam TODA contagem abaixo e a sonda "provaria"
      -- um comportamento que na verdade e um JWT quebrado.
      v_uid_efetivo := auth.uid();

      -- (a) exatamente o que o AuthContext faz: proprio perfil + flag do grupo.
      SELECT count(*)::integer INTO v_ui_enxerga
        FROM public.user_profile p
        JOIN public.user_group   g ON g.group_id = p.group_id
       WHERE p.user_id = auth.uid()
         AND g.ai_chat_enabled IS NOT NULL;

      -- (b) tentativa de auto-concessao.
      BEGIN
        UPDATE public.user_group SET ai_chat_enabled = true WHERE group_id = 0;
        GET DIAGNOSTICS v_linhas = ROW_COUNT;
        v_escrita := 'SEM ERRO';
      EXCEPTION WHEN insufficient_privilege THEN
        v_escrita := 'negada';
        v_linhas  := 0;
      END;

      v_p4_executou := true;
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- desfaz a sonda e devolve o papel anterior
    END;

    IF NOT v_p4_executou THEN
      RAISE EXCEPTION 'ABORTADO: a sonda P4 nao chegou ao fim — excecao inesperada sob o papel '
                      'authenticated deixaria as assercoes abaixo sem avaliar';
    END IF;
    IF v_uid_efetivo IS DISTINCT FROM v_usuario_real THEN
      RAISE EXCEPTION 'ABORTADO: auth.uid() = % sob claims de % — a sonda mediria o vazio',
        v_uid_efetivo, v_usuario_real;
    END IF;
    IF v_ui_enxerga < 1 THEN
      RAISE EXCEPTION 'ABORTADO: authenticated nao enxerga ai_chat_enabled pelo proprio perfil — '
                      'o gate de UI ficaria cego e esconderia o widget de todo mundo';
    END IF;
    -- 🔴 `v_linhas = 0` conta como negado: quando a RLS filtra, o UPDATE afeta zero linhas e NAO
    -- levanta nada. Sem este ramo, a sonda concluiria "nao escreve" a partir de ausencia de
    -- evidencia — e continuaria verde no dia em que alguem concedesse UPDATE de verdade.
    IF v_escrita = 'SEM ERRO' AND v_linhas > 0 THEN
      RAISE EXCEPTION 'ABORTADO: authenticated conseguiu ligar o proprio acesso (% linha(s)) — '
                      'o gate seria auto-concedivel', v_linhas;
    END IF;
  END IF;

  -- SONDA P5: estrutura declarada no catalogo.
  SELECT count(*)::integer INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_group'
     AND column_name IN ('ai_chat_enabled', 'ai_chat_limit_per_hour', 'ai_chat_limit_per_day');

  IF v_cols <> 3 THEN
    RAISE EXCEPTION 'ABORTADO: esperava 3 colunas do gate no catalogo, achei %', v_cols;
  END IF;

  SELECT column_default INTO v_col_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'user_group'
     AND column_name = 'ai_chat_enabled';

  IF v_col_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ABORTADO: ai_chat_enabled com DEFAULT % — o opt-in depende de DEFAULT false',
      coalesce(v_col_default, '<nenhum>');
  END IF;

  -- Nota, nao asserção: `anon` ja tinha SELECT em public.user_group ANTES desta migration (residuo
  -- que a 097 deixou de proposito por ser inocuo — sem policy para anon, a RLS devolve 0 linhas).
  -- Abortar por causa disso puniria a 120 por um estado que ela nao criou.
  IF has_table_privilege('anon', 'public.user_group', 'SELECT') THEN
    RAISE NOTICE 'ai_chat_gate: anon mantem SELECT em user_group (estado pre-existente, sem policy '
                 'para anon => 0 linhas). Nada a fazer aqui.';
  END IF;

  RAISE NOTICE 'ai_chat_gate OK: % grupo(s), % habilitado(s), % usuario(s) no historico',
    v_grupos, v_habilitados, v_historico;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICACAO (apos aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
-- 1. Consultar `user_group` e conferir que os grupos 1, 2 e 7 estao com ai_chat_enabled = true e
--    os demais false, com os dois limites nulos.
-- 2. Conferir pelo PostgREST (nao so por SQL) que o cache de schema ja enxerga a coluna: um
--    select de `user_group` pedindo `ai_chat_enabled` tem de responder 200 com o campo. Enquanto
--    o cache estiver velho o gate.ts falha ao ler e, sendo fail-closed, derruba o chat para todos.
-- 3. A ordem de implantacao e obrigatoria: migration -> conferir o cache -> deploy da Next API ->
--    deploy da SPA. API antes da migration = coluna inexistente = chat fora do ar.
