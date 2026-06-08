-- =============================================================
-- 016_add_email_body_excerpt.sql
-- Campo memo com o corpo do e-mail de origem
-- Projeto: pagamentos | Data: 2026-06-08
--
-- Quando extraction_source = 'email_body' (pedido de pagamento sem anexo
-- valido — nome do fornecedor, valor e dados bancarios no corpo da
-- mensagem), guarda o corpo do e-mail (trimado, formatacao original
-- preservada) para consulta posterior na interface.
-- =============================================================

ALTER TABLE financial_emails
  ADD COLUMN IF NOT EXISTS email_body_excerpt TEXT;
