-- 109_supplier_email_nao_sequestra.sql
-- O E-MAIL DEIXA DE SEQUESTRAR O FORNECEDOR.
--
-- Defeito corrigido (caso real: conta 794, fatura SSW Nº79399 de 31/07/2026):
-- a extração devolveu corretamente "PANTANAL LOGISTICA E TRANSPORTES LTDA" +
-- CNPJ 08.662.661/0001-94, mas a conta foi gravada sob "TRANSPORTADORA J.D.F.".
--
-- Como: PANTANAL era fornecedor NOVO, então o Passo 1 (CNPJ) e o Passo 3 (nome) não
-- casaram; o Passo 4 (e-mail) casou o remetente `no-reply@sswsistemas.com.br` — que é o
-- endereço da PLATAFORMA SSW, usada por dezenas de transportadoras — e devolveu o
-- primeiro cadastro que tinha aquele e-mail. Medido antes desta migration: o mesmo
-- endereço estava em 4 fornecedores distintos (J.D.F., CARVALIMA, ARLETE, VIAÇÃO
-- GARCIA), e `sswemail@ssw.inf.br` em mais dois.
--
-- O bug atinge exatamente o fornecedor NOVO — a PRIMEIRA fatura de cada transportadora
-- é atribuída a uma transportadora antiga, e as seguintes acertam (aí o cadastro já
-- existe e casa por nome/CNPJ). Por isso passou despercebido: 13 das 14 contas de
-- faturas SSW estavam certas.
--
-- Duas travas independentes:
--   (1) identificador FORTE vence e-mail — CNPJ/CPF informado e não encontrado significa
--       "fornecedor novo", e o destino correto é o auto-insert, nunca um cadastro alheio.
--       Vale para QUALQUER plataforma (SSW, SIEG, Efí…), sem lista para manter.
--   (2) e-mail de PLATAFORMA não é identificador de fornecedor — mesmo raciocínio do
--       `_is_internal_email` (migration 046): um endereço compartilhado por vários
--       fornecedores identifica o INTERMEDIÁRIO, não quem recebe o pagamento. Cobre o
--       caso em que a extração não consegue ler o CNPJ (aí a trava 1 não se aplica).
--
-- Idempotente: CREATE OR REPLACE + UPDATE com WHERE restritivo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) E-mail de plataforma / intermediário de cobrança
-- ─────────────────────────────────────────────────────────────────────────────
-- Espelha _is_internal_email. Ao descobrir uma plataforma nova (um endereço que aparece
-- em fornecedores de empresas DIFERENTES), acrescente o domínio aqui — e lembre de
-- limpá-lo dos cadastros que já o capturaram, como o bloco 4 faz para o SSW.
CREATE OR REPLACE FUNCTION public._is_platform_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT lower(trim(COALESCE(p_email, ''))) LIKE '%@sswsistemas.com.br'
      OR lower(trim(COALESCE(p_email, ''))) LIKE '%@ssw.inf.br';
$function$;

COMMENT ON FUNCTION public._is_platform_email(text) IS
  'E-mail de plataforma/intermediário de cobrança (SSW). Não identifica fornecedor: '
  'não casa no Passo 4 de resolve_supplier_id, não é armazenado no auto-insert e não é '
  'propagado por _add_supplier_email. Ver migration 109.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) resolve_supplier_id — o e-mail vira o ÚLTIMO recurso, e só quando é legítimo
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_supplier_id(p_cnpj text, p_cpf text, p_name text, p_email text DEFAULT NULL::text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id          BIGINT;
  v_legal       TEXT;
  v_trade       TEXT;
  v_email       TEXT    := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_has_name    BOOLEAN := (p_name IS NOT NULL AND trim(p_name) <> '');
  v_email_store TEXT;
  -- Identificador FORTE informado pela extração (documento fiscal/boleto). Quando existe
  -- e não casa nenhum cadastro, o fornecedor é NOVO — resolver por e-mail aqui seria
  -- atribuir a conta a outra empresa (migration 109).
  v_has_strong  BOOLEAN := (p_cnpj IS NOT NULL AND length(trim(p_cnpj)) = 14)
                        OR (p_cpf  IS NOT NULL AND length(trim(p_cpf))  = 11);
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

  -- Passo 4: E-MAIL exato — último recurso, e SÓ quando o e-mail de fato identifica um
  -- fornecedor. Bloqueado quando (a) a extração trouxe CNPJ/CPF que não casou (fornecedor
  -- novo → auto-insert), (b) domínio interno (046) ou (c) plataforma de cobrança (109).
  IF v_email IS NOT NULL
     AND NOT v_has_strong
     AND NOT _is_internal_email(v_email)
     AND NOT _is_platform_email(v_email)
  THEN
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE v_email IN (lower(trim(s.email)), lower(trim(s.email2)), lower(trim(s.email3)), lower(trim(s.email4)))
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;
  END IF;

  -- Não encontrado: auto-insert. E-mail interno ou de plataforma não é armazenado nem
  -- usado como nome — senão o cadastro nasceria chamado "no-reply@sswsistemas.com.br" e
  -- capturaria as faturas das demais transportadoras da plataforma.
  v_legal       := NULLIF(trim(COALESCE(p_name, '')), '');
  v_trade       := v_legal;
  v_email_store := CASE
                     WHEN _is_internal_email(v_email) OR _is_platform_email(v_email) THEN NULL
                     ELSE v_email
                   END;

  IF NULLIF(trim(COALESCE(p_cnpj, '')), '') IS NULL
     AND NULLIF(trim(COALESCE(p_cpf,  '')), '') IS NULL
     AND v_legal IS NULL
     AND v_email_store IS NULL
  THEN
    RAISE EXCEPTION
      'resolve_supplier_id: nenhum identificador valido (cnpj, cpf, nome ausentes; e-mail ausente, de dominio interno ou de plataforma)';
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) _add_supplier_email — a plataforma não se espalha pelos cadastros
-- ─────────────────────────────────────────────────────────────────────────────
-- Sem isto, o endereço da plataforma seria recadastrado na próxima fatura e o bloco 4
-- viraria uma limpeza que se desfaz sozinha.
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
  -- Plataforma de cobranca identifica o intermediario, nao o fornecedor (migration 109).
  IF _is_platform_email(v_email) THEN RETURN; END IF;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Limpeza: retira o e-mail da plataforma dos cadastros que já o capturaram
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotente (WHERE por coluna). O CHECK chk_supplier_has_identifier segue satisfeito:
-- todos os afetados têm CNPJ e razão social — nenhum depende do e-mail como identificador.
UPDATE supplier SET email  = NULL WHERE _is_platform_email(email);
UPDATE supplier SET email2 = NULL WHERE _is_platform_email(email2);
UPDATE supplier SET email3 = NULL WHERE _is_platform_email(email3);
UPDATE supplier SET email4 = NULL WHERE _is_platform_email(email4);
