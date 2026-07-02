-- =============================================================
-- 062_doc_type_multa_dare.sql
-- Novos document_type: 'multa' (penalidade/multa avulsa) e 'dare' (Documento de
-- Arrecadacao de Receitas Estaduais — antes dobrado em 'dae'). Estende o CHECK de
-- financial_account_control.document_type.
--
-- Projeto: pagamentos | Data: 2026-07-01
--
-- A classificacao roda no pipeline (read_emails.py / extract_pdf.py) — esta migration
-- so amplia o dominio. Idempotente (DROP IF EXISTS + recria). O CHECK compara
-- lower(document_type), entao os valores ficam em minusculo.
-- =============================================================

BEGIN;

ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_document_type_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto', 'cte', 'nfe', 'nfse', 'seguro', 'fatura', 'recibo', 'contrato',
      'outro', 'darf', 'gps', 'das', 'gru', 'dae', 'dare', 'gnre', 'ipva', 'iptu',
      'dam / duam', 'iss', 'itbi', 'gare', 'tributo', 'multa', 'pix', 'honorários',
      'container',
      -- Contas de concessionaria (migration 043)
      'conta de água', 'conta de luz', 'conta de telefone / internet'
    ]::text[])
  );

COMMIT;
