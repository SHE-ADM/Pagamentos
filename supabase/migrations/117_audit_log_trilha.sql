-- 117_audit_log_trilha.sql
--
-- ONDA 7 (item 7.1) — docs/roadmap-enriquecimento-dados.md §4
-- Popular a trilha de auditoria: `public.audit_log` existe desde o início do projeto e tem
-- **0 linhas**. A fato guarda apenas o ÚLTIMO editor (`updated_by`/`status_changed_by`, migration
-- 077), então a penúltima alteração é sobrescrita e some — é por isso que "quais usuários vêm
-- alterando campos sensíveis" é hoje irrespondível.
--
-- Guardas deste arquivo: tests/test_onda7_auditoria.py.
--
-- ---------------------------------------------------------------------------
-- 🔴 POR QUE ESTA MIGRATION COMEÇA FECHANDO UM VAZAMENTO, E NÃO CRIANDO A TRIGGER
-- ---------------------------------------------------------------------------
-- Medido no catálogo em 2026-08-11, ANTES de qualquer alteração:
--
--   policy "Enable read access for all users" ... TO public  USING (true)
--   GRANT SELECT ON public.audit_log TO anon
--
-- A `audit_log` foi criada à mão (pelo dashboard), e objeto criado por ali nasce permissivo —
-- é a MESMA família dos achados 072, 081 e 099 já registrados no CLAUDE.md. Hoje isso é inócuo
-- porque a tabela está vazia. No instante em que a trigger deste arquivo começar a gravar
-- `dados_antes`/`dados_depois` de contas a pagar, a tabela passa a conter valores, fornecedores e
-- autores — e a **anon key é PÚBLICA** (vai no bundle do browser). Popular antes de revogar
-- publicaria a base financeira inteira para qualquer um, sem login.
--
-- Por isso a ordem interna é: (1) revogar, (2) corrigir o tipo, (3) criar a policy correta,
-- (4) só então ligar as triggers.
--
-- IDEMPOTENTE. Reexecutar é no-op: todo DDL é IF EXISTS / IF NOT EXISTS / OR REPLACE, o ALTER de
-- tipo só dispara quando a coluna ainda é uuid, e as sondas do DO final desfazem o que escrevem.

-- ---------------------------------------------------------------------------
-- 1) FECHAR O VAZAMENTO (achados 2 e 3 do levantamento)
-- ---------------------------------------------------------------------------
-- A policy `TO public` alcança `anon` e `authenticated` de uma vez. A `authenticated read
-- audit_log` (migration 056) também é `USING (true)`, o que IGNORA a RLS da 076: o grupo Comercial
-- (`sees_only_own_accounts`) enxergaria o delta de contas alheias — vazamento lateral que contorna
-- justamente a visibilidade por dono. As duas caem aqui e são substituídas no passo 4.

DROP POLICY IF EXISTS "Enable read access for all users" ON public.audit_log;
DROP POLICY IF EXISTS "authenticated read audit_log"     ON public.audit_log;

REVOKE SELECT ON public.audit_log FROM anon;

-- Defesa em profundidade (o padrão recorrente do projeto — 056/057/079/081/097): o Supabase
-- concede escrita por DEFAULT em tabela nova, e quem escreve aqui é a trigger SECURITY DEFINER.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_log FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) CORRIGIR O TIPO DE `registro_id` (achado 1)
-- ---------------------------------------------------------------------------
-- `audit_log.registro_id` é UUID; `financial_account_control.id` é BIGINT. A tabela foi criada com
-- o PK-UUID do padrão Sheild genérico para OLTP, que **nenhuma** tabela deste projeto segue (a fato
-- é bigint IDENTITY, `supplier` é `sk_supplier` bigint, os cadastros são smallint IDENTITY).
-- Ou seja: não havia onde gravar o id da conta, e o item 7.1 do roadmap não era executável.
--
-- BIGINT e não TEXT: toda tabela auditável aqui tem PK inteira, e TEXT convidaria a comparar
-- '007' com '7' e a perder índice em silêncio. Se um dia existir tabela de PK uuid, ela ganha
-- coluna própria — não se degrada esta.
--
-- Seguro: 0 linhas e 0 consumidores (nenhum .ts/.py do monorepo referencia `audit_log`).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.audit_log'::regclass
       AND attname  = 'registro_id'
       AND atttypid = 'uuid'::regtype
  ) THEN
    IF EXISTS (SELECT 1 FROM public.audit_log) THEN
      RAISE EXCEPTION
        'ABORTADO: audit_log deixou de estar vazia — a conversao uuid->bigint perderia dado. '
        'Migrar as linhas existentes antes de reaplicar.';
    END IF;
    ALTER TABLE public.audit_log ALTER COLUMN registro_id TYPE bigint USING NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) COLUNAS NOVAS
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_log
  -- Dono da conta (`created_by`) DESNORMALIZADO. É o que sustenta a RLS do passo 4.
  -- 🔴 O padrão EXISTS da migration 079 (anexos) NÃO serve aqui: aquele herda a visibilidade
  -- consultando a conta pai, e a linha de auditoria precisa SOBREVIVER à conta apagada — o
  -- registro de DELETE é o mais importante de todos, e com EXISTS ele ficaria invisível para
  -- todo mundo no exato momento em que passa a ser a única cópia do que existia.
  ADD COLUMN IF NOT EXISTS registro_dono    uuid,
  -- Colunas que mudaram. É o índice da pergunta de governança ("quem mexeu no valor?") e o que
  -- permite responder sem varrer jsonb.
  ADD COLUMN IF NOT EXISTS campos_alterados text[],
  -- COMO o ator foi determinado — a trilha declara a própria confiança, no mesmo espírito de
  -- `extraction_confidence` (Onda 6). 'servico' NÃO significa "ninguém": significa automação ou
  -- edição não atribuível. Confundir os dois produziria conclusão errada numa auditoria.
  ADD COLUMN IF NOT EXISTS ator_via         text;

