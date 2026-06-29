-- =============================================================
-- 061_extraction_source_image_vision.sql
-- Adiciona o valor 'image_vision' ao CHECK de
-- financial_account_control.extraction_source.
--
-- Motivo: o pipeline passou a ler ANEXOS DE IMAGEM (jpg/png/...) via Claude Vision
-- (recibo/comprovante, ex.: "Valor do porte" dos Correios), gravando
-- extraction_source='image_vision'. Sem este valor no CHECK, o INSERT seria rejeitado.
--
-- Domínio resultante: email_body, pdf_text, pdf_vision, image_vision, falha.
-- Idempotente (DROP IF EXISTS + ADD com o conjunto completo).
--
-- Projeto: pagamentos | Data: 2026-06-29
-- =============================================================

BEGIN;

ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_extraction_source_check;

ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_extraction_source_check
  CHECK (extraction_source = ANY (ARRAY[
    'email_body'::text,
    'pdf_text'::text,
    'pdf_vision'::text,
    'image_vision'::text,
    'falha'::text
  ]));

COMMIT;
