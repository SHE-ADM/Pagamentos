-- =============================================================
-- 008_update_resolve_company_id.sql
-- Atualiza a funcao resolve_company_id com a logica de busca completa.
-- Projeto: pagamentos | Data: 2026-06-06
--
-- Fluxo de resolucao:
--   1. CNPJ exato:    payer_cnpj -> company.cnpj
--   2. Razao social:  normalize_search(payer_name) -> normalize_search(company.legal_name)
--   3. Nome fantasia: normalize_search(payer_name) -> normalize_search(company.trade_name)
--   4. Fallback:      company_id = 1
--
-- normalize_search = lower(unaccent(txt)) — reconhece acentos, caixa mista.
-- =============================================================

CREATE OR REPLACE FUNCTION resolve_company_id(
  p_payer_cnpj TEXT,
  p_payer_name TEXT
) RETURNS BIGINT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_id BIGINT;
BEGIN
  -- Passo 1: CNPJ exato (14 digitos)
  IF p_payer_cnpj IS NOT NULL AND length(trim(p_payer_cnpj)) = 14 THEN
    SELECT c.company_id INTO v_id
    FROM company c
    WHERE c.cnpj = trim(p_payer_cnpj)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;

  IF p_payer_name IS NOT NULL AND trim(p_payer_name) <> '' THEN
    -- Passo 2: razao social normalizada (legal_name)
    SELECT c.company_id INTO v_id
    FROM company c
    WHERE normalize_search(c.legal_name) = normalize_search(p_payer_name)
    LIMIT 1;
    IF FOUND THEN RETURN v_id; END IF;

    -- Passo 3: nome fantasia normalizado (trade_name)
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
