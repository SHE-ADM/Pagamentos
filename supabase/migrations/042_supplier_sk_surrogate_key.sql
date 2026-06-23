-- =============================================================
-- 042_supplier_sk_surrogate_key.sql
-- Surrogate key snowflake: sk_supplier (bigint) vira a PK auto-incremental de
-- `supplier` e o alvo de toda FK de fornecedor. supplier_id permanece SOMENTE em
-- `supplier`, agora como CHAVE DE NEGOCIO (NOT NULL UNIQUE) — vinda da arquitetura
-- snowflake maior; pode divergir do sk em cargas externas. Para fornecedores criados
-- pela extracao de e-mail (sem chave externa), supplier_id = sk_supplier (trigger de
-- espelho). financial_account_control deixa de ter supplier_id e passa a referenciar
-- supplier por sk_supplier.
--
-- Projeto: pagamentos | Data: 2026-06-23
--
-- ATENCAO (rollout coordenado — dev e producao compartilham o MESMO Supabase):
--   1. Pausar a task 'Pagamentos - Email Reader' (Disable-ScheduledTask).
--   2. Aplicar esta migration no SQL Editor.
--   3. Copiar o read_emails.py atualizado p/ C:\Sheild\API\Pagamentos\skills\
--      email-reader\scripts\ (grava sk_supplier no lugar de supplier_id).
--   4. Redeploy do frontend (shared + supabase.ts novos).
--   5. Reabilitar a task e validar com --dry-run.
--
-- A tabela `supplier` pre-existe (nao foi criada por migration): o nome da PK atual
-- e a sequence/identidade de supplier_id sao descobertos dinamicamente no bloco DO.
-- =============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. supplier: adiciona sk_supplier e o torna PK auto-incremental
-- ─────────────────────────────────────────────────────────────

-- 1a. Coluna nova + backfill (todos os fornecedores atuais foram criados localmente,
--     entao sk_supplier = supplier_id para as linhas existentes).
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS sk_supplier BIGINT;
UPDATE supplier SET sk_supplier = supplier_id WHERE sk_supplier IS NULL;
ALTER TABLE supplier ALTER COLUMN sk_supplier SET NOT NULL;

-- 1b. Troca de PK + auto-incremento (defensivo p/ serial OU identity).
DO $$
DECLARE
  v_seq         text;
  v_pk          text;
  v_is_identity boolean;
BEGIN
  -- Como supplier_id gera valor hoje? (identity 'a'/'d' vs serial/default)
  SELECT (attidentity IN ('a', 'd')) INTO v_is_identity
    FROM pg_attribute
   WHERE attrelid = 'public.supplier'::regclass AND attname = 'supplier_id';

  -- Sequence atual de supplier_id (capturada ANTES de neutralizar a geracao).
  v_seq := pg_get_serial_sequence('public.supplier', 'supplier_id');

  -- Derruba a FK dependente antes de mexer na PK de supplier.
  ALTER TABLE financial_account_control DROP CONSTRAINT IF EXISTS fk_fe_supplier;

  -- Descobre e dropa a PK atual de supplier (nome desconhecido — tabela pre-existente).
  SELECT conname INTO v_pk
    FROM pg_constraint
   WHERE conrelid = 'public.supplier'::regclass AND contype = 'p';
  IF v_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE supplier DROP CONSTRAINT %I', v_pk);
  END IF;

  -- Nova PK = sk_supplier.
  ALTER TABLE supplier ADD CONSTRAINT supplier_pkey PRIMARY KEY (sk_supplier);

  -- Neutraliza a geracao automatica de supplier_id (vira chave de negocio).
  IF v_is_identity THEN
    EXECUTE 'ALTER TABLE supplier ALTER COLUMN supplier_id DROP IDENTITY IF EXISTS';
    v_seq := NULL;  -- a sequence da identity e removida junto: nao reaproveitavel
  ELSE
    EXECUTE 'ALTER TABLE supplier ALTER COLUMN supplier_id DROP DEFAULT';
  END IF;

  -- sk_supplier passa a auto-incrementar: reaproveita a sequence antiga (serial) ou
  -- cria uma nova semeada em max(sk_supplier)+1 (identity).
  IF v_seq IS NOT NULL THEN
    EXECUTE format('ALTER SEQUENCE %s OWNED BY supplier.sk_supplier', v_seq);
    EXECUTE format('ALTER TABLE supplier ALTER COLUMN sk_supplier SET DEFAULT nextval(%L)', v_seq);
  ELSE
    CREATE SEQUENCE IF NOT EXISTS supplier_sk_supplier_seq OWNED BY supplier.sk_supplier;
    PERFORM setval('supplier_sk_supplier_seq',
                   COALESCE((SELECT max(sk_supplier) FROM supplier), 0) + 1, false);
    ALTER TABLE supplier ALTER COLUMN sk_supplier SET DEFAULT nextval('supplier_sk_supplier_seq');
  END IF;
END $$;

