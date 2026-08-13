-- 122_roadmap_trigger_snapshot.sql
--
-- SERIE HISTORICA DOS GATILHOS DO ROADMAP (Onda 9 — docs/roadmap-enriquecimento-dados.md §4).
--
-- ---------------------------------------------------------------------------
-- POR QUE UMA TABELA, E NAO UM ARQUIVO NA MAQUINA QUE MEDE
-- ---------------------------------------------------------------------------
-- A Onda 9 e condicional: cada item so entra quando o gatilho dele ocorre. A medicao de
-- 2026-08-13 mostrou 1 de 7 disparado — e o valor de repetir a medicao NAO esta no alerta (nenhum
-- gatilho vira de um mes para o outro), esta na SERIE: ver NFS-e ir de 1 para 3 e para 8 e o que
-- antecipa a decisao; uma medicao isolada nao diz nada, e duas medicoes em arquivos soltos na
-- maquina que rodou nao formam serie nenhuma.
--
-- Por isso a serie vive no banco: sobrevive a reinstalacao da maquina agendada, e responde
-- "como isto evoluiu?" de qualquer lugar — inclusive de um SELECT do proprio Ricardo.
--
-- ---------------------------------------------------------------------------
-- 🔴 IDEMPOTENCIA E A CARACTERISTICA CENTRAL, NAO UM DETALHE
-- ---------------------------------------------------------------------------
-- A UNIQUE `(trigger_key, measured_on)` faz a medicao ser um UPSERT por DIA. Sem ela, rodar o
-- script duas vezes no mesmo dia — o que acontece o tempo todo (teste manual, reexecucao apos
-- falha de rede, tarefa disparada duas vezes) — criaria pontos duplicados, e qualquer grafico ou
-- media sobre a serie passaria a mentir sem nenhum erro no caminho. Com ela, medir de novo
-- CORRIGE o ponto do dia em vez de acrescentar um.
--
-- ---------------------------------------------------------------------------
-- 🔴 O DOMINIO DAS CHAVES E FECHADO, DE PROPOSITO
-- ---------------------------------------------------------------------------
-- O CHECK impede que um erro de digitacao no script crie uma serie ORFA: `text_to_sqll` seria
-- aceito por uma coluna livre, gravaria feliz por meses e ninguem notaria — a serie certa
-- simplesmente pararia de crescer, em silencio. Com o dominio fechado, o erro aparece na primeira
-- execucao. O custo (uma migration quando surgir gatilho novo) e proporcional: o roadmap muda
-- raramente, e mudar o roadmap ja e um ato deliberado.
--
-- IDEMPOTENTE: `CREATE TABLE IF NOT EXISTS`, indice e policies guardados, e o DO final desfaz
-- tudo o que escreve.

CREATE TABLE IF NOT EXISTS analytics.roadmap_trigger_snapshot (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Data LOCAL (America/Sao_Paulo), nao UTC: a medicao rodando 21h de um dia e 22h do outro
    -- cairia no MESMO dia UTC e a segunda sobrescreveria a primeira. E o fuso do negocio.
    measured_on date        NOT NULL DEFAULT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
    -- 🔴 `clock_timestamp()`, nao `now()`: `now()` e o instante em que a TRANSACAO comecou, e o
    -- que esta coluna quer dizer e "quando esta medicao foi gravada". A diferenca e invisivel no
    -- INSERT solto, mas decide duas coisas: (a) no UPSERT, `now()` daria ao UPDATE o mesmo valor
    -- do INSERT original, tornando o carimbo indistinguivel de nao ter sido tocado; (b) por isso
    -- mesmo, o invariante ficaria IMPROVAVEL por construcao — a sonda P4b nao teria como
    -- diferenciar "a trigger funcionou" de "a trigger nao existe".
    measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    trigger_key text        NOT NULL,
    -- O veredito do script, conforme o criterio abaixo. Booleano, e nao um "score": a pergunta
    -- que o roadmap faz e binaria — implementar o item ou nao.
    fired       boolean     NOT NULL,
    -- Os numeros crus que sustentaram o veredito. jsonb porque cada gatilho mede coisas
    -- diferentes (contagem, latencia, dias de historico) e uma coluna por metrica viraria uma
    -- tabela esparsa que muda a cada onda.
    metrics     jsonb       NOT NULL,
    -- 🔴 O CRITERIO aplicado, gravado JUNTO do resultado. Sem ele, um `fired = false` de 2026 fica
    -- inauditavel em 2027, quando o limiar do script ja tiver mudado: nao daria para saber se o
    -- gatilho nao ocorreu ou se a regua era outra. E a mesma razao de `ai_chat_log` guardar a
    -- pergunta, e nao so a resposta.
    criterion   text        NOT NULL,
    CONSTRAINT uq_roadmap_trigger_snapshot UNIQUE (trigger_key, measured_on),
    CONSTRAINT chk_roadmap_trigger_key CHECK (trigger_key IN (
        'dpo_pontualidade',      -- ja disparado (Onda 9, migration 121) — segue medido
        'cfe_nfce',
        'nfse',
        'text_to_sql',
        'tabelas_agregadas',
        'receitas_dre',
        'conciliacao_bancaria'
    ))
);

