-- =============================================================
-- 060_financial_account_control_search_indexes.sql
-- Índices de PERFORMANCE da pesquisa em /consulta (financial_account_control).
--
-- A busca textual do grid filtra por `or(invoice_number.ilike '%termo%',
-- subject.ilike '%termo%', sender_email.ilike '%termo%', amount.eq <valor>, ...)`
-- e a listagem padrão ordena por `created_at DESC`. Faltavam índices para:
--   - ILIKE '%termo%' com curinga à ESQUERDA → btree não ajuda; precisa GIN trigram
--     (mesma técnica da migration 029 nos e-mails de `supplier`).
--   - busca por VALOR exato (amount.eq) → btree.
--   - ordenação padrão por created_at DESC + paginação → btree desc.
--
-- pg_trgm já está habilitado (migration 029). Idempotente (IF NOT EXISTS).
--
-- Projeto: pagamentos | Data: 2026-06-29
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ILIKE '%termo%' (curinga à esquerda) — GIN trigram por coluna pesquisável.
CREATE INDEX IF NOT EXISTS idx_fac_invoice_number_trgm
  ON financial_account_control USING gin (invoice_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_fac_subject_trgm
  ON financial_account_control USING gin (subject gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_fac_sender_email_trgm
  ON financial_account_control USING gin (sender_email gin_trgm_ops);

-- Busca por valor exato (amount.eq.<valor>).
CREATE INDEX IF NOT EXISTS idx_fac_amount
  ON financial_account_control (amount);

-- Ordenação padrão do grid (created_at DESC) + paginação por offset.
CREATE INDEX IF NOT EXISTS idx_fac_created_at
  ON financial_account_control (created_at DESC);