-- 1c. supplier_id vira chave de negocio: NOT NULL + UNIQUE (nao mais PK).
ALTER TABLE supplier ALTER COLUMN supplier_id SET NOT NULL;
ALTER TABLE supplier DROP CONSTRAINT IF EXISTS uq_supplier_supplier_id;
ALTER TABLE supplier ADD CONSTRAINT uq_supplier_supplier_id UNIQUE (supplier_id);

-- 1d. Trigger de espelho: fornecedor novo SEM supplier_id (criado pela extracao)
--     recebe supplier_id = sk_supplier. O DEFAULT de sk_supplier ja esta preenchido
--     quando o BEFORE INSERT dispara. Carga externa que informa supplier_id o mantem.
CREATE OR REPLACE FUNCTION trg_supplier_mirror_business_id()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supplier_id IS NULL THEN
    NEW.supplier_id := NEW.sk_supplier;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_supplier_mirror_id ON supplier;
CREATE TRIGGER trg_supplier_mirror_id
  BEFORE INSERT ON supplier
  FOR EACH ROW EXECUTE FUNCTION trg_supplier_mirror_business_id();

-- ─────────────────────────────────────────────────────────────
-- 2. Funcoes de resolucao: passam a keyar/retornar sk_supplier
--    (corpos espelham 013/027/028/040 — troca supplier_id->sk_supplier APENAS no
--    contexto da tabela supplier; os parametros p_supplier_id mantem o nome para nao
--    exigir DROP da funcao, mas agora carregam o VALOR DO SURROGATE sk_supplier.)
-- ─────────────────────────────────────────────────────────────