COMMENT ON COLUMN public.audit_log.registro_dono IS
  'Dono do registro (financial_account_control.created_by) no momento do evento, desnormalizado '
  'para que a RLS continue valendo depois de a conta ser apagada. NULL em tabela sem recorte por '
  'dono (supplier) e no evento TRUNCATE.';
COMMENT ON COLUMN public.audit_log.campos_alterados IS
  'Colunas efetivamente alteradas (UPDATE). NULL em DELETE/TRUNCATE. Nao inclui colunas de '
  'escrituracao nem GERADAS — ver public.audit_ignored_fields().';
COMMENT ON COLUMN public.audit_log.ator_via IS
  'Como usuario_id foi obtido: jwt (auth.uid) | header (x-audit-actor, Next API) | '
  'guc (app.audit_actor, scripts) | servico (automacao/nao atribuivel — NUNCA leia como "ninguem").';

-- CHECKs. `INSERT` entra no domínio para que uma onda futura possa ligá-lo sem nova migration,
-- embora a Onda 7 deliberadamente NÃO audite INSERT (a linha recém-criada já está na fato, e o
-- pipeline insere ~17/dia — seriam ~6.200 linhas/ano de ruído afogando a pergunta de governança).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_log_operacao') THEN
    ALTER TABLE public.audit_log ADD CONSTRAINT chk_audit_log_operacao
      CHECK (operacao IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'));
  END IF;

  -- 🔴 GUARDA FAIL-CLOSED. A policy do passo 4 libera a linha quando `tabela <> fato`; se um
  -- evento da fato chegasse com `registro_dono` nulo, ele cairia fora do recorte por dono e
  -- ficaria visível para o grupo restrito. Com `created_by` NOT NULL na fato isso é impossível —
  -- este CHECK é o que garante que continue impossível, em vez de depender da lembrança de quem
  -- alterar a trigger depois.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_log_dono_da_fato') THEN
    ALTER TABLE public.audit_log ADD CONSTRAINT chk_audit_log_dono_da_fato
      CHECK (NOT (tabela = 'financial_account_control'
                  AND operacao IN ('UPDATE', 'DELETE')
                  AND registro_dono IS NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) POLICY DE LEITURA — espelha a 076 e preserva o status quo
-- ---------------------------------------------------------------------------
-- Decisão do usuário: quem já vê a conta vê a auditoria dela. Isso NÃO amplia exposição — o painel
-- de detalhe de /consulta já mostra "Criado por"/"Última edição por" (view app_user) para qualquer
-- usuário não-restrito. O único recorte real do sistema é o grupo Comercial, e ele é reproduzido
-- aqui pelo MESMO helper da 076, para não criar 2ª fonte de verdade do "quem é restrito".

-- `DROP` antes do `CREATE`: `CREATE POLICY` não aceita `IF NOT EXISTS`, então sem isto o arquivo
-- não seria reexecutável (verificado rodando-o de novo — falhou com "policy already exists").
DROP POLICY IF EXISTS authenticated_select_audit_log ON public.audit_log;
CREATE POLICY authenticated_select_audit_log ON public.audit_log
  FOR SELECT TO authenticated
  USING (
       NOT public.auth_group_sees_only_own()   -- grupo irrestrito: vê tudo, como já via
    OR registro_dono = auth.uid()              -- grupo restrito: só o que é seu
    OR tabela <> 'financial_account_control'   -- supplier: já é visível a todos hoje (policy USING true)
  );

-- `service_role` já tem ALL por grant (verificado); é ele que a Next API e o pipeline usam.

-- ---------------------------------------------------------------------------
-- 5) ÍNDICES
-- ---------------------------------------------------------------------------
-- A tabela tinha só a PK. Cada índice aqui corresponde a um filtro real da tool da migration 118.
CREATE INDEX IF NOT EXISTS ix_audit_log_registro   ON public.audit_log (tabela, registro_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_usuario    ON public.audit_log (usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_criado_em  ON public.audit_log (criado_em DESC);
-- GIN é o índice da pergunta de governança: `campos_alterados @> ARRAY['amount']`.
CREATE INDEX IF NOT EXISTS ix_audit_log_campos     ON public.audit_log USING gin (campos_alterados);
CREATE INDEX IF NOT EXISTS ix_audit_log_dono       ON public.audit_log (registro_dono) WHERE registro_dono IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6) VOCABULÁRIO — fonte única, lida pela tool (118) e pelas guardas de teste
-- ---------------------------------------------------------------------------
-- Campos cuja alteração é materialmente sensível num sistema de contas a pagar. Os quatro últimos
-- são de `supplier`: trocar a chave PIX de um fornecedor é o vetor clássico de fraude em pagamentos
-- e hoje não deixa rastro nenhum (a tabela não tem sequer updated_by).
CREATE OR REPLACE FUNCTION public.audit_sensitive_fields()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT ARRAY[
    'amount', 'amount_charged', 'due_date', 'payment_date', 'status_id',
    'sk_supplier', 'sk_company', 'barcode', 'nosso_numero', 'invoice_number',
    'has_invoice', 'has_bank_slip', 'cost_center_id', 'chart_account_id',
    'pix_key1', 'pix_key2', 'cnpj', 'cpf'
  ]::text[];
$$;

-- Colunas que NÃO contam como alteração de negócio.
-- As 4 primeiras são escrituração carimbada pela própria trigger de autoria (077) — inclui-las
-- faria TODO delta carregar ruído e, pior, um PATCH que não mudou nada de negócio geraria linha.
-- As 5 seguintes são GERADAS (Onda 6): ninguém "alterou" uma coluna derivada; ela é consequência.
CREATE OR REPLACE FUNCTION public.audit_ignored_fields()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT ARRAY[
    'updated_at', 'updated_by', 'status_changed_at', 'status_changed_by',
    'competence_month', 'days_late', 'extraction_confidence',
    'installment_number', 'installment_base'
  ]::text[];
$$;

-- 🔴 GRANT/REVOKE EXPLÍCITOS — guardrail 2 do roadmap, nos DOIS sentidos.
-- O PostgreSQL concede EXECUTE a PUBLIC por default, e o `ALTER DEFAULT PRIVILEGES` da 098 não
-- deixa registro persistente (medido na Onda 1: 4 funções recriadas pela 104 nasceram chamáveis
-- com a anon key PÚBLICA, sem login). Verificado empiricamente nesta migration: antes do REVOKE,
-- `POST /rest/v1/rpc/audit_sensitive_fields` com a anon key respondia **HTTP 200**.
-- Não expõe segredo — é uma lista de nomes de coluna —, mas função nova sem REVOKE é exatamente
-- o padrão que o projeto já teve de limpar três vezes (072, 081, 099).
-- `authenticated` PRECISA do EXECUTE: a tool da 118 é SECURITY INVOKER e chama estas duas.
GRANT  EXECUTE ON FUNCTION public.audit_sensitive_fields() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_sensitive_fields() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.audit_ignored_fields()   TO authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_ignored_fields()   FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 7) A TRIGGER DE LINHA
-- ---------------------------------------------------------------------------
-- 🔴 AFTER, NUNCA BEFORE. As 5 triggers atuais da fato são TODAS `BEFORE` e alteram NEW
-- (`updated_at`, `status_id` recalculado por vencimento, `payment_date` carimbado, `sk_company`
-- resolvido). Uma auditoria BEFORE gravaria o valor que essas triggers ainda vão sobrescrever —
-- registro plausível e falso, que é o pior desfecho possível numa trilha.
--
-- 🔴 `SECURITY DEFINER` É OBRIGATÓRIO, NÃO ESTILO. A 056 revogou INSERT de `authenticated` na
-- audit_log, e a RLS não tem policy de escrita. Uma trigger INVOKER faria TODA a curadoria de
-- /consulta (marcar NF/Boleto, trocar situação — que é UPDATE por `authenticated` via REST direto)
-- quebrar com `permission denied for table audit_log`. É exatamente a regressão que a migration
-- **074** teve de consertar depois da 072. Funciona porque o owner é `postgres` e a audit_log não
-- tem `FORCE ROW LEVEL SECURITY` (ambos verificados no catálogo).
--
-- 🔴 FAIL-CLOSED, ao contrário de `register_attachment`/`register_fiscal_document`. Aqueles são
-- ENRIQUECIMENTO e engolem a própria falha; este é AUDITORIA, e trilha com buraco silencioso é
-- pior que trilha nenhuma, porque produz confiança falsa. É seguro porque a função não tem
-- dependência externa: sem rede, sem tabela de terceiro, colunas NOT NULL preenchidas por literal.
CREATE OR REPLACE FUNCTION public.fn_audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pk_col     text := TG_ARGV[0];
  v_owner_col  text := CASE WHEN TG_NARGS > 1 AND TG_ARGV[1] <> '' THEN TG_ARGV[1] END;
  v_ignorados  text[] := public.audit_ignored_fields();
  v_antes      jsonb;
  v_depois     jsonb;
  v_delta_ant  jsonb := '{}'::jsonb;
  v_delta_dep  jsonb := '{}'::jsonb;
  v_campos     text[] := '{}'::text[];
  v_ator       uuid;
  v_via        text;
  v_header     text;
  v_guc        text;
  k            text;
  -- Formato canônico de UUID. Constante local para as duas validações abaixo lerem a MESMA regra.
  _UUID_RE     CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  v_antes  := to_jsonb(OLD);
  v_depois := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

  IF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(v_depois) LOOP
      CONTINUE WHEN k = ANY (v_ignorados);
      IF (v_depois -> k) IS DISTINCT FROM (v_antes -> k) THEN
        v_campos    := v_campos || k;
        v_delta_ant := v_delta_ant || jsonb_build_object(k, v_antes -> k);
        v_delta_dep := v_delta_dep || jsonb_build_object(k, v_depois -> k);
      END IF;
    END LOOP;

    -- 🔴 DELTA VAZIO ⇒ NENHUMA LINHA. `fn_set_updated_at` bumpa `updated_at` em TODO update, então
    -- sem esta saída um UPDATE que não mudou nada de negócio (o batch diário remarcando a mesma
    -- situação, um toggle marcado e desmarcado, um PATCH idêntico ao estado atual) geraria linha
    -- de auditoria vazia — e a trilha encheria de eventos que não são eventos.
    IF v_campos = '{}'::text[] THEN
      RETURN NULL;
    END IF;
  END IF;

  -- --- Resolução do ator -----------------------------------------------------
  -- 🔴 A ORDEM É INVARIANTE DE SEGURANÇA, não preferência: `auth.uid()` vem PRIMEIRO porque o JWT
  -- é inforjável. O header `x-audit-actor` só é consultado quando NÃO há JWT — isto é, quando quem
  -- escreve é `service_role`. Invertesse a ordem e um usuário logado poderia mandar o header com o
  -- uuid de outra pessoa e assinar a alteração no nome dela. Quem detém a service_role key já pode
  -- tudo, então o header não abre superfície nova.
  --
  -- O header chega via PostgREST (`request.headers`) — verificado empiricamente contra esta
  -- instância em 2026-08-11, com o header custom chegando intacto ao Postgres. É o que dá
  -- atribuição precisa aos caminhos da Next API, que gravam por service_role e portanto não têm
  -- auth.uid(): PATCH/DELETE de conta e o CRUD de fornecedores.
  --
  -- 🔴 `OLD.updated_by` NÃO é fonte de ator, em nenhuma hipótese. Ele é o editor ANTERIOR; usá-lo
  -- numa alteração de batch atribuiria a um humano uma mudança que ele não fez — acusação falsa,
  -- pior que ausência de dado. Sem sinal, o honesto é NULL + 'servico'.
  --
  -- 🔴 O ATOR VEM DE FORA E PODE VIR MALFORMADO — VALIDAR ANTES DE CONVERTER.
  -- Achado da autorrevisão adversarial desta onda, reproduzido no banco: com um valor não-uuid no
  -- canal de ator, o `::uuid` levanta **22P02** e, como a trigger é fail-closed, **derruba a
  -- gravação da conta inteira**. Um header ruim (proxy, cliente terceiro, chamador com bug) não
  -- pode impedir o sistema de registrar um pagamento.
  --
  -- A distinção que importa: fail-closed vale para o REGISTRO da auditoria (não conseguiu
  -- auditar ⇒ não escreve, senão a trilha ganharia buracos silenciosos); NÃO vale para
  -- INTERPRETAR uma dica de atribuição não-confiável. Ator ilegível degrada para o mesmo estado
  -- de "não sei quem foi" que já existe — NULL + 'servico' —, que é honesto e não perde a
  -- alteração. O regex é a guarda; não trocar por cast direto.
  v_header := nullif(current_setting('request.headers', true), '');
  IF v_header IS NOT NULL THEN
    v_header := nullif(v_header::jsonb ->> 'x-audit-actor', '');
  END IF;
  v_guc := nullif(current_setting('app.audit_actor', true), '');

  IF v_header IS NOT NULL AND v_header !~* _UUID_RE THEN v_header := NULL; END IF;
  IF v_guc    IS NOT NULL AND v_guc    !~* _UUID_RE THEN v_guc    := NULL; END IF;

  IF auth.uid() IS NOT NULL THEN
    v_ator := auth.uid();      v_via := 'jwt';
  ELSIF v_header IS NOT NULL THEN
    v_ator := v_header::uuid;  v_via := 'header';
  ELSIF v_guc IS NOT NULL THEN
    v_ator := v_guc::uuid;     v_via := 'guc';
  ELSE
    v_ator := NULL;            v_via := 'servico';
  END IF;

  INSERT INTO public.audit_log (
    tabela, operacao, registro_id, registro_dono, usuario_id,
    dados_antes, dados_depois, campos_alterados, ator_via
  )
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    (coalesce(v_depois, v_antes) ->> v_pk_col)::bigint,
    CASE WHEN v_owner_col IS NOT NULL
         THEN (coalesce(v_depois, v_antes) ->> v_owner_col)::uuid END,
    v_ator,
    -- UPDATE guarda só o DELTA (~200 B); DELETE guarda a linha INTEIRA, porque passa a ser a
    -- única cópia do que existia. Medido: linha da fato em jsonb tem média 1,8 KB e máx 13 KB —
    -- gravar a linha inteira em todo update custaria ~3,7 KB por evento sem responder melhor.
    CASE WHEN TG_OP = 'UPDATE' THEN v_delta_ant ELSE v_antes END,
    CASE WHEN TG_OP = 'UPDATE' THEN v_delta_dep ELSE NULL END,
    CASE WHEN TG_OP = 'UPDATE' THEN v_campos ELSE NULL END,
    v_via
  );

  RETURN NULL;   -- AFTER trigger: o valor de retorno é ignorado
