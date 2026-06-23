-- =============================================================
-- 045_supplier_soft_delete.sql
-- Soft delete em `supplier` (padrão Sheild — never hard delete). A baixa de
-- fornecedor pela API marca `deleted_at` em vez de remover a linha; `supplier` é
-- tabela de CADASTRO PRESERVADA (curadoria manual de e-mails). A FK reversa
-- financial_account_control.sk_supplier permanece intacta — a API ainda bloqueia
-- a baixa (409) quando há contas vinculadas.
--
-- Projeto: pagamentos | Data: 2026-06-23
-- =============================================================

BEGIN;

-- 1. Coluna de soft delete (NULL = ativo).
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 2. Índice parcial: as leituras da API filtram deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS ix_supplier_active ON supplier (sk_supplier) WHERE deleted_at IS NULL;

COMMIT;
