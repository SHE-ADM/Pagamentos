-- =============================================================
-- 046_supplier_resolution_name_before_email.sql
-- Corrige a ORDEM de resolução de fornecedor e bloqueia e-mails de domínio interno.
--
-- Problema (bug): em resolve_supplier_id a busca por E-MAIL vinha ANTES da busca por
-- NOME. Como pagamentos internos são encaminhados por remetentes internos
-- (ester@otimotex.com.br, etc.) cadastrados num fornecedor, TODO pagável colapsava
-- nesse fornecedor (ex.: "RICARDO SANTOS" recebendo MONOCAR, Eliezer, Emerson…),
-- ignorando o NOME do corpo/anexo.
--
-- Regra correta (decisão de negócio):
--   CNPJ → CPF → NOME (razão social, depois fantasia) → E-MAIL.
--   O e-mail só é usado para busca na AUSÊNCIA TOTAL de nome de fornecedor.
--   (O nome já chega com a precedência anexo→corpo definida no pipeline Python.)
--
-- Domínios internos (otimotex.com.br, lebianco.com.br) NUNCA são gravados nos
-- campos de e-mail de `supplier` — nem no auto-insert, nem no _add_supplier_email.
--
-- Projeto: pagamentos | Data: 2026-06-23
-- =============================================================

BEGIN;

-- 0) Helper: e-mail pertence a um domínio interno? (não é fornecedor real).
CREATE OR REPLACE FUNCTION public._is_internal_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT lower(trim(COALESCE(p_email, ''))) LIKE '%@otimotex.com.br'
      OR lower(trim(COALESCE(p_email, ''))) LIKE '%@lebianco.com.br';
$function$;

-- 1) _add_supplier_email: ignora e-mails de domínio interno (guard de gravação).
CREATE OR REPLACE FUNCTION public._add_supplier_email(p_supplier_id bigint, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_email TEXT := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_row   supplier%ROWTYPE;
BEGIN
  IF v_email IS NULL THEN RETURN; END IF;
  -- Domínios internos não são gravados em supplier (migration 046).
  IF _is_internal_email(v_email) THEN RETURN; END IF;

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
$function$;

-- 2) resolve_supplier_id: NOME antes do E-MAIL; e-mail só sem nome; sem gravar
--    e-mail interno no auto-insert.
CREATE OR REPLACE FUNCTION public.resolve_supplier_id(p_cnpj text, p_cpf text, p_name text, p_email text DEFAULT NULL::text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id          BIGINT;   -- carrega sk_supplier
  v_legal       TEXT;
  v_trade       TEXT;
  v_email       TEXT    := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_has_name    BOOLEAN := (p_name IS NOT NULL AND trim(p_name) <> '');
  v_email_store TEXT;
BEGIN
  -- Passo 1: CNPJ — 14 dígitos exatos
  IF p_cnpj IS NOT NULL AND trim(p_cnpj) <> '' AND length(trim(p_cnpj)) = 14 THEN
    SELECT s.sk_supplier INTO v_id FROM supplier s WHERE s.cnpj = trim(p_cnpj) LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  -- Passo 2: CPF — 11 dígitos exatos
  IF p_cpf IS NOT NULL AND trim(p_cpf) <> '' AND length(trim(p_cpf)) = 11 THEN
    SELECT s.sk_supplier INTO v_id FROM supplier s WHERE s.cpf = trim(p_cpf) LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      PERFORM _enrich_supplier_name(v_id, p_name);
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 3: NOME (razão social, depois nome fantasia) — ANTES do e-mail.
  IF v_has_name THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s WHERE normalize_search(s.legal_name) = normalize_search(p_name) LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;

    SELECT s.sk_supplier INTO v_id
    FROM supplier s WHERE normalize_search(s.trade_name) = normalize_search(p_name) LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 4: E-MAIL exato — SOMENTE na ausência total de nome (migration 046).
  IF NOT v_has_name AND v_email IS NOT NULL THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE v_email IN (lower(trim(s.email)), lower(trim(s.email2)), lower(trim(s.email3)), lower(trim(s.email4)))
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;
  END IF;

  -- Não encontrado: auto-insert. E-mail interno não é armazenado nem usado como nome.
  v_legal       := NULLIF(trim(COALESCE(p_name, '')), '');
  v_trade       := v_legal;
  v_email_store := CASE WHEN _is_internal_email(v_email) THEN NULL ELSE v_email END;

  IF NULLIF(trim(COALESCE(p_cnpj, '')), '') IS NULL
     AND NULLIF(trim(COALESCE(p_cpf,  '')), '') IS NULL
     AND v_legal IS NULL
     AND v_email_store IS NULL
  THEN
    RAISE EXCEPTION
      'resolve_supplier_id: nenhum identificador valido (cnpj, cpf, nome ausentes; e-mail ausente ou de dominio interno)';
  END IF;

  INSERT INTO supplier (cnpj, cpf, legal_name, trade_name, email)
  VALUES (
    NULLIF(trim(COALESCE(p_cnpj, '')), ''),
    NULLIF(trim(COALESCE(p_cpf,  '')), ''),
    COALESCE(v_legal, v_email_store),
    COALESCE(v_trade, v_email_store),
    v_email_store
  )
  RETURNING sk_supplier INTO v_id;

  RETURN v_id;
END;
$function$;

COMMIT;