END $$;

COMMENT ON FUNCTION public.fn_audit_row() IS
  'Trigger AFTER de auditoria. TG_ARGV[0] = coluna de PK; TG_ARGV[1] (opcional) = coluna de dono. '
  'UPDATE grava o delta; DELETE grava a linha inteira; UPDATE sem mudanca real NAO gera linha.';

-- ---------------------------------------------------------------------------
-- 8) A TRIGGER DE TRUNCATE
-- ---------------------------------------------------------------------------
-- Trigger de LINHA não dispara em TRUNCATE — sem esta, a maior perda possível (o
-- `TRUNCATE ... RESTART IDENTITY CASCADE` da rotina de "Limpeza / reset de dados") não deixaria
-- rastro algum, que é o oposto do propósito da trilha.
--
-- BEFORE e não AFTER: em AFTER a tabela já está vazia e não há como registrar QUANTAS linhas foram
-- destruídas, que é justamente o número que se quer numa auditoria. É seguro porque o INSERT roda
-- na mesma transação do TRUNCATE: se ele abortar, o registro some junto.
CREATE OR REPLACE FUNCTION public.fn_audit_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_linhas bigint;
  v_ator   uuid := auth.uid();
BEGIN
  EXECUTE format('SELECT count(*) FROM %I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO v_linhas;

  INSERT INTO public.audit_log (tabela, operacao, dados_antes, usuario_id, ator_via)
  VALUES (
    TG_TABLE_NAME, 'TRUNCATE',
    jsonb_build_object('linhas_destruidas', v_linhas),
    v_ator,
    CASE WHEN v_ator IS NOT NULL THEN 'jwt' ELSE 'servico' END
  );

  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.fn_audit_truncate() IS
  'Trigger BEFORE TRUNCATE: registra quantas linhas serao destruidas. BEFORE porque em AFTER a '
  'tabela ja esta vazia; seguro porque roda na mesma transacao do TRUNCATE.';

-- ---------------------------------------------------------------------------
-- 9) LIGAR AS TRIGGERS
-- ---------------------------------------------------------------------------
-- INSERT fica de fora por decisão (ver o CHECK do passo 3).
DROP TRIGGER IF EXISTS trg_audit_fac      ON public.financial_account_control;
CREATE TRIGGER trg_audit_fac
  AFTER UPDATE OR DELETE ON public.financial_account_control
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_row('id', 'created_by');

