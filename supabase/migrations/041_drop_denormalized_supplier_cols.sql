-- 041_drop_denormalized_supplier_cols.sql
-- FASE 2 (destrutiva) da eliminação das colunas denormalizadas do fornecedor.
--
-- APLICAR SOMENTE após a Fase 1 (migration 040 + deploy do código) estar
-- validada em produção: o pipeline Python já resolve supplier_id via RPC
-- (resolve_supplier_for_account) e grava apenas a FK; frontend lê nome/CNPJ
-- pelo JOIN com `supplier`. Antes de aplicar, copiar manualmente o
-- read_emails.py atualizado para o deploy de produção (C:\Sheild\API\Pagamentos),
-- senão a produção seguirá inserindo no formato antigo e o INSERT quebrará.

-- 1. Remove o trigger de resolução de fornecedor (a resolução agora é feita no
--    Python via RPC, antes do INSERT). _add_supplier_email / resolve_supplier_id /
--    _enrich_supplier* permanecem — são reusados pela RPC resolve_supplier_for_account.
DROP TRIGGER IF EXISTS trg_fe_supplier_id ON financial_account_control;
DROP FUNCTION IF EXISTS public.trg_fe_resolve_supplier();

-- 2. Remove a RPC de dedup por nome (substituída por dedup por supplier_id no Python).
DROP FUNCTION IF EXISTS public.financial_dup_by_name(text, numeric, text, date, text);

-- 3. Dropa as colunas denormalizadas — fonte de verdade passa a ser a tabela supplier.
ALTER TABLE financial_account_control
  DROP COLUMN IF EXISTS supplier_name,
  DROP COLUMN IF EXISTS supplier_cnpj,
  DROP COLUMN IF EXISTS supplier_cpf;

-- Permanecem intactos: trg_fe_company_id (payer_*), trg_fe_status_vencimento
-- (fn_set_status_from_due_date), trg_fe_updated_at. A FK supplier_id NOT NULL
-- continua garantindo a integridade do vínculo com supplier.
