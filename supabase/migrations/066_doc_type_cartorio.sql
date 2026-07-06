-- =============================================================
-- 066_doc_type_cartorio.sql
-- Novo document_type: 'cartório' (pagamento de/em cartório — custas de
-- tabelionato/registro/protesto). Estende o CHECK de
-- financial_account_control.document_type e faz o backfill dos registros já
-- gravados cujo assunto indica cartório (ex.: id 400, "PAGAMENTO CARTORIO ...").
--
-- Projeto: pagamentos | Data: 2026-07-06
--
-- A classificação roda no pipeline (read_emails.py `_apply_cartorio_doc_type` /
-- extract_pdf.py `_DOC_TYPE_NORM`) — esta migration amplia o domínio e alinha os
-- dados existentes. Idempotente (DROP IF EXISTS + recria o CHECK; o backfill só
-- toca tipos genéricos com contexto de cartório no assunto). O CHECK compara
-- lower(document_type), então os valores ficam em minúsculo.
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
      'container', 'cartório',
      -- Contas de concessionaria (migration 043)
      'conta de água', 'conta de luz', 'conta de telefone / internet'
    ]::text[])
  );

-- Backfill: registros GENÉRICOS (boleto/outro/pix) cujo ASSUNTO indica cartório
-- passam a 'cartório' — espelha a regra `_apply_cartorio_doc_type` (só re-rotula
-- tipos genéricos; guias/utilities/cte/honorários são preservadas). Requer a
-- extensão `unaccent` (já usada no projeto).
UPDATE financial_account_control
   SET document_type = 'cartório'
 WHERE lower(document_type) IN ('boleto', 'outro', 'pix')
   AND unaccent(lower(coalesce(subject, ''))) ~ '\ycartorio\y';

COMMIT;