DROP TRIGGER IF EXISTS trg_audit_fac_truncate ON public.financial_account_control;
CREATE TRIGGER trg_audit_fac_truncate
  BEFORE TRUNCATE ON public.financial_account_control
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_audit_truncate();

-- `supplier` não tem coluna de dono (nem `created_by`/`updated_by`) — o 2º argumento fica vazio e
-- `registro_dono` sai NULL, o que a policy do passo 4 trata explicitamente pelo nome da tabela.
DROP TRIGGER IF EXISTS trg_audit_supplier ON public.supplier;
CREATE TRIGGER trg_audit_supplier
  AFTER UPDATE OR DELETE ON public.supplier
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_row('sk_supplier');

DROP TRIGGER IF EXISTS trg_audit_supplier_truncate ON public.supplier;
CREATE TRIGGER trg_audit_supplier_truncate
  BEFORE TRUNCATE ON public.supplier
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_audit_truncate();

-- ---------------------------------------------------------------------------
-- 🔴 AUTO-VERIFICAÇÃO — a migration ABORTA se qualquer invariante não valer
-- ---------------------------------------------------------------------------
-- Padrão da 116. As sondas escrevem de verdade e são DESFEITAS: cada uma roda dentro de um bloco
-- BEGIN..EXCEPTION (subtransação) que termina levantando exceção de propósito. As variáveis
-- plpgsql NÃO são transacionais, então o resultado medido sobrevive ao rollback — é o que permite
-- provar o comportamento sem deixar resíduo em produção (a Supabase é compartilhada dev+prod).
--
-- Nenhuma asserção usa número absoluto: tudo é medido como DELTA contra a contagem imediatamente
-- anterior, porque o pipeline grava a cada 5 minutos e a tabela deriva durante a própria migration.

