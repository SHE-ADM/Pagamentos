-- =============================================================
-- 027_resolve_supplier_by_email.sql
-- Reconhecimento de fornecedor por E-MAIL quando nao ha CNPJ/CPF.
--
-- Contexto: e-mails extraidos pelo corpo (extraction_source='email_body') sem
-- rotulo de fornecedor nem CNPJ caem no remetente como supplier_name. Isso criava
-- fornecedores duplicados para a mesma empresa (ex.: "Smart Web Services" tinha 3
-- cadastros: o nome real via PDF + dois e-mails como nome via corpo).
--
-- Regra de negocio (decidida com o responsavel): o e-mail do remetente e estavel e
-- constante por fornecedor; na falta de identificador fiscal, e a melhor chave de
-- reconhecimento. E raramente um fornecedor tem como trade_name/legal_name um
-- endereco de e-mail — logo, nome em formato de e-mail e sinal de fallback e deve
-- ceder ao nome real quando este aparecer.
--
-- Mudancas:
--   1. resolve_supplier_id ganha p_email; ordem CNPJ -> CPF -> EMAIL exato -> nome.
--   2. Ao casar, se o nome cadastrado parece e-mail e chega um nome real, atualiza.
--   3. O trigger passa NEW.sender_email para a resolucao.
--
-- Limitacao conhecida: o match e por e-mail EXATO (seguro ate para dominios
-- publicos). Fornecedor que envia de enderecos diferentes (boleto@ e financeiro@)
-- ainda pode duplicar; match por dominio foi deliberadamente evitado pelo risco
-- com dominios publicos (gmail/hotmail). supplier.email guarda o remetente mais
-- recente (trigger 023), nao todos os enderecos.
-- Projeto: pagamentos | Data: 2026-06-16
-- =============================================================

-- ---------------------------------------------------------------------------
-- Helper: o texto tem formato de endereco de e-mail?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _looks_like_email(p_text TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE AS $$
  SELECT p_text IS NOT NULL
     AND trim(p_text) ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
$$;

-- ---------------------------------------------------------------------------
-- Helper: troca nome em formato de e-mail pelo nome real, quando este chega.
-- So atualiza se o cadastro atual parece e-mail e o novo nome NAO parece.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _enrich_supplier_name(
  p_supplier_id BIGINT,
  p_name        TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' OR _looks_like_email(p_name) THEN
    RETURN;  -- nome novo ausente ou tambem em formato de e-mail: nada a fazer
  END IF;

  UPDATE supplier
  SET    legal_name = trim(p_name),
         trade_name = trim(p_name)
  WHERE  supplier_id = p_supplier_id
    AND  (_looks_like_email(legal_name) OR _looks_like_email(trade_name));
END;
$$;

-- ---------------------------------------------------------------------------
-- resolve_supplier_id com reconhecimento por e-mail
-- Ordem: CNPJ -> CPF -> EMAIL exato -> legal_name -> trade_name -> insere novo
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS resolve_supplier_id(TEXT, TEXT, TEXT);

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

  -- Passo 2: CPF — identificador fiscal forte, antes do e-mail e do nome
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

  -- Passo 3: E-MAIL exato — chave de reconhecimento quando nao ha id fiscal.
  -- Match exato (case-insensitive) e seguro ate para dominios publicos.
  IF v_email IS NOT NULL THEN
    SELECT s.supplier_id INTO v_id
    FROM supplier s
    WHERE lower(trim(s.email)) = v_email
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      PERFORM _enrich_supplier_name(v_id, p_name);
      RETURN v_id;
    END IF;
  END IF;

  -- Passos 4 e 5: nome — apenas se nao-nulo e nao-branco
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

  -- Sem nenhum nome, mas com e-mail: usa o e-mail como nome provisorio (sera
  -- promovido ao nome real assim que um PDF/identificacao melhor chegar).
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
-- Trigger passa a fornecer o e-mail do remetente a resolucao
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

  -- Alinha supplier.email com o remetente do e-mail (sender_email gravado na conta).
  IF NEW.sender_email IS NOT NULL AND trim(NEW.sender_email) <> '' THEN
    UPDATE supplier
    SET    email = trim(NEW.sender_email)
    WHERE  supplier_id = NEW.supplier_id;
  END IF;

  RETURN NEW;
END;
$$;
