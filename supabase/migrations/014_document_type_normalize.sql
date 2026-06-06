-- 014_document_type_normalize.sql
-- Torna o CHECK constraint de document_type case-insensitive via lower()
-- e adiciona os tipos 'tributo' e 'seguro' que estavam ausentes.

-- Remove constraint atual (o nome pode variar; tenta os dois padrões comuns)
ALTER TABLE financial_emails
  DROP CONSTRAINT IF EXISTS financial_emails_document_type_check;

ALTER TABLE financial_emails
  DROP CONSTRAINT IF EXISTS financial_emails_document_type_check1;

-- Nova constraint: lower(document_type) permite qualquer casing na gravação
ALTER TABLE financial_emails
  ADD CONSTRAINT financial_emails_document_type_check
  CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto', 'cte', 'nfe', 'nfse', 'tributo', 'seguro',
      'fatura', 'recibo', 'contrato', 'outro'
    ])
  );