COMMENT ON TABLE analytics.roadmap_trigger_snapshot IS
  'Serie historica dos 7 gatilhos condicionais da Onda 9 (docs/roadmap-enriquecimento-dados.md). '
  'Uma linha por gatilho por dia de medicao — UPSERT, entao remedir no mesmo dia corrige o ponto '
  'em vez de duplicar. Escrita so por service_role (o script agendado); leitura por authenticated. '
  '🔴 `criterion` guarda a regua aplicada NAQUELA medicao: sem ela, um veredito antigo fica '
  'inauditavel quando o limiar do script mudar.';

COMMENT ON COLUMN analytics.roadmap_trigger_snapshot.metrics IS
  'Numeros crus que sustentaram o veredito, no formato de cada gatilho. Guardar o cru (e nao so o '
  'booleano) e o que permite ver TENDENCIA — 1 -> 3 -> 8 antecipa a decisao; tres "false" nao.';

-- ---------------------------------------------------------------------------
-- 🔴 `measured_at` PRECISA DE TRIGGER — o DEFAULT nao alcanca o UPSERT
-- ---------------------------------------------------------------------------
-- Achado da autorrevisao adversarial, reproduzido antes de existir esta trigger: na SEGUNDA
-- medicao do mesmo dia, `metrics` era atualizado e `measured_at` ficava congelado no horario da
-- PRIMEIRA. Motivo: `DEFAULT now()` so vale no INSERT, e o UPSERT do PostgREST atualiza apenas as
-- colunas ENVIADAS — o script nao manda `measured_at` de proposito, para que o relogio seja
-- sempre o do banco.
--
-- O efeito era pequeno e mudo, que e o pior tipo: a coluna cuja unica funcao e dizer QUANDO se
-- mediu passaria a informar o horario de outra medicao. Mandar o timestamp pelo cliente
-- resolveria tambem, ao custo de fazer a serie depender do relogio da maquina agendada.
CREATE OR REPLACE FUNCTION analytics.fn_roadmap_snapshot_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- `clock_timestamp()` pelo mesmo motivo do DEFAULT: e o instante REAL da gravacao, nao o do
  -- inicio da transacao. Com `now()` este carimbo seria igual ao do INSERT que ele deveria
  -- substituir — e a sonda P4b, abaixo, nao conseguiria provar que a trigger disparou.
  NEW.measured_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Reexecucao sobre tabela ja criada: `CREATE TABLE IF NOT EXISTS` NAO altera coluna existente,
-- entao o DEFAULT novo precisa deste ALTER — sem ele a migration passaria verde deixando o banco
-- com o default antigo, que e a pior combinacao (arquivo e realidade discordando em silencio).
ALTER TABLE analytics.roadmap_trigger_snapshot
    ALTER COLUMN measured_at SET DEFAULT clock_timestamp();

DROP TRIGGER IF EXISTS trg_roadmap_snapshot_touch ON analytics.roadmap_trigger_snapshot;
CREATE TRIGGER trg_roadmap_snapshot_touch
    BEFORE UPDATE ON analytics.roadmap_trigger_snapshot
    FOR EACH ROW EXECUTE FUNCTION analytics.fn_roadmap_snapshot_touch();

-- A consulta natural e "a serie deste gatilho, do mais recente para tras".
CREATE INDEX IF NOT EXISTS ix_roadmap_trigger_snapshot_key_date
    ON analytics.roadmap_trigger_snapshot (trigger_key, measured_on DESC);

ALTER TABLE analytics.roadmap_trigger_snapshot ENABLE ROW LEVEL SECURITY;

-- Leitura para qualquer sessao autenticada: e dado de PLANEJAMENTO do produto, sem PII e sem
-- valor financeiro — nao ha recorte por dono a aplicar aqui, ao contrario da fato.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'analytics' AND tablename = 'roadmap_trigger_snapshot'
       AND policyname = 'authenticated_select_roadmap_trigger'
  ) THEN
    CREATE POLICY "authenticated_select_roadmap_trigger"
      ON analytics.roadmap_trigger_snapshot FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- 🔴 O `service_role` PRECISA de GRANT explicito — ele burla RLS (`rolbypassrls`) mas NAO e
