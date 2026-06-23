-- =============================================================
-- 043_doc_type_contas_utilidades.sql
-- Novos document_type para contas de concessionaria, classificados por frase do
-- assunto/corpo do e-mail (regra de negocio): conta de agua, conta de luz e
-- conta de telefone / internet. Estende o CHECK de financial_account_control e faz
-- o backfill dos registros ja gravados que casam (varredura previa).
--
-- Projeto: pagamentos | Data: 2026-06-23
--
-- A classificacao roda no pipeline (read_emails.py, subject-driven) — esta migration
-- so amplia o dominio e corrige os dados historicos. O valor com barra
-- 'conta de telefone / internet' segue o estilo do ja existente 'dam / duam'.
-- =============================================================

BEGIN;

-- 1. Dominio de document_type = 25 valores atuais + 3 novos (lower-case; o CHECK
--    compara lower(document_type)).
ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_document_type_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto', 'cte', 'nfe', 'nfse', 'seguro', 'fatura', 'recibo', 'contrato',
      'outro', 'darf', 'gps', 'das', 'gru', 'dae', 'gnre', 'ipva', 'iptu',
      'dam / duam', 'iss', 'itbi', 'gare', 'tributo', 'pix', 'honorários', 'container',
      -- Contas de concessionaria (migration 043)
      'conta de água', 'conta de luz', 'conta de telefone / internet'
    ]::text[])
  );

-- 2. Backfill — nº de documento perdido (rotulo "Número do documento" no corpo) e
--    reclassificacao da conta de agua. IDs identificados pela varredura previa
--    (unicos com nº real recuperavel pelo rotulo explicito). Guardas idempotentes.
UPDATE financial_account_control
   SET invoice_number = '014696-001'
 WHERE id = 5  AND invoice_number LIKE 'outro\_%';

UPDATE financial_account_control
   SET invoice_number = '011161-001'
 WHERE id = 18 AND invoice_number LIKE 'outro\_%';

UPDATE financial_account_control
   SET invoice_number = 'SOR202659903949',
       document_type  = 'conta de água'
 WHERE id = 171;

COMMIT;
