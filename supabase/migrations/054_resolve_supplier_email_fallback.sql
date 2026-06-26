-- 054_resolve_supplier_email_fallback.sql
-- Corrige a resolução de fornecedor: a busca por E-MAIL passa a ser um FALLBACK após o
-- nome falhar (e-mail NÃO interno), em vez de só rodar "na ausência total de nome".
--
-- Problema (recorrente): quando o corpo/anexo não traz um nome confiável, o pipeline usa
-- o próprio e-mail do remetente como "nome" do fornecedor (extract_from_email_body). Com a
-- migration 046, o Passo 4 (e-mail) só rodava se NÃO houvesse nome — então, com o e-mail
-- ocupando o campo nome (v_has_name=true), a busca por e-mail era PULADA. O nome
-- "financeiro@smartwebservices.com.br" não casava o nome real do fornecedor → o pipeline
-- criava um fornecedor DUPLICADO, mesmo que esse e-mail já constasse no email2 de um
-- fornecedor cadastrado (ex.: supplier_id 1213, "Smart Web Services").
--
-- Esta é a intenção JÁ documentada no pipeline (read_emails: "o e-mail do remetente é chave
-- válida — a RPC casa por e-mail, passo 3, email/2/3/4"). A 046 a havia restringido demais.
--
-- A regra de ouro da 046 é PRESERVADA: e-mail de DOMÍNIO INTERNO
-- (otimotex.com.br / lebianco.com.br) continua bloqueado por `_is_internal_email` — não
-- identifica nem cria fornecedor —, evitando o colapso de fornecedores por remetente interno.
-- Ordem final: CNPJ → CPF → NOME (razão social, depois fantasia) → E-MAIL (não interno) →
-- auto-insert. O nome ainda tem precedência sobre o e-mail; o e-mail só entra quando o nome
-- não casa nenhum cadastro.

CREATE OR REPLACE FUNCTION public.resolve_supplier_id(
  p_cnpj  text,
  p_cpf   text,
  p_name  text,
  p_email text DEFAULT NULL::text
)
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

  -- Passo 4: E-MAIL exato — FALLBACK após o nome falhar (NÃO exige ausência de nome).
  -- Só e-mail NÃO interno (a 046 bloqueia domínios internos de identificar/virar fornecedor).
  -- Cobre o caso em que o corpo/anexo não traz um nome confiável (ou traz o próprio e-mail
  -- como "nome") mas o e-mail já consta em email/email2/email3/email4 de um fornecedor.
  IF v_email IS NOT NULL AND NOT _is_internal_email(v_email) THEN
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
