-- =============================================================
-- 013_enrich_supplier_on_match.sql
-- Enriquece supplier quando encontrado por nome ou CPF:
-- se o registro nao tem CNPJ/CPF mas a extracao atual forneceu
-- um valor valido, grava o campo ausente.
--
-- Regras:
--   - So enriquece quando o campo atual e NULL ou vazio
--   - So enriquece quando nenhum outro supplier ja usa o valor
--   - Aplica-se apos passos 2, 3 (nome) e 4 (CPF) da resolucao
--   - Passo 1 (CNPJ exato) nao precisa: o CNPJ ja esta gravado
-- Projeto: pagamentos | Data: 2026-06-06
-- =============================================================

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
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;

    -- Nome fantasia normalizado
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.trade_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;
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

-- Funcao auxiliar: enriquece cnpj/cpf ausentes sem colidir com outros registros
CREATE OR REPLACE FUNCTION _enrich_supplier(
  p_supplier_id BIGINT,
  p_cnpj        TEXT,
  p_cpf         TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- Atualiza CNPJ se: valido, ausente no registro, nao usado por outro
  IF p_cnpj IS NOT NULL
     AND trim(p_cnpj) <> ''
     AND length(trim(p_cnpj)) = 14
  THEN
    UPDATE supplier
    SET    cnpj = trim(p_cnpj)
    WHERE  supplier_id = p_supplier_id
      AND  (cnpj IS NULL OR trim(cnpj) = '')
      AND  NOT EXISTS (
             SELECT 1 FROM supplier s2
             WHERE  s2.cnpj = trim(p_cnpj)
               AND  s2.supplier_id <> p_supplier_id
           );
  END IF;

  -- Atualiza CPF se: valido, ausente no registro, nao usado por outro
  IF p_cpf IS NOT NULL
     AND trim(p_cpf) <> ''
     AND length(trim(p_cpf)) = 11
  THEN
    UPDATE supplier
    SET    cpf = trim(p_cpf)
    WHERE  supplier_id = p_supplier_id
      AND  (cpf IS NULL OR trim(cpf) = '')
      AND  NOT EXISTS (
             SELECT 1 FROM supplier s2
             WHERE  s2.cpf = trim(p_cpf)
               AND  s2.supplier_id <> p_supplier_id
           );
  END IF;
END;
$$;
