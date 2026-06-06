-- =============================================================
-- 010_guard_blank_cnpj_cpf.sql
-- Reforco das funcoes de resolucao: CNPJ/CPF em branco ou nulo
-- nunca disparam pesquisa — cai diretamente na busca por nome.
-- Projeto: pagamentos | Data: 2026-06-06
--
-- Regra: pesquisar por CNPJ/CPF somente quando o valor for
-- nao-nulo, nao-branco E tiver o comprimento correto (14/11).
-- Caso contrario, buscar por nome. CPF e consultado apenas se
-- CNPJ e nome nao resolverem.
-- =============================================================

-- 1. Atualiza resolve_company_id
CREATE OR REPLACE FUNCTION resolve_company_id(
  p_payer_cnpj TEXT,
  p_payer_name TEXT
) RETURNS BIGINT
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_id BIGINT;
BEGIN
  -- Passo 1: CNPJ — apenas se nao-nulo, nao-branco e 14 digitos exatos
  IF p_payer_cnpj IS NOT NULL
     AND trim(p_payer_cnpj) <> ''
     AND length(trim(p_payer_cnpj)) = 14
  THEN
    SELECT c.company_id INTO v_id
    FROM company c
    WHERE c.cnpj = trim(p_payer_cnpj)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passos 2 e 3: nome — apenas se nao-nulo e nao-branco
  IF p_payer_name IS NOT NULL AND trim(p_payer_name) <> '' THEN
    -- Razao social normalizada
    SELECT c.company_id INTO v_id
    FROM company c
    WHERE normalize_search(c.legal_name) = normalize_search(p_payer_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;

    -- Nome fantasia normalizado
    SELECT c.company_id INTO v_id
    FROM company c
    WHERE normalize_search(c.trade_name) = normalize_search(p_payer_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passo 4: fallback padrao
  RETURN 1;
END;
$$;

-- 2. Atualiza resolve_supplier_id
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
  -- Passo 1: CNPJ — apenas se nao-nulo, nao-branco e 14 digitos exatos
  IF p_cnpj IS NOT NULL
     AND trim(p_cnpj) <> ''
     AND length(trim(p_cnpj)) = 14
  THEN
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE s.cnpj = trim(p_cnpj)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passos 2 e 3: nome — apenas se nao-nulo e nao-branco
  IF p_name IS NOT NULL AND trim(p_name) <> '' THEN
    -- Razao social normalizada
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.legal_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;

    -- Nome fantasia normalizado
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.trade_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passo 4: CPF — apenas se nao-nulo, nao-branco e 11 digitos exatos
  --          (buscado apos nome para evitar colisao entre pessoas fisicas)
  IF p_cpf IS NOT NULL
     AND trim(p_cpf) <> ''
     AND length(trim(p_cpf)) = 11
  THEN
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE s.cpf = trim(p_cpf)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Nao encontrado: INSERT automatico com dados disponiveis
  v_legal := NULLIF(trim(COALESCE(p_name, '')), '');
  v_trade := v_legal;

  INSERT INTO supplier (cnpj, cpf, legal_name, trade_name)
  VALUES (
    NULLIF(trim(COALESCE(p_cnpj, '')), ''),
    NULLIF(trim(COALESCE(p_cpf,  '')), ''),
    COALESCE(v_legal, v_trade),
    COALESCE(v_trade, v_legal)
  )
  RETURNING supplier_id INTO v_id;

  RETURN v_id;
END;
$$;