-- superuser. Foi exatamente isto que a migration 101 teve de corrigir na `ai_chat_log`: a 098
-- concedeu tudo a `authenticated` e NADA a quem escreve, e como o gravador engolia a propria
-- falha, a trilha teria ficado morta em producao sem nenhum sintoma. Aqui o UPDATE tambem entra,
-- porque a gravacao e UPSERT.
GRANT USAGE ON SCHEMA analytics TO service_role;
GRANT SELECT, INSERT, UPDATE ON analytics.roadmap_trigger_snapshot TO service_role;
GRANT SELECT ON analytics.roadmap_trigger_snapshot TO authenticated;

-- 🔴 EXCECAO DELIBERADA: o medidor agendado roda com service_role e precisa da data de corte do
-- backfill para medir o gatilho da pontualidade. Sem este GRANT ele nao consegue chamar
-- `payment_date_confiavel_desde()` e a saida obvia seria HARDCODAR a data no script — criando
-- exatamente a 2a fonte de verdade que a migration 121 existe para impedir (e que a guarda
-- `test_onda9_pontualidade.py` proibe do lado do TypeScript).
--
-- Nao abre nada: `service_role` ja le as tabelas base direto e ja burla RLS. O que ele NAO ganha
-- e EXECUTE nas 12 tools — aquelas seguem exclusivas de `authenticated`, que e o que faz a RLS
-- decidir o recorte do chat. Conceder so a constante mantem essa separacao intacta.
GRANT EXECUTE ON FUNCTION analytics.payment_date_confiavel_desde() TO service_role;
-- Escrita por authenticated fica de fora (o default do Supabase a concederia — regra recorrente
-- deste projeto: REVOKE explicito em objeto novo, nao confiar no default privilege).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON analytics.roadmap_trigger_snapshot FROM authenticated;
REVOKE ALL ON analytics.roadmap_trigger_snapshot FROM anon;

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICACAO — a migration ABORTA se qualquer invariante nao valer
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rls        boolean;
  v_policies   integer;
  v_service    boolean;
  v_auth_read  boolean;
  v_auth_write boolean;
  v_anon_read  boolean;
  v_dominio    text := 'ACEITOU';
  v_upsert     integer := -1;
  v_linhas     integer := -1;
  v_touch      boolean := NULL;
  v_marco      timestamptz;
