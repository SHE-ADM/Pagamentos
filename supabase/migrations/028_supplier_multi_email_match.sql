-- =============================================================
-- 028_supplier_multi_email_match.sql
-- Multiplos e-mails por fornecedor (email, email2, email3, email4).
--
-- Contexto: a tabela supplier ganhou email2/email3/email4 para que um mesmo
-- fornecedor que envia de enderecos diferentes (ex.: boleto@ e financeiro@)
-- seja reconhecido por qualquer um deles. A migration 027 so casava/gravava a
-- coluna 'email'.
--
-- Mudancas:
--   1. resolve_supplier_id passa a casar o remetente contra email/2/3/4.
--   2. O trigger ACRESCENTA o remetente no primeiro campo vazio (email -> email2
--      -> email3 -> email4) em vez de sobrescrever 'email'. Ignora duplicado
--      (case-insensitive) e, com os 4 campos cheios, ignora o excedente.
-- Projeto: pagamentos | Data: 2026-06-16
-- =============================================================

-- ---------------------------------------------------------------------------
-- Helper: registra um e-mail de remetente no primeiro campo livre do fornecedor.
-- Preserva os e-mails ja cadastrados; nunca sobrescreve nem duplica.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _add_supplier_email(
  p_supplier_id BIGINT,
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

  SELECT * INTO v_row FROM supplier WHERE supplier_id = p_supplier_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Ja presente em qualquer coluna (case-insensitive)? nada a fazer.
  IF v_email IN (
       lower(trim(COALESCE(v_row.email,  ''))),
       lower(trim(COALESCE(v_row.email2, ''))),
       lower(trim(COALESCE(v_row.email3, ''))),
       lower(trim(COALESCE(v_row.email4, '')))
     ) THEN
    RETURN;
  END IF;

  -- Primeiro campo vazio recebe o novo e-mail.
  IF NULLIF(trim(COALESCE(v_row.email, '')), '') IS NULL THEN
    UPDATE supplier SET email  = v_email WHERE supplier_id = p_supplier_id;
  ELSIF NULLIF(trim(COALESCE(v_row.email2, '')), '') IS NULL THEN
    UPDATE supplier SET email2 = v_email WHERE supplier_id = p_supplier_id;
  ELSIF NULLIF(trim(COALESCE(v_row.email3, '')), '') IS NULL THEN
    UPDATE supplier SET email3 = v_email WHERE supplier_id = p_supplier_id;
  ELSIF NULLIF(trim(COALESCE(v_row.email4, '')), '') IS NULL THEN
    UPDATE supplier SET email4 = v_email WHERE supplier_id = p_supplier_id;
  END IF;
  -- Os 4 campos cheios: limite atingido, ignora o excedente.
END;
$$;

-- ---------------------------------------------------------------------------
-- resolve_supplier_id: match por e-mail considera os 4 campos.
-- Ordem inalterada: CNPJ -> CPF -> EMAIL (1..4) -> nome -> insere novo.
-- ---------------------------------------------------------------------------
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
  v_id    BIGINT;
  v_legal TEXT;
  v_trade TEXT;
  v_email TEXT := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
BEGIN
  -- Passo 1: CNPJ — 14 digitos exatos
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

  -- Passo 2: CPF — 11 digitos exatos
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
      PERFORM _enrich_supplier_name(v_id, p_name);
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 3: E-MAIL exato em qualquer um dos 4 campos (case-insensitive).
  IF v_email IS NOT NULL THEN
    SELECT s.supplier_id INTO v_id
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
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE normalize_search(s.legal_name) = normalize_search(p_name)
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;

    SELECT s.supplier_id INTO v_id
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

  INSERT INTO supplier (cnpj, cpf, legal_name, trade_name, email)
  VALUES (
    NULLIF(trim(COALESCE(p_cnpj, '')), ''),
    NULLIF(trim(COALESCE(p_cpf,  '')), ''),
    COALESCE(v_legal, v_email),
    COALESCE(v_trade, v_email),
    v_email
  )
  RETURNING supplier_id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger: acrescenta o remetente no primeiro campo de e-mail livre.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fe_resolve_supplier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  NEW.supplier_id := resolve_supplier_id(
    NEW.supplier_cnpj,
    NEW.supplier_cpf,
    NEW.supplier_name,
    NEW.sender_email
  );

  PERFORM _add_supplier_email(NEW.supplier_id, NEW.sender_email);

  RETURN NEW;
END;
$$;