-- 2a. _enrich_supplier (013): keya por sk_supplier.
CREATE OR REPLACE FUNCTION _enrich_supplier(
  p_supplier_id BIGINT,   -- carrega sk_supplier
  p_cnpj        TEXT,
  p_cpf         TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF p_cnpj IS NOT NULL
     AND trim(p_cnpj) <> ''
     AND length(trim(p_cnpj)) = 14
  THEN
    UPDATE supplier
    SET    cnpj = trim(p_cnpj)
    WHERE  sk_supplier = p_supplier_id
      AND  (cnpj IS NULL OR trim(cnpj) = '')
      AND  NOT EXISTS (
             SELECT 1 FROM supplier s2
             WHERE  s2.cnpj = trim(p_cnpj)
               AND  s2.sk_supplier <> p_supplier_id
           );
  END IF;

  IF p_cpf IS NOT NULL
     AND trim(p_cpf) <> ''
     AND length(trim(p_cpf)) = 11
  THEN
    UPDATE supplier
    SET    cpf = trim(p_cpf)
    WHERE  sk_supplier = p_supplier_id
      AND  (cpf IS NULL OR trim(cpf) = '')
      AND  NOT EXISTS (
             SELECT 1 FROM supplier s2
             WHERE  s2.cpf = trim(p_cpf)
               AND  s2.sk_supplier <> p_supplier_id
           );
  END IF;
END;
$$;

-- 2b. _enrich_supplier_name (027): keya por sk_supplier.
CREATE OR REPLACE FUNCTION _enrich_supplier_name(
  p_supplier_id BIGINT,   -- carrega sk_supplier
  p_name        TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' OR _looks_like_email(p_name) THEN
    RETURN;
  END IF;

  UPDATE supplier
  SET    legal_name = trim(p_name),
         trade_name = trim(p_name)
  WHERE  sk_supplier = p_supplier_id
    AND  (_looks_like_email(legal_name) OR _looks_like_email(trade_name));
END;
$$;

-- 2c. _add_supplier_email (028): keya por sk_supplier.
CREATE OR REPLACE FUNCTION _add_supplier_email(
  p_supplier_id BIGINT,   -- carrega sk_supplier
  p_email       TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_email TEXT := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_row   supplier%ROWTYPE;
BEGIN
  IF v_email IS NULL THEN RETURN; END IF;

  SELECT * INTO v_row FROM supplier WHERE sk_supplier = p_supplier_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_email IN (
       lower(trim(COALESCE(v_row.email,  ''))),
       lower(trim(COALESCE(v_row.email2, ''))),
       lower(trim(COALESCE(v_row.email3, ''))),
       lower(trim(COALESCE(v_row.email4, '')))
     ) THEN
    RETURN;
  END IF;

  IF NULLIF(trim(COALESCE(v_row.email, '')), '') IS NULL THEN
    UPDATE supplier SET email  = v_email WHERE sk_supplier = p_supplier_id;
  ELSIF NULLIF(trim(COALESCE(v_row.email2, '')), '') IS NULL THEN
    UPDATE supplier SET email2 = v_email WHERE sk_supplier = p_supplier_id;
  ELSIF NULLIF(trim(COALESCE(v_row.email3, '')), '') IS NULL THEN
    UPDATE supplier SET email3 = v_email WHERE sk_supplier = p_supplier_id;
  ELSIF NULLIF(trim(COALESCE(v_row.email4, '')), '') IS NULL THEN
    UPDATE supplier SET email4 = v_email WHERE sk_supplier = p_supplier_id;
  END IF;
END;
$$;

-- 2d. resolve_supplier_id (027/028): SELECTs retornam sk_supplier; auto-INSERT
--     confia no DEFAULT de sk_supplier + trigger de espelho, RETURNING sk_supplier.
CREATE OR REPLACE FUNCTION resolve_supplier_id(
  p_cnpj  TEXT,
  p_cpf   TEXT,
  p_name  TEXT,
  p_email TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE AS $$
DECLARE
  v_id    BIGINT;   -- carrega sk_supplier
  v_legal TEXT;
  v_trade TEXT;
  v_email TEXT := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
BEGIN
  -- Passo 1: CNPJ — 14 digitos exatos
  IF p_cnpj IS NOT NULL
     AND trim(p_cnpj) <> ''
     AND length(trim(p_cnpj)) = 14
  THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE s.cnpj = trim(p_cnpj)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passo 2: CPF — 11 digitos exatos
  IF p_cpf IS NOT NULL
     AND trim(p_cpf) <> ''
     AND length(trim(p_cpf)) = 11
  THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE s.cpf = trim(p_cpf)
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      PERFORM _enrich_supplier_name(v_id, p_name);
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 3: E-MAIL exato em qualquer um dos 4 campos (case-insensitive).
  IF v_email IS NOT NULL THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE v_email IN (
            lower(trim(s.email)),
            lower(trim(s.email2)),
            lower(trim(s.email3)),
            lower(trim(s.email4))
          )
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      PERFORM _enrich_supplier_name(v_id, p_name);
      RETURN v_id;
    END IF;
  END IF;

  -- Passos 4 e 5: nome (razao social, depois nome fantasia)
  IF p_name IS NOT NULL AND trim(p_name) <> '' THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE normalize_search(s.legal_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;

    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE normalize_search(s.trade_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;
  END IF;

  -- Nao encontrado: valida antes de inserir
  v_legal := NULLIF(trim(COALESCE(p_name, '')), '');
  v_trade := v_legal;

  IF NULLIF(trim(COALESCE(p_cnpj, '')), '') IS NULL
     AND NULLIF(trim(COALESCE(p_cpf,  '')), '') IS NULL
     AND v_legal IS NULL
     AND v_email IS NULL
  THEN
    RAISE EXCEPTION
      'resolve_supplier_id: nenhum identificador valido (cnpj, cpf, nome e e-mail ausentes)';
  END IF;

  -- INSERT sem supplier_id: a trigger trg_supplier_mirror_id grava supplier_id =
  -- sk_supplier (gerado pelo DEFAULT). Devolve o surrogate.
  INSERT INTO supplier (cnpj, cpf, legal_name, trade_name, email)
  VALUES (
    NULLIF(trim(COALESCE(p_cnpj, '')), ''),
    NULLIF(trim(COALESCE(p_cpf,  '')), ''),
    COALESCE(v_legal, v_email),
    COALESCE(v_trade, v_email),
    v_email
  )
  RETURNING sk_supplier INTO v_id;

  RETURN v_id;
END;
$$;

-- 2e. resolve_supplier_for_account (040): devolve sk_supplier (corpo inalterado —
--     resolve_supplier_id ja retorna o surrogate; _add_supplier_email keya por sk).
CREATE OR REPLACE FUNCTION public.resolve_supplier_for_account(
  p_cnpj  text,
  p_cpf   text,
  p_name  text,
  p_email text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id bigint;   -- sk_supplier
BEGIN
  v_id := resolve_supplier_id(p_cnpj, p_cpf, p_name, p_email);
  PERFORM _add_supplier_email(v_id, p_email);
  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_supplier_for_account(text, text, text, text) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. financial_account_control: supplier_id -> sk_supplier
-- ─────────────────────────────────────────────────────────────

-- 3a. Coluna nova + backfill traduzindo supplier_id -> sk_supplier via JOIN
--     (ambas as colunas de supplier coexistem neste ponto).
ALTER TABLE financial_account_control ADD COLUMN IF NOT EXISTS sk_supplier BIGINT;
UPDATE financial_account_control fac
   SET sk_supplier = s.sk_supplier
  FROM supplier s
 WHERE s.supplier_id = fac.supplier_id
   AND fac.sk_supplier IS NULL;
ALTER TABLE financial_account_control ALTER COLUMN sk_supplier SET NOT NULL;

-- 3b. FK -> supplier(sk_supplier) + indice.
ALTER TABLE financial_account_control DROP CONSTRAINT IF EXISTS fk_fac_supplier;
ALTER TABLE financial_account_control
  ADD CONSTRAINT fk_fac_supplier FOREIGN KEY (sk_supplier) REFERENCES supplier(sk_supplier);
CREATE INDEX IF NOT EXISTS idx_fac_sk_supplier ON financial_account_control (sk_supplier);

-- 3c. Remove a coluna antiga e seu indice. A FK fk_fe_supplier ja foi dropada no
--     bloco DO; sobra exatamente UMA FK p/ supplier (sk_supplier) — embedding
--     PostgREST supplier(...) resolve sem ambiguidade.
DROP INDEX IF EXISTS idx_fac_supplier_id;
ALTER TABLE financial_account_control DROP COLUMN supplier_id;

COMMIT;
