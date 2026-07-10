-- Migration 075 — `pix` deixa de ser tipo de documento (é só forma de pagamento)
--
-- Contexto: PIX é FORMA DE PAGAMENTO (payment_method), não tipo de documento. Uma
-- transferência PIX sem outro indício de tipo deve ser `document_type='outro'`.
-- Esta migration:
--   (1) faz o backfill dos registros já gravados como `document_type='pix'` → `outro`;
--   (2) recria o CHECK de `document_type` SEM o valor `pix`.
-- `payment_method='pix'` PERMANECE válido (o CHECK de payment_method não é tocado).
--
-- APLICADA via Supabase MCP em 2026-07-10 (base compartilhada dev/prod) — este arquivo
-- é histórico; não reaplicar no SQL Editor. Idempotente-seguro: o backfill roda ANTES
-- do novo CHECK (senão o UPDATE violaria a constraint).

-- (1) Backfill: pix → outro
UPDATE financial_account_control
SET    document_type = 'outro'
WHERE  document_type = 'pix';

-- (2) Recria o CHECK sem 'pix'
ALTER TABLE financial_account_control
  DROP CONSTRAINT financial_account_control_document_type_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto'::text, 'cte'::text, 'nfe'::text, 'nfse'::text, 'seguro'::text,
      'fatura'::text, 'recibo'::text, 'contrato'::text, 'outro'::text, 'darf'::text,
      'gps'::text, 'das'::text, 'gru'::text, 'dae'::text, 'dare'::text, 'gnre'::text,
      'ipva'::text, 'iptu'::text, 'dam / duam'::text, 'iss'::text, 'itbi'::text,
      'gare'::text, 'tributo'::text, 'multa'::text, 'honorários'::text,
      'container'::text, 'cartório'::text, 'conta de água'::text, 'conta de luz'::text,
      'conta de telefone / internet'::text
    ])  -- 'pix' REMOVIDO
  );
