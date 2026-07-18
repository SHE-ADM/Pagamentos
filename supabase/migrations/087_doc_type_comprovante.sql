-- =============================================================
-- 087_doc_type_comprovante.sql
-- Novo document_type: 'comprovante' (comprovante/recibo como DOCUMENTO da conta
-- a pagar). Estende o CHECK de financial_account_control.document_type.
--
-- Projeto: pagamentos | Data: 2026-07-18
--
-- Tipo SELECIONÁVEL no cadastro manual (ContaForm) e no filtro de /consulta —
-- NÃO é auto-classificado pela palavra "comprovante" no assunto/corpo: a regra
-- subject_is_payment_confirmation JÁ IGNORA e-mail de "comprovante de pagamento"
-- (é recibo de pagamento já feito, não conta a pagar), então classificar por ela
-- geraria conflito. O extractor só o emite se o rótulo explícito casar
-- (_DOC_TYPE_NORM em extract_pdf.py).
--
-- Idempotente (DROP IF EXISTS + recria o CHECK). O CHECK compara
-- lower(document_type), então o valor fica em minúsculo. Sem backfill (nenhum
-- registro existente precisa migrar).
--
-- ATENÇÃO (não regredir): 'pix' foi REMOVIDO do domínio pela migration 075 (pix é
-- só payment_method) + backfill pix→outro. A lista abaixo NÃO o inclui — deve
-- espelhar 1:1 o enum DOCUMENT_TYPES de @sheild/shared. Ao recriar o CHECK, copiar
-- do enum, nunca de uma versão pré-075.
-- =============================================================

BEGIN;

ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_document_type_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto', 'cte', 'nfe', 'nfse', 'seguro', 'fatura', 'recibo', 'contrato',
      'outro', 'darf', 'gps', 'das', 'gru', 'dae', 'dare', 'gnre', 'ipva', 'iptu',
      'dam / duam', 'iss', 'itbi', 'gare', 'tributo', 'multa', 'honorários',
      'container', 'cartório', 'cheque', 'comprovante',
      -- Contas de concessionaria (migration 043)
      'conta de água', 'conta de luz', 'conta de telefone / internet'
    ]::text[])
  );

COMMIT;