BEGIN
  -- P1: RLS ligada com policy. RLS ligada SEM policy e deny total (licao da 111); RLS desligada
  -- e a tabela aberta. As duas pontas importam.
  SELECT relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'analytics' AND c.relname = 'roadmap_trigger_snapshot';
  SELECT count(*)::integer INTO v_policies
    FROM pg_policies WHERE schemaname = 'analytics' AND tablename = 'roadmap_trigger_snapshot';

  IF NOT v_rls THEN
    RAISE EXCEPTION 'ABORTADO: RLS desligada na roadmap_trigger_snapshot';
  END IF;
  IF v_policies = 0 THEN
    RAISE EXCEPTION 'ABORTADO: RLS ligada e ZERO policies — authenticated leria 0 linhas, em '
                    'silencio (a armadilha da migration 111)';
  END IF;

  -- P2: quem escreve pode escrever; quem le nao pode escrever.
  v_service    := has_table_privilege('service_role',  'analytics.roadmap_trigger_snapshot', 'INSERT')
              AND has_table_privilege('service_role',  'analytics.roadmap_trigger_snapshot', 'UPDATE');
  v_auth_read  := has_table_privilege('authenticated', 'analytics.roadmap_trigger_snapshot', 'SELECT');
  v_auth_write := has_table_privilege('authenticated', 'analytics.roadmap_trigger_snapshot', 'INSERT');
  v_anon_read  := has_table_privilege('anon',          'analytics.roadmap_trigger_snapshot', 'SELECT');

  IF NOT v_service THEN
    RAISE EXCEPTION 'ABORTADO: service_role sem INSERT/UPDATE — o script agendado gravaria nada '
                    'e a serie ficaria vazia sem erro visivel (o bug que a 101 corrigiu)';
  END IF;
  IF NOT v_auth_read THEN
    RAISE EXCEPTION 'ABORTADO: authenticated sem SELECT — a serie seria inconsultavel pelo app';
  END IF;
  IF v_auth_write THEN
    RAISE EXCEPTION 'ABORTADO: authenticated pode escrever a serie — o default privilege passou';
  END IF;
  IF v_anon_read THEN
    RAISE EXCEPTION 'ABORTADO: anon le a serie — o REVOKE nao pegou';
  END IF;

  -- P2b: o medidor consegue ler a data de corte da FONTE UNICA. Sem isto, a alternativa e
  -- hardcodar a data no script — a 2a fonte de verdade que a 121 existe para impedir.
  IF NOT has_function_privilege('service_role',
         'analytics.payment_date_confiavel_desde()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: service_role nao executa payment_date_confiavel_desde() — o '
                    'medidor agendado teria de fixar a data por conta propria';
  END IF;
  -- E `anon` continua sem: o GRANT acima e so para quem grava a serie.
  IF has_function_privilege('anon', 'analytics.payment_date_confiavel_desde()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: anon executa payment_date_confiavel_desde() — o REVOKE da 121 caiu';
  END IF;

  -- P3: o dominio fechado morde. Ausencia de excecao aqui e FALHA, nao aprovacao.
  BEGIN
    INSERT INTO analytics.roadmap_trigger_snapshot (trigger_key, fired, metrics, criterion)
    VALUES ('gatilho_que_nao_existe', false, '{}'::jsonb, 'sonda');
    v_dominio := 'ACEITOU';
    RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN v_dominio := 'ok';
    WHEN raise_exception THEN NULL;
  END;

  IF v_dominio <> 'ok' THEN
    RAISE EXCEPTION 'ABORTADO: chave fora do dominio foi aceita — um typo no script criaria uma '
                    'serie orfa e a serie certa pararia de crescer em silencio';
  END IF;

  -- P4 🔴: o UPSERT do dia REESCREVE em vez de duplicar. E a garantia que sustenta a serie
  -- inteira, e a unica forma de prova-la e exercitando os dois INSERTs.
  BEGIN
    -- `clock_timestamp()`, nao `now()`: dentro de uma transacao o `now()` e CONGELADO, entao a
    -- comparacao "o measured_at avancou?" seria sempre falsa e a sonda acusaria um defeito que
    -- nao existe.
    v_marco := clock_timestamp();

    INSERT INTO analytics.roadmap_trigger_snapshot (trigger_key, measured_on, fired, metrics, criterion)
    VALUES ('nfse', DATE '1999-01-01', false, '{"n":1}'::jsonb, 'sonda P4')
    ON CONFLICT (trigger_key, measured_on) DO UPDATE
       SET fired = EXCLUDED.fired, metrics = EXCLUDED.metrics;

    INSERT INTO analytics.roadmap_trigger_snapshot (trigger_key, measured_on, fired, metrics, criterion)
    VALUES ('nfse', DATE '1999-01-01', true, '{"n":2}'::jsonb, 'sonda P4')
    ON CONFLICT (trigger_key, measured_on) DO UPDATE
       SET fired = EXCLUDED.fired, metrics = EXCLUDED.metrics;

    SELECT count(*)::integer INTO v_upsert
      FROM analytics.roadmap_trigger_snapshot
     WHERE trigger_key = 'nfse' AND measured_on = DATE '1999-01-01';

    SELECT (metrics->>'n')::integer INTO v_linhas
      FROM analytics.roadmap_trigger_snapshot
     WHERE trigger_key = 'nfse' AND measured_on = DATE '1999-01-01';

    -- P4b: o UPSERT tambem AVANCA `measured_at`. Sem a trigger, o segundo INSERT atualizava
    -- `metrics` e deixava o horario da PRIMEIRA medicao — a coluna diria a hora errada, calada.
    SELECT (measured_at > v_marco) INTO v_touch
      FROM analytics.roadmap_trigger_snapshot
     WHERE trigger_key = 'nfse' AND measured_on = DATE '1999-01-01';

    RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;   -- desfaz as duas linhas; as variaveis medidas sobrevivem
  END;

  IF v_upsert <> 1 THEN
    RAISE EXCEPTION 'ABORTADO: dois INSERTs no mesmo dia geraram % linha(s) — a serie duplicaria '
                    'a cada reexecucao e qualquer media sobre ela mentiria', v_upsert;
  END IF;
  IF v_linhas <> 2 THEN
    RAISE EXCEPTION 'ABORTADO: o UPSERT nao atualizou a medicao (metrics.n = %, esperava 2) — '
                    'remedir no mesmo dia deixaria o ponto velho', v_linhas;
  END IF;
  IF v_touch IS NOT TRUE THEN
    RAISE EXCEPTION 'ABORTADO: measured_at nao avancou no UPSERT — a coluna informaria o horario '
                    'da PRIMEIRA medicao do dia (a trigger de touch nao pegou)';
  END IF;

  RAISE NOTICE 'roadmap_trigger_snapshot OK: RLS ligada, % policy(ies), upsert por dia provado',
    v_policies;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICACAO (apos aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
-- 1. Rodar o medidor (`py -3 skills/roadmap-gatilhos/scripts/run.py`) e conferir que ele grava 7
--    linhas, uma por gatilho.
-- 2. Rodar de novo no mesmo dia e conferir que continuam 7 linhas (UPSERT), com measured_at
--    atualizado.
-- 3. Consultar a serie de um gatilho ordenando por measured_on DESC — e essa consulta que
--    responde "isto esta crescendo?", que e a pergunta que a tabela existe para responder.
