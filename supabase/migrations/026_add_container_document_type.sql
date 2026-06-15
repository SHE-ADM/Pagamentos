-- =============================================================
-- 026_add_container_document_type.sql
-- Adiciona 'container' ao CHECK de financial_account_control.document_type.
-- Container = frete/demurrage/movimentação de contêineres. Reconhecido na
-- extração (corpo e PDF) e como keyword de assunto. O CHECK usa lower().
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
    'honorários', 'container'
  ));
