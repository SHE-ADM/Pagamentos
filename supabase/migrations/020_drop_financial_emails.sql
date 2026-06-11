-- =============================================================
-- 020_drop_financial_emails.sql
-- Remove definitivamente a tabela financial_emails, substituida por
-- financial_account_control (migration 018).
-- Projeto: pagamentos | Data: 2026-06-11
--
-- A tabela nao possui mais nenhum dado relevante (0 linhas) e nenhum
-- processo aponta para ela apos esta entrega. CASCADE remove triggers,
-- indices e policies remanescentes ligados a ela.
-- =============================================================

DROP TABLE IF EXISTS financial_emails CASCADE;
