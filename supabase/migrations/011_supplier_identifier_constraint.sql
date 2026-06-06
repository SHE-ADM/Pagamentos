-- =============================================================
-- 011_supplier_identifier_constraint.sql
-- Garante que todo registro de supplier tenha pelo menos um
-- identificador valido: cnpj, cpf, legal_name ou trade_name.
--
-- Regra: sem cnpj e sem cpf e permitido, desde que legal_name
-- ou trade_name estejam preenchidos.
-- Projeto: pagamentos | Data: 2026-06-06
-- =============================================================

-- 1. CHECK constraint na tabela
ALTER TABLE supplier
  ADD CONSTRAINT chk_supplier_has_identifier CHECK (
    trim(COALESCE(cnpj,       '')) <> ''
    OR trim(COALESCE(cpf,        '')) <> ''
    OR trim(COALESCE(legal_name, '')) <> ''
    OR trim(COALESCE(trade_name, '')) <> ''
  );

-- 2. Atualiza resolve_supplier_id: guarda pre-INSERT quando nenhum
--    identificador esta disponivel (evita violacao de constraint e
--    da mensagem de erro explicita ao inves de falha silenciosa).
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
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.legal_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;

    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.trade_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passo 4: CPF — apenas se nao-nulo, nao-branco e 11 digitos exatos
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

  -- Nao encontrado: valida antes de inserir
  v_legal := NULLIF(trim(COALESCE(p_name, '')), '');
  v_trade := v_legal;

  -- Guarda: rejeita INSERT sem nenhum identificador valido
  IF NULLIF(trim(COALESCE(p_cnpj, '')), '') IS NULL
     AND NULLIF(trim(COALESCE(p_cpf,  '')), '') IS NULL
     AND v_legal IS NULL
  THEN
    RAISE EXCEPTION
      'resolve_supplier_id: nenhum identificador valido (cnpj, cpf e nome ausentes ou em branco)';
  END IF;

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
