-- =============================================================
-- 024_add_honorarios_document_type.sql
-- Adiciona 'honorários' ao CHECK de financial_account_control.document_type.
-- Honorários (serviços profissionais) são registrados com document_type
-- 'honorários' e payment_method 'pix' (regra aplicada na extração — corpo e PDF).
-- O CHECK usa lower(document_type), então o valor é gravado em minúsculo/acentuado.
-- Projeto: pagamentos | Data: 2026-06-15
-- =============================================================

ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_document_type_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check
  CHECK (lower(document_type) IN (
    'boleto', 'cte', 'nfe', 'nfse', 'seguro', 'fatura', 'recibo',
    'contrato', 'outro', 'darf', 'gps', 'das', 'gru', 'dae', 'gnre',
    'ipva', 'iptu', 'dam / duam', 'iss', 'itbi', 'gare', 'tributo', 'pix',
    'honorários'
  ));
