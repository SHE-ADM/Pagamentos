-- =============================================================
-- 006_add_cte_document_type.sql
-- Adiciona o tipo 'cte' (Conhecimento de Transporte / DACTE) ao
-- CHECK de document_type em financial_emails.
-- Projeto: pagamentos | Data: 2026-06-06
--
-- Motivo: CT-e representa valor a pagar (frete) mas nao e boleto nem
-- nota fiscal. Diferente de NF-e/NFS-e, CT-e GERA conta a pagar.
-- =============================================================

ALTER TABLE financial_emails
  DROP CONSTRAINT IF EXISTS financial_emails_document_type_check;

ALTER TABLE financial_emails
  ADD CONSTRAINT financial_emails_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'boleto'::text, 'cte'::text, 'nfe'::text, 'nfse'::text,
    'fatura'::text, 'recibo'::text, 'contrato'::text, 'outro'::text
  ]));
