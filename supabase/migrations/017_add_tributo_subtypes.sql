-- =============================================================
-- 017_add_tributo_subtypes.sql
-- Expande o CHECK de document_type para incluir subtipos de
-- tributo (DARF, GPS, DAS, GRU, DAE, GNRE, IPVA, IPTU,
-- DAM / DUAM, ISS, ITBI, GARE) em vez de agrupar tudo em
-- 'tributo'. O valor 'tributo' permanece como fallback para
-- documentos tributários não identificados.
-- Projeto: pagamentos | Data: 2026-06-09
-- =============================================================

ALTER TABLE financial_emails
  DROP CONSTRAINT IF EXISTS financial_emails_document_type_check;

ALTER TABLE financial_emails
  DROP CONSTRAINT IF EXISTS financial_emails_document_type_check1;

ALTER TABLE financial_emails
  ADD CONSTRAINT financial_emails_document_type_check
  CHECK (
    lower(document_type) = ANY (ARRAY[
      -- tipos gerais
      'boleto', 'cte', 'nfe', 'nfse', 'seguro',
      'fatura', 'recibo', 'contrato', 'outro',
      -- tributos específicos
      'darf', 'gps', 'das', 'gru', 'dae', 'gnre',
      'ipva', 'iptu', 'dam / duam', 'iss', 'itbi', 'gare',
      -- fallback tributário
      'tributo',
      -- pagamento via PIX (forma de pagamento sobrescreve o tipo)
      'pix'
    ])
  );
