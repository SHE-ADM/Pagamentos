-- =============================================================
-- 138_resolve_supplier_nome_longo.sql
-- O auto-insert de fornecedor não quebra mais com nome acima da largura da coluna.
--
-- Projeto: pagamentos | Data: 2026-09-15
--
-- POR QUE EXISTE: `supplier.legal_name` e `supplier.trade_name` são VARCHAR(60), e o
-- auto-insert de `resolve_supplier_id` gravava o nome extraído INTEIRO. Um beneficiário de
-- razão social longa ("SINDICATO DOS TRABALHADORES MESTRES E CONTRAMESTRES, LIDERES,
-- SUPERVISORES, PESSOAL DE ESCRITÓRIO E CARGOS DE CHEFIA NA INDUSTRIA DO EST DE SP", ~140
-- caracteres) fazia o INSERT levantar 22001 (value too long). O pipeline lia a falha da RPC
-- como "fornecedor não encontrado" e caía no fallback do PAGADOR: as contas 895 (08/2026) e
-- 1396 (09/2026) foram gravadas sob a OTIMOTEX, com o plano default dela (Vale Alimentação),
-- sem erro nenhum — a extração estava CORRETA (nome + CNPJ lidos, reproduzido 5/5).
--
-- O QUE MUDA (e só isto — o resto do corpo é o da definição viva, copiado do catálogo):
--   1. O nome que vai ao auto-insert é CORTADO na largura da coluna (`c_name_max`).
--   2. O passo por NOME compara também a forma cortada. Sem isso, o 2º e-mail do mesmo
--      fornecedor (sem CNPJ) não casaria o cadastro criado pelo 1º — nome completo × nome
--      cortado — e cada e-mail criaria um fornecedor DUPLICADO. É um SUPERCONJUNTO do
--      comportamento anterior: nome de até 60 caracteres produz as duas formas iguais.
--   3. `_enrich_supplier_name` (passo por CPF) tinha a mesma armadilha e recebe o mesmo corte.
--
-- 🔴 A mensagem "nenhum identificador valido" do RAISE NÃO pode mudar: o pipeline a usa para
-- distinguir a recusa legítima (segue para o fallback do pagador) de uma FALHA da RPC (vai a
-- /erros). Espelho travado por tests/test_supplier_rpc_failure.py.
--
-- Idempotente (CREATE OR REPLACE — mesma assinatura, então os grants sobrevivem; reemitidos
-- abaixo mesmo assim). 🔴 NÃO trocar por DROP FUNCTION: apagaria os grants (lição da 116).
-- ⚠️ A sonda P1 cria e desfaz um fornecedor numa subtransação: consome um valor da sequência
-- de `sk_supplier` a cada execução (lacuna inofensiva na numeração).
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_supplier_id(p_cnpj text, p_cpf text, p_name text, p_email text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Largura de supplier.legal_name / supplier.trade_name (VARCHAR(60)). A sonda da migration
  -- 138 confere este valor contra o catálogo — alargar a coluna exige acompanhar aqui.
  c_name_max    CONSTANT INTEGER := 60;
  v_id          BIGINT;
  v_legal       TEXT;
  v_trade       TEXT;
  v_email       TEXT    := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_has_name    BOOLEAN := (p_name IS NOT NULL AND trim(p_name) <> '');
  v_name_fit    TEXT    := NULLIF(rtrim(left(trim(COALESCE(p_name, '')), c_name_max)), '');
  v_email_store TEXT;
  v_has_strong  BOOLEAN := (p_cnpj IS NOT NULL AND length(trim(p_cnpj)) = 14)
                        OR (p_cpf  IS NOT NULL AND length(trim(p_cpf))  = 11);
BEGIN
  IF p_cnpj IS NOT NULL AND trim(p_cnpj) <> '' AND length(trim(p_cnpj)) = 14 THEN
    SELECT s.sk_supplier INTO v_id FROM supplier s WHERE s.cnpj = trim(p_cnpj) LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  IF p_cpf IS NOT NULL AND trim(p_cpf) <> '' AND length(trim(p_cpf)) = 11 THEN
    SELECT s.sk_supplier INTO v_id FROM supplier s WHERE s.cpf = trim(p_cpf) LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      PERFORM _enrich_supplier_name(v_id, p_name);
      RETURN v_id;
    END IF;
  END IF;

  IF v_has_name THEN
    -- Forma completa E forma cortada: o cadastro criado por um nome longo guarda só a cortada.
    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE normalize_search(s.legal_name) IN (normalize_search(p_name), normalize_search(v_name_fit))
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;

    SELECT s.sk_supplier INTO v_id
    FROM supplier s
    WHERE normalize_search(s.trade_name) IN (normalize_search(p_name), normalize_search(v_name_fit))
    LIMIT 1;
    IF FOUND THEN
      PERFORM _enrich_supplier(v_id, p_cnpj, p_cpf);
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 4: E-MAIL exato -- ultimo recurso, e SO quando o e-mail identifica um
  -- fornecedor. Bloqueado quando (a) a extracao trouxe CNPJ/CPF que nao casou
  -- (fornecedor novo -> auto-insert), (b) dominio interno (046), (c) plataforma (109).
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

  v_legal       := v_name_fit;
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
    COALESCE(v_legal, left(v_email_store, c_name_max)),
    COALESCE(v_trade, left(v_email_store, c_name_max)),
    v_email_store
  )
  RETURNING sk_supplier INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._enrich_supplier_name(p_supplier_id bigint, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Mesma largura de resolve_supplier_id (VARCHAR(60) em legal_name/trade_name).
  c_name_max CONSTANT INTEGER := 60;
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' OR _looks_like_email(p_name) THEN
    RETURN;
  END IF;

  UPDATE supplier
  SET    legal_name = rtrim(left(trim(p_name), c_name_max)),
         trade_name = rtrim(left(trim(p_name), c_name_max))
  WHERE  sk_supplier = p_supplier_id
    AND  (_looks_like_email(legal_name) OR _looks_like_email(trade_name));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.resolve_supplier_id(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_supplier_id(text, text, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public._enrich_supplier_name(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._enrich_supplier_name(bigint, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transação: qualquer divergência desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  c_rollback  CONSTANT TEXT := 'Z1380';  -- SQLSTATE próprio: desfaz a subtransação de ensaio
  v_col_min   INTEGER;
  v_col_max   INTEGER;
  v_long      TEXT := 'SONDA 138 FORNECEDOR DE NOME LONGO ' || repeat('X', 100);
  v_before    BIGINT;
  v_after_sub BIGINT;
  v_rows      BIGINT;
  v_id1       BIGINT;
  v_id2       BIGINT;
  v_len       INTEGER;
  v_ref_sk    BIGINT;
  v_ref_cnpj  TEXT;
  v_ref_got   BIGINT;
  v_nm_sk     BIGINT;
  v_nm_name   TEXT;
  v_nm_got    BIGINT;
BEGIN
  -- P0 (sanidade): a largura das duas colunas é uma só, e o nome de teste a excede.
  SELECT min(character_maximum_length), max(character_maximum_length)
    INTO v_col_min, v_col_max
  FROM   information_schema.columns
  WHERE  table_schema = 'public' AND table_name = 'supplier'
    AND  column_name IN ('legal_name', 'trade_name');
  IF v_col_min IS NULL OR v_col_min <> v_col_max THEN
    RAISE EXCEPTION 'P0: larguras de legal_name/trade_name divergem ou sao ilimitadas (% x %)',
                    v_col_min, v_col_max;
  END IF;
  IF length(v_long) <= v_col_max THEN
    RAISE EXCEPTION 'P0: sonda vazia — o nome de teste (%) nao excede a coluna (%)',
                    length(v_long), v_col_max;
  END IF;

  SELECT count(*) INTO v_before FROM public.supplier;

  BEGIN
    -- P1: nome longo SEM CNPJ/e-mail cria o fornecedor (antes: 22001) com o nome cortado
    -- exatamente na largura do CATÁLOGO — não num número escrito à mão.
    v_id1 := public.resolve_supplier_id(NULL, NULL, v_long, NULL);
    SELECT length(legal_name) INTO v_len FROM public.supplier WHERE sk_supplier = v_id1;

    -- P2: o MESMO nome longo de novo casa o cadastro criado — não duplica.
    v_id2 := public.resolve_supplier_id(NULL, NULL, v_long, NULL);
    SELECT count(*) - v_before INTO v_rows FROM public.supplier;

    -- P3 (oráculo diferencial): CNPJ cadastrado + nome longo resolve pelo CNPJ, sem inserir.
    SELECT s.sk_supplier, s.cnpj INTO v_ref_sk, v_ref_cnpj
    FROM   public.supplier s
    WHERE  length(trim(s.cnpj)) = 14
    ORDER  BY s.sk_supplier
    LIMIT  1;
    v_ref_got := public.resolve_supplier_id(v_ref_cnpj, NULL, v_long || ' OUTRO', NULL);

    -- P4 (não regredir): nome curto que identifica UM ÚNICO cadastro continua resolvendo nele.
    SELECT s.sk_supplier, s.legal_name INTO v_nm_sk, v_nm_name
    FROM   public.supplier s
    WHERE  NULLIF(trim(s.legal_name), '') IS NOT NULL
      AND  s.sk_supplier <> v_id1
      AND  (SELECT count(*) FROM public.supplier s2
             WHERE normalize_search(s2.legal_name) = normalize_search(s.legal_name)
                OR normalize_search(s2.trade_name) = normalize_search(s.legal_name)) = 1
    ORDER  BY s.sk_supplier
    LIMIT  1;
    v_nm_got := public.resolve_supplier_id(NULL, NULL, v_nm_name, NULL);

    RAISE EXCEPTION USING ERRCODE = c_rollback, MESSAGE = 'sonda 138: desfaz o ensaio';
  EXCEPTION WHEN SQLSTATE 'Z1380' THEN
    NULL;  -- esperado: o fornecedor de teste some junto com a subtransação
  END;

  IF v_id1 IS NULL OR v_len IS DISTINCT FROM v_col_max THEN
    RAISE EXCEPTION 'P1: nome longo nao foi cortado na largura da coluna (id %, len %, coluna %)',
                    v_id1, v_len, v_col_max;
  END IF;
  IF v_id2 IS DISTINCT FROM v_id1 OR v_rows <> 1 THEN
    RAISE EXCEPTION 'P2: o mesmo nome longo nao casou o cadastro criado (ids % / %, % linhas novas)',
                    v_id1, v_id2, v_rows;
  END IF;
  IF v_ref_sk IS NULL OR v_ref_got IS DISTINCT FROM v_ref_sk THEN
    RAISE EXCEPTION 'P3: CNPJ % nao resolveu o cadastro % (devolveu %)', v_ref_cnpj, v_ref_sk, v_ref_got;
  END IF;
  IF v_nm_sk IS NULL OR v_nm_got IS DISTINCT FROM v_nm_sk THEN
    RAISE EXCEPTION 'P4: nome curto % nao resolveu o cadastro % (devolveu %)', v_nm_name, v_nm_sk, v_nm_got;
  END IF;

  SELECT count(*) INTO v_after_sub FROM public.supplier;
  IF v_after_sub <> v_before THEN
    RAISE EXCEPTION 'P5: a subtransacao de ensaio nao foi desfeita (% -> %)', v_before, v_after_sub;
  END IF;

  -- P6: grants como antes — só service_role executa.
  IF has_function_privilege('anon', 'public.resolve_supplier_id(text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_supplier_id(text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._enrich_supplier_name(bigint,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._enrich_supplier_name(bigint,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6: funcao executavel por anon/authenticated — o REVOKE nao pegou';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.resolve_supplier_id(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6: service_role sem EXECUTE — o pipeline nao conseguiria resolver fornecedor';
  END IF;
END $$;

COMMIT;
