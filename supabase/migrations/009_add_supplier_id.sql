-- =============================================================
-- 009_add_supplier_id.sql
-- Relaciona financial_emails com supplier (beneficiario/credor).
-- Projeto: pagamentos | Data: 2026-06-06
--
-- Fluxo de resolucao (funcao resolve_supplier_id):
--   1. CNPJ exato (14 digitos):   supplier_cnpj -> supplier.cnpj
--   2. Razao social normalizada:  supplier_name -> supplier.legal_name
--   3. Nome fantasia normalizado: supplier_name -> supplier.trade_name
--   4. CPF exato (11 digitos):    supplier_cpf  -> supplier.cpf
--   Nao encontrado: INSERT automatico com dados disponiveis.
--
-- Regras do INSERT:
--   - legal_name vazio -> usa trade_name
--   - trade_name vazio -> usa legal_name
--   - supplier_id NUNCA pode ser nulo ou zero
--
-- SECURITY DEFINER: a funcao executa como postgres (owner) para contornar
-- o RLS de supplier em inserts automaticos de novos fornecedores.
-- =============================================================

-- 1. Funcao de resolucao — SECURITY DEFINER para bypass de RLS no INSERT
CREATE OR REPLACE FUNCTION resolve_supplier_id(
  p_cnpj TEXT,
  p_cpf  TEXT,
  p_name TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE AS $$
DECLARE
  v_id    BIGINT;
  v_legal TEXT;
  v_trade TEXT;
BEGIN
  -- Passo 1: CNPJ exato (14 digitos)
  IF p_cnpj IS NOT NULL AND length(trim(p_cnpj)) = 14 THEN
    SELECT s.supplier_id INTO v_id
    FROM supplier s WHERE s.cnpj = trim(p_cnpj) LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  IF p_name IS NOT NULL AND trim(p_name) <> '' THEN
    -- Passo 2: razao social normalizada (legal_name)
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.legal_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;

    -- Passo 3: nome fantasia normalizado (trade_name)
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.trade_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passo 4: CPF exato (11 digitos)
  IF p_cpf IS NOT NULL AND length(trim(p_cpf)) = 11 THEN
    SELECT s.supplier_id INTO v_id
    FROM supplier s WHERE s.cpf = trim(p_cpf) LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Nao encontrado: INSERT automatico com dados disponiveis
  v_legal := NULLIF(trim(COALESCE(p_name, '')), '');
  v_trade := v_legal;

  INSERT INTO supplier (cnpj, cpf, legal_name, trade_name)
  VALUES (
    NULLIF(trim(COALESCE(p_cnpj, '')), ''),
    NULLIF(trim(COALESCE(p_cpf,  '')), ''),
    COALESCE(v_legal, v_trade),  -- legal_name vazio: usa trade_name
    COALESCE(v_trade, v_legal)   -- trade_name vazio: usa legal_name
  )
  RETURNING supplier_id INTO v_id;

  RETURN v_id;
END;
$$;

-- 2. Novos campos em financial_emails
ALTER TABLE financial_emails
  ADD COLUMN IF NOT EXISTS supplier_cpf CHAR(11),
  ADD COLUMN IF NOT EXISTS supplier_id  BIGINT;

-- 3. Backfill das linhas existentes (funcao ja tem SECURITY DEFINER)
UPDATE financial_emails
SET supplier_id = resolve_supplier_id(supplier_cnpj, supplier_cpf, supplier_name)
WHERE supplier_id IS NULL;

-- 4. NOT NULL + FK (todas as linhas ja tem valor apos o backfill)
ALTER TABLE financial_emails
  ALTER COLUMN supplier_id SET NOT NULL,
  ADD CONSTRAINT fk_fe_supplier
    FOREIGN KEY (supplier_id) REFERENCES supplier(supplier_id);

-- 5. Trigger
CREATE OR REPLACE FUNCTION trg_fe_resolve_supplier()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.supplier_id := resolve_supplier_id(
    NEW.supplier_cnpj,
    NEW.supplier_cpf,
    NEW.supplier_name
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fe_supplier_id ON financial_emails;
CREATE TRIGGER trg_fe_supplier_id
  BEFORE INSERT OR UPDATE OF supplier_cnpj, supplier_cpf, supplier_name
  ON financial_emails
  FOR EACH ROW EXECUTE FUNCTION trg_fe_resolve_supplier();

-- 6. Indice para consultas por fornecedor
CREATE INDEX IF NOT EXISTS idx_fe_supplier_id ON financial_emails (supplier_id);
