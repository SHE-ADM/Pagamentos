-- =============================================================
-- 083_company_sk_company.sql
-- Surrogate key snowflake para EMPRESA: sk_company (bigint) vira a PK
-- auto-incremental (IDENTITY) de `company` e o alvo unico de toda relacao de
-- empresa no app. company_id permanece SOMENTE em `company`, agora como CAMPO
-- DE ORIGEM (NOT NULL UNIQUE) — vindo do sistema maior; pode divergir do sk em
-- cadastros futuros. financial_account_control deixa de ter company_id e passa
-- a referenciar `company` por sk_company.
--
-- Espelha a 042 (supplier -> sk_supplier), a 074 (trigger SECURITY DEFINER) e a
-- 072 (REVOKE EXECUTE da RPC de resolucao). Contexto: foi cadastrada a 2a
-- empresa (LEBIANCO) e criado company.sk_company = company_id.
--
-- Projeto: pagamentos | Data: 2026-07-17
--
-- ATENCAO (one-time — NAO re-executavel; troca de PK/IDENTITY, como 042/050/051):
-- ROLLOUT coordenado (dev e producao compartilham o MESMO Supabase):
--   1. Pausar a task 'Pagamentos - Email Reader' (Disable-ScheduledTask).
--   2. Aplicar esta migration no SQL Editor / Supabase MCP.
--   3. Copiar read_emails.py (company_cnpj) e cobranca/supabase_log.py
--      (fetch_company_smtp) atualizados p/ C:\Sheild\API\Pagamentos\... (leem
--      company por sk_company=eq.1 no lugar de company_id=eq.1).
--   4. Redeploy do frontend (shared + supabase.ts novos).
--   5. Reabilitar a task e validar com --dry-run.
--
-- A tabela `company` pre-existe (nao foi criada por migration): o nome da PK
-- atual e descoberto dinamicamente no bloco DO. Nao ha nenhuma FK apontando
-- para company(company_id) hoje (financial_account_control.company_id nao tem
-- FK), entao a troca de PK e limpa.
-- =============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. company: sk_company vira PK IDENTITY; company_id vira NOT NULL UNIQUE
-- ─────────────────────────────────────────────────────────────

-- 1a. Coluna nova (defensivo — o usuario ja a criou) + backfill. sk_company
--     espelha company_id para as linhas atuais (OTIMOTEX=1, LEBIANCO=2).
ALTER TABLE company ADD COLUMN IF NOT EXISTS sk_company BIGINT;
UPDATE company SET sk_company = company_id WHERE sk_company IS NULL;
ALTER TABLE company ALTER COLUMN sk_company SET NOT NULL;

-- 1b. Troca de PK: descobre e dropa a PK atual (nome desconhecido — tabela
--     pre-existente) e cria a nova PK sobre sk_company.
DO $$
DECLARE
  v_pk text;
BEGIN
  SELECT conname INTO v_pk
    FROM pg_constraint
   WHERE conrelid = 'public.company'::regclass AND contype = 'p';
  IF v_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE company DROP CONSTRAINT %I', v_pk);
  END IF;

  ALTER TABLE company ADD CONSTRAINT company_pkey PRIMARY KEY (sk_company);
END $$;

-- 1c. company_id vira CAMPO DE ORIGEM: NOT NULL + UNIQUE (mantem relacoes do
--     sistema maior validas), nao mais PK.
ALTER TABLE company ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE company DROP CONSTRAINT IF EXISTS uq_company_company_id;
ALTER TABLE company ADD CONSTRAINT uq_company_company_id UNIQUE (company_id);

-- 1d. sk_company passa a auto-incrementar por IDENTITY propria (independente do
--     company_id externo). Semeia a sequence acima do max atual para o proximo
--     insert = max+1. Inserts externos informam so company_id; o sk e gerado.
--     A coluna criada pelo usuario tinha DEFAULT 0 (sentinela) — dropar antes,
--     pois uma coluna nao pode ter DEFAULT e IDENTITY simultaneamente.
ALTER TABLE company ALTER COLUMN sk_company DROP DEFAULT;
ALTER TABLE company ALTER COLUMN sk_company ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(
  pg_get_serial_sequence('public.company', 'sk_company'),
  (SELECT max(sk_company) FROM company),
  true
);

