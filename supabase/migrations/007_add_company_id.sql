-- =============================================================
-- 007_add_company_id.sql
-- Relaciona financial_emails com company (pagador/sacado).
-- Projeto: pagamentos | Data: 2026-06-06
--
-- Fluxo de resolucao (funcao resolve_company_id) — ver 008 para logica final:
--   1. CNPJ exato:          payer_cnpj -> company.cnpj
--   2. Razao social:        normalize_search(payer_name) -> normalize_search(company.legal_name)
--   3. Nome fantasia:       normalize_search(payer_name) -> normalize_search(company.trade_name)
--   4. Fallback:            company_id = 1
--
-- O trigger trg_fe_company_id dispara automaticamente em INSERT/UPDATE,
-- portanto o Python nao precisa resolver o company_id — apenas grava
-- payer_cnpj e payer_name que vieram da extracao do PDF.
-- =============================================================

-- 1. Novos campos: sacado extraido do documento + FK para company
ALTER TABLE financial_emails
  ADD COLUMN IF NOT EXISTS payer_cnpj  CHAR(14),
  ADD COLUMN IF NOT EXISTS payer_name  TEXT,
  ADD COLUMN IF NOT EXISTS company_id  BIGINT NOT NULL DEFAULT 1
    REFERENCES company(company_id);

-- 2. Funcao de resolucao (STABLE: mesma entrada sempre retorna mesmo resultado)
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

    IF FOUND THEN
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 2: nome normalizado (sem acentos, case-insensitive)
  IF p_payer_name IS NOT NULL AND trim(p_payer_name) <> '' THEN
    SELECT c.company_id INTO v_id
    FROM company c
    WHERE normalize_search(c.trade_name) = normalize_search(p_payer_name)
    LIMIT 1;

    IF FOUND THEN
      RETURN v_id;
    END IF;
  END IF;

  -- Passo 3: fallback padrao
  RETURN 1;
END;
$$;

-- 3. Funcao do trigger
CREATE OR REPLACE FUNCTION trg_fe_resolve_company()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.company_id := resolve_company_id(NEW.payer_cnpj, NEW.payer_name);
  RETURN NEW;
END;
$$;

-- 4. Trigger: dispara em INSERT e em UPDATE quando os campos do pagador mudam
DROP TRIGGER IF EXISTS trg_fe_company_id ON financial_emails;
CREATE TRIGGER trg_fe_company_id
  BEFORE INSERT OR UPDATE OF payer_cnpj, payer_name
  ON financial_emails
  FOR EACH ROW EXECUTE FUNCTION trg_fe_resolve_company();

-- 5. Indice para consultas por company
CREATE INDEX IF NOT EXISTS idx_fe_company_id ON financial_emails (company_id);