DO $$
DECLARE
  v_id        bigint;
  v_base      integer;
  v_apos_upd  integer;
  v_apos_noop integer;
  v_campos    text[];
  v_via       text;
  v_ator      uuid;
  v_curadoria text := 'nao executada';
  v_malformado    text;
  v_via_malformado text;
  v_del_op        text;
  v_del_campos    text[];
  v_del_depois    jsonb;
  v_del_linha_inteira boolean := false;
  v_jwt_via       text;
  v_jwt_ator      uuid;
  v_trunc_linhas  bigint;
  v_trunc_erro    text;
  v_usuario_real  uuid;
  v_ator_esperado CONSTANT uuid := '11111111-2222-3333-4444-555555555555';
BEGIN
  SELECT id INTO v_id FROM public.financial_account_control ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE 'audit_log: sem contas na base — sondas de comportamento puladas';
  ELSE
    -- SONDA A: UPDATE real gera 1 linha com o campo certo; UPDATE sem mudança real gera 0.
    SELECT count(*)::integer INTO v_base
      FROM public.audit_log WHERE tabela = 'financial_account_control' AND registro_id = v_id;
    BEGIN
      PERFORM set_config('app.audit_actor', v_ator_esperado::text, true);

      UPDATE public.financial_account_control
         SET additional_info = coalesce(additional_info, '') || ' [sonda-117]'
       WHERE id = v_id;

      SELECT count(*)::integer INTO v_apos_upd
        FROM public.audit_log WHERE tabela = 'financial_account_control' AND registro_id = v_id;
      SELECT campos_alterados, ator_via, usuario_id INTO v_campos, v_via, v_ator
        FROM public.audit_log
       WHERE tabela = 'financial_account_control' AND registro_id = v_id
       ORDER BY criado_em DESC, id DESC LIMIT 1;

      -- UPDATE que não muda nada de negócio (só a escrituração de updated_at pela trigger 077).
      UPDATE public.financial_account_control SET amount = amount WHERE id = v_id;
      SELECT count(*)::integer INTO v_apos_noop
        FROM public.audit_log WHERE tabela = 'financial_account_control' AND registro_id = v_id;

      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- desfaz a sonda; as variáveis medidas permanecem
    END;
    PERFORM set_config('app.audit_actor', '', true);

    IF v_apos_upd - v_base <> 1 THEN
      RAISE EXCEPTION 'ABORTADO: UPDATE real gerou % linha(s) de auditoria, esperado 1',
        v_apos_upd - v_base;
    END IF;
    IF NOT (v_campos @> ARRAY['additional_info']) THEN
      RAISE EXCEPTION 'ABORTADO: campos_alterados = % — nao registrou a coluna alterada', v_campos;
    END IF;
    IF v_campos && public.audit_ignored_fields() THEN
      RAISE EXCEPTION 'ABORTADO: campos_alterados = % inclui coluna de escrituracao/GERADA', v_campos;
    END IF;
    IF v_apos_noop <> v_apos_upd THEN
      RAISE EXCEPTION 'ABORTADO: UPDATE sem mudanca real gerou linha de auditoria (delta vazio)';
    END IF;
    IF v_via IS DISTINCT FROM 'guc' OR v_ator IS DISTINCT FROM v_ator_esperado THEN
      RAISE EXCEPTION 'ABORTADO: ator via=% id=% — o canal explicito de ator nao foi respeitado',
        v_via, v_ator;
    END IF;

    -- SONDA B: a mais importante do arquivo — a REGRESSÃO CLASSE 074.
    -- A curadoria de /consulta é UPDATE por `authenticated` via REST direto. Se a trigger não
    -- fosse SECURITY DEFINER, isto levantaria 42501 e marcar "Tem NF" quebraria em produção.
    BEGIN
      SET LOCAL ROLE authenticated;
      UPDATE public.financial_account_control SET has_invoice = NOT has_invoice WHERE id = v_id;
      v_curadoria := 'ok';
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN insufficient_privilege THEN v_curadoria := 'PERMISSION DENIED: ' || SQLERRM;
      WHEN raise_exception        THEN NULL;
    END;

    IF v_curadoria <> 'ok' THEN
      RAISE EXCEPTION 'ABORTADO: a curadoria por authenticated quebrou (regressao classe 074) — %',
        v_curadoria;
    END IF;

    -- SONDA C: ator MALFORMADO nao pode derrubar a gravacao da conta.
    -- Sem a validacao por regex, o `::uuid` levanta 22P02 e, sendo a trigger fail-closed, o
    -- UPDATE inteiro falha — um header ruim impediria de registrar um pagamento.
    v_malformado := 'nao executada';
    BEGIN
      PERFORM set_config('app.audit_actor', 'isto-nao-e-um-uuid', true);
      UPDATE public.financial_account_control
         SET additional_info = coalesce(additional_info, '') || ' [sonda-ator]'
       WHERE id = v_id;
      -- ⚠️ Identifica o evento pelo CONTEUDO, nao por "o mais recente": `criado_em` e o timestamp
      -- da TRANSACAO (now()), entao eventos gravados juntos compartilham o instante e o desempate
      -- por `id` (uuid) e aleatorio. Ler pela ordem devolveria um evento vizinho — foi assim que a
      -- primeira versao desta sonda mediu a coisa errada.
      SELECT ator_via INTO v_via_malformado
        FROM public.audit_log
       WHERE tabela = 'financial_account_control' AND registro_id = v_id
         AND dados_depois->>'additional_info' LIKE '%[sonda-ator]';
      v_malformado := 'ok';
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN raise_exception THEN NULL;
      WHEN others          THEN v_malformado := 'QUEBROU: ' || SQLSTATE || ' — ' || SQLERRM;
    END;
    PERFORM set_config('app.audit_actor', '', true);

    IF v_malformado <> 'ok' THEN
      RAISE EXCEPTION 'ABORTADO: ator malformado derrubou a escrita da conta — %', v_malformado;
    END IF;
    IF v_via_malformado IS DISTINCT FROM 'servico' THEN
      RAISE EXCEPTION 'ABORTADO: ator ilegivel virou ator_via=% em vez de degradar para servico',
        v_via_malformado;
    END IF;

    -- SONDA D: o DELETE grava a LINHA INTEIRA (unica copia que resta) e nao um delta.
    -- Sem esta sonda, o caminho mais destrutivo do sistema seria o unico nunca exercitado.
    BEGIN
      DELETE FROM public.financial_account_control WHERE id = v_id;
      SELECT operacao, campos_alterados, dados_depois,
             (dados_antes ? 'amount' AND dados_antes ? 'due_date')
        INTO v_del_op, v_del_campos, v_del_depois, v_del_linha_inteira
        FROM public.audit_log
       WHERE tabela = 'financial_account_control' AND registro_id = v_id AND operacao = 'DELETE';
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION WHEN raise_exception THEN
      NULL;   -- a conta volta; so as medicoes sobrevivem
    END;

    IF v_del_op IS DISTINCT FROM 'DELETE' THEN
      RAISE EXCEPTION 'ABORTADO: o DELETE de conta nao gerou linha de auditoria';
    END IF;
    IF NOT v_del_linha_inteira THEN
      RAISE EXCEPTION 'ABORTADO: o DELETE gravou um delta em vez da linha inteira — a linha '
                      'destruida deixaria de ter copia';
    END IF;
    IF v_del_campos IS NOT NULL OR v_del_depois IS NOT NULL THEN
      RAISE EXCEPTION 'ABORTADO: DELETE gravou campos_alterados/dados_depois (esperado NULL nos dois)';
    END IF;

    -- SONDA E: ATRIBUICAO PELO JWT — o caminho humano DOMINANTE.
    -- A curadoria de /consulta (NF/Boleto, situacao) grava por REST direto com o token do
    -- usuario. A sonda B acima prova que ela nao QUEBRA; esta prova que ela ATRIBUI: sem isso, o
    -- caminho mais usado poderia estar gravando 'servico' e ninguem notaria.
    --
    -- ⚠️ O usuario tem de ser REAL, resolvido em tempo de execucao. Com `request.jwt.claims`
    -- definido, `auth.uid()` passa a valer e a trigger de autoria (077) grava `updated_by` — um
    -- uuid ficticio viola a FK para `auth.users` e derruba a migration. Hardcodar um uuid
    -- especifico seria pior: quebraria no dia em que aquele usuario fosse removido.
    SELECT id INTO v_usuario_real FROM auth.users ORDER BY created_at LIMIT 1;
    IF v_usuario_real IS NULL THEN
      RAISE NOTICE 'sem usuarios em auth.users — sonda de atribuicao por JWT pulada';
      v_jwt_via  := 'jwt';            -- neutraliza a assercao abaixo
      v_jwt_ator := NULL;
    ELSE
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims',
                         json_build_object('sub', v_usuario_real, 'role', 'authenticated')::text,
                         true);
      UPDATE public.financial_account_control SET has_invoice = NOT has_invoice WHERE id = v_id;
      SELECT ator_via, usuario_id INTO v_jwt_via, v_jwt_ator
        FROM public.audit_log
       WHERE tabela = 'financial_account_control' AND registro_id = v_id
         AND campos_alterados = ARRAY['has_invoice'];
      RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN insufficient_privilege THEN v_jwt_via := 'PERMISSION DENIED';
      WHEN raise_exception        THEN NULL;
    END;
    END IF;

    IF v_jwt_via IS DISTINCT FROM 'jwt'
       OR (v_usuario_real IS NOT NULL AND v_jwt_ator IS DISTINCT FROM v_usuario_real) THEN
      RAISE EXCEPTION 'ABORTADO: curadoria por JWT gravou via=% ator=% (esperado jwt/%)',
        v_jwt_via, v_jwt_ator, v_usuario_real;
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- SONDA F: a LOGICA de fn_audit_truncate, numa tabela descartavel
  -- ---------------------------------------------------------------------------
  -- 🔴 NAO se trunca aqui a `financial_account_control`. `TRUNCATE` toma **ACCESS EXCLUSIVE** e o
  -- segura ate o FIM da transacao — mesmo desfeito, ele bloquearia o pipeline (que roda a cada 5
  -- min) e o app inteiro durante o resto desta migration, a cada reexecucao. O risco operacional
  -- e maior que o do teste.
  --
  -- A decomposicao: aqui se prova a LOGICA da funcao (conta as linhas ANTES de esvaziar e grava o
  -- evento); o BINDING a tabela real — `BEFORE TRUNCATE ON financial_account_control` — e provado
  -- pelo catalogo, no bloco de invariantes ao fim deste DO, e pela guarda G3 em pytest.
  BEGIN
    CREATE TEMP TABLE _sonda_truncate (id bigint) ON COMMIT DROP;
    INSERT INTO _sonda_truncate SELECT generate_series(1, 3);
    CREATE TRIGGER trg_sonda_truncate BEFORE TRUNCATE ON _sonda_truncate
      FOR EACH STATEMENT EXECUTE FUNCTION public.fn_audit_truncate();

    TRUNCATE _sonda_truncate;

    SELECT (dados_antes->>'linhas_destruidas')::bigint INTO v_trunc_linhas
      FROM public.audit_log WHERE tabela = '_sonda_truncate' AND operacao = 'TRUNCATE';
    RAISE EXCEPTION 'ROLLBACK_SONDA' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN raise_exception THEN NULL;
    WHEN others          THEN v_trunc_erro := SQLSTATE || ' — ' || SQLERRM;
  END;

  IF v_trunc_erro IS NOT NULL THEN
    RAISE EXCEPTION 'ABORTADO: fn_audit_truncate levantou % — um TRUNCATE passaria a FALHAR',
      v_trunc_erro;
  END IF;
  IF v_trunc_linhas IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'ABORTADO: fn_audit_truncate contou % linhas, esperado 3 — em AFTER a tabela '
                    'ja estaria vazia e o numero seria inalcancavel', v_trunc_linhas;
  END IF;

  -- Invariantes de segurança, independentes de haver dado.
  IF has_table_privilege('anon', 'public.audit_log', 'SELECT') THEN
    RAISE EXCEPTION 'ABORTADO: anon continua com SELECT em audit_log';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'audit_log' AND 'public' = ANY (roles)) THEN
    RAISE EXCEPTION 'ABORTADO: sobrou policy TO public em audit_log';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fn_audit_row'::regproc) THEN
    RAISE EXCEPTION 'ABORTADO: fn_audit_row nao e SECURITY DEFINER — a curadoria quebraria';
  END IF;
  IF has_function_privilege('anon', 'public.audit_sensitive_fields()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.audit_ignored_fields()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: anon ficou com EXECUTE no vocabulario de auditoria';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.audit_sensitive_fields()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORTADO: authenticated perdeu o EXECUTE de audit_sensitive_fields — a tool '
                    'da 118 (SECURITY INVOKER) quebraria';
  END IF;
  -- Trigger de linha tem de ser AFTER: TGTYPE_BEFORE = 2.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('trg_audit_fac', 'trg_audit_supplier') AND (tgtype & 2) <> 0) THEN
    RAISE EXCEPTION 'ABORTADO: trigger de auditoria ficou BEFORE — gravaria valor que as demais '
                    'triggers ainda vao sobrescrever';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. O DO acima já provou o essencial na própria aplicação: 1 linha por UPDATE real, 0 por
--      UPDATE vazio, delta sem colunas de escrituração, ator pelo canal explícito, curadoria por
--      `authenticated` funcionando e nenhuma policy TO public sobrando.
--   2. `anon` sem SELECT; `authenticated` com SELECT apenas pela policy nova.
--   3. Recorte por dono: abrir transação, `SET LOCAL ROLE authenticated`, conferir que a contagem
--      de audit_log muda conforme o grupo do usuário, e desfazer. Privilégio concedido e linha
--      visível são perguntas diferentes — `psql`/MCP conectam como `postgres`, que ignora RLS.
--   4. `get_advisors` sem achado novo.