-- ─────────────────────────────────────────────────────────────
-- 2. Resolucao: resolve_company_sk (retorna sk_company) + trigger SECURITY DEFINER
--    Corpo espelha resolve_company_id (010): cnpj -> legal_name -> trade_name.
--    So muda o retorno (c.sk_company) e o fallback (sk da empresa company_id=1).
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resolve_company_sk(
  p_payer_cnpj TEXT,
  p_payer_name TEXT
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_sk BIGINT;
BEGIN
  -- Passo 1: CNPJ — apenas se nao-nulo, nao-branco e 14 digitos exatos
  IF p_payer_cnpj IS NOT NULL
     AND trim(p_payer_cnpj) <> ''
     AND length(trim(p_payer_cnpj)) = 14
  THEN
    SELECT c.sk_company INTO v_sk
    FROM company c
    WHERE c.cnpj = trim(p_payer_cnpj)
    LIMIT 1;
    IF FOUND THEN RETURN v_sk; END IF;
  END IF;

  -- Passos 2 e 3: nome — apenas se nao-nulo e nao-branco
  IF p_payer_name IS NOT NULL AND trim(p_payer_name) <> '' THEN
    -- Razao social normalizada
    SELECT c.sk_company INTO v_sk
    FROM company c
    WHERE normalize_search(c.legal_name) = normalize_search(p_payer_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_sk; END IF;

    -- Nome fantasia normalizado
    SELECT c.sk_company INTO v_sk
    FROM company c
    WHERE normalize_search(c.trade_name) = normalize_search(p_payer_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_sk; END IF;
  END IF;

  -- Passo 4: fallback padrao = sk_company da empresa pagadora (company_id = 1)
  SELECT c.sk_company INTO v_sk FROM company c WHERE c.company_id = 1 LIMIT 1;
  RETURN v_sk;
END;
$$;

-- Barra a RPC direta por anon/authenticated (mirror 072); so o pipeline
-- (service_role) e o trigger (SECURITY DEFINER, roda como owner) executam.
REVOKE EXECUTE ON FUNCTION public.resolve_company_sk(text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_company_sk(text, text) TO service_role;

-- Reescreve a funcao do trigger: passa a gravar NEW.sk_company. Mantem-se
-- SECURITY DEFINER (licao da 074 — sem isso o UPDATE de curadoria pelo papel
-- `authenticated` quebra com 42501 ao chamar resolve_company_sk).
CREATE OR REPLACE FUNCTION public.trg_fe_resolve_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.sk_company := public.resolve_company_sk(NEW.payer_cnpj, NEW.payer_name);
  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- 3. financial_account_control: company_id -> sk_company
--    O trigger reescrito (2) ja grava NEW.sk_company ANTES do DROP da coluna.
-- ─────────────────────────────────────────────────────────────

-- 3a. Coluna nova + backfill traduzindo company_id -> sk_company via JOIN.
ALTER TABLE financial_account_control ADD COLUMN IF NOT EXISTS sk_company BIGINT;
UPDATE financial_account_control fac
   SET sk_company = c.sk_company
  FROM company c
 WHERE c.company_id = fac.company_id
   AND fac.sk_company IS NULL;

-- Rede de seguranca: company_id era nullable; linha sem empresa -> pagadora (1).
UPDATE financial_account_control
   SET sk_company = (SELECT sk_company FROM company WHERE company_id = 1)
 WHERE sk_company IS NULL;

ALTER TABLE financial_account_control ALTER COLUMN sk_company SET NOT NULL;

-- 3b. FK -> company(sk_company) + indice (antes NAO havia FK para company).
ALTER TABLE financial_account_control DROP CONSTRAINT IF EXISTS fk_fac_company;
ALTER TABLE financial_account_control
  ADD CONSTRAINT fk_fac_company FOREIGN KEY (sk_company) REFERENCES company(sk_company);
CREATE INDEX IF NOT EXISTS idx_fac_sk_company ON financial_account_control (sk_company);

-- 3c. Remove a coluna antiga e seu indice.
DROP INDEX IF EXISTS idx_fac_company_id;
ALTER TABLE financial_account_control DROP COLUMN company_id;

-- 3d. Renomeia o trigger para refletir sk_company (mesma funcao reescrita).
DROP TRIGGER IF EXISTS trg_fe_company_id ON financial_account_control;
DROP TRIGGER IF EXISTS trg_fe_sk_company ON financial_account_control;
CREATE TRIGGER trg_fe_sk_company
  BEFORE INSERT OR UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION public.trg_fe_resolve_company();

-- 4. resolve_company_id ficou orfa (o trigger nao a chama mais; nenhum Python a
--    usa; o sistema maior relaciona por company_id, nao por esta funcao). Sem
--    codigo morto.
DROP FUNCTION IF EXISTS public.resolve_company_id(text, text);

COMMIT;

-- ============================================================================
-- VERIFICACAO (rodar apos aplicar):
--   -- (1) PK de company = sk_company; company_id UNIQUE + NOT NULL:
--   SELECT conname, contype, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conrelid = 'public.company'::regclass
--     AND contype IN ('p','u');
--   -- sk_company e IDENTITY:
--   SELECT attname, attidentity FROM pg_attribute
--   WHERE attrelid='public.company'::regclass AND attname='sk_company';  -- 'a'
--
--   -- (2) fac.sk_company NOT NULL + FK unica p/ company(sk_company); sem company_id:
--   SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name='financial_account_control'
--     AND column_name IN ('sk_company','company_id');  -- so sk_company, NO
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid='public.financial_account_control'::regclass
--     AND conname='fk_fac_company';
--
--   -- (3) resolve_company_sk: ACL sem anon/authenticated, com service_role;
--   --     resolve_company_id nao existe mais:
--   SELECT proname, pg_get_function_identity_arguments(oid), proacl::text
--   FROM pg_proc WHERE proname IN ('resolve_company_sk','resolve_company_id');
--
--   -- (4) trigger do fac e SECURITY DEFINER:
--   SELECT proname, prosecdef FROM pg_proc WHERE proname='trg_fe_resolve_company';
--
--   -- (5) UPDATE de curadoria como `authenticated` nao levanta 42501:
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     UPDATE financial_account_control SET has_invoice = has_invoice
--     WHERE id = (SELECT id FROM financial_account_control LIMIT 1);
--   ROLLBACK;
-- ============================================================================
