-- =============================================================
-- 032_financial_dup_by_name_rpc.sql
-- RPC de dedup por NOME do fornecedor usando normalize_search (case/acento-insensitive).
-- Projeto: pagamentos | Data: 2026-06-17
--
-- Contexto: find_financial_duplicate (Python) compara supplier_name com `eq` exato
-- quando o documento não traz CNPJ/CPF — então "EFE Displays" ≠ "EFE DISPLAYS" e
-- acentos quebram o match. O PostgREST não permite envolver a coluna numa função no
-- filtro, então a comparação normalize_search(coluna)=normalize_search(valor) é feita
-- nesta RPC (mesmo padrão do trigger resolve_supplier_id para legal_name/trade_name).
-- Preserva a prioridade do dedup: impressão 2 (nome+nº doc+valor) antes da 3
-- (nome+valor+vencimento+tipo). normalize_search(txt)=lower(unaccent(txt)).
-- =============================================================

CREATE OR REPLACE FUNCTION public.financial_dup_by_name(
  p_name    text,
  p_amount  numeric DEFAULT NULL,
  p_invoice text    DEFAULT NULL,
  p_due     date    DEFAULT NULL,
  p_doc     text    DEFAULT NULL
) RETURNS SETOF financial_account_control
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN;
  END IF;

  -- Impressão 2: nome (normalizado) + nº documento substancial (>=6) + valor.
  IF p_invoice IS NOT NULL AND length(p_invoice) >= 6 AND p_amount IS NOT NULL THEN
    RETURN QUERY
      SELECT f.* FROM financial_account_control f
      WHERE normalize_search(f.supplier_name) = normalize_search(p_name)
        AND f.invoice_number = p_invoice
        AND f.amount = p_amount
      LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  -- Impressão 3: nome (normalizado) + valor + vencimento + tipo.
  RETURN QUERY
    SELECT f.* FROM financial_account_control f
    WHERE normalize_search(f.supplier_name) = normalize_search(p_name)
      AND f.amount        IS NOT DISTINCT FROM p_amount
      AND f.due_date      IS NOT DISTINCT FROM p_due
      AND f.document_type IS NOT DISTINCT FROM p_doc
    LIMIT 1;
END;
$$;
