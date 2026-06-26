-- 055_doc_idempotency_guards.sql
-- Migration de DOCUMENTAÇÃO (idempotente, re-executável): NÃO altera dados nem schema.
-- Registra no próprio banco, via COMMENT ON, dois fatos que estavam só no código/relatório
-- de revisão, para que um DBA que leia o schema não precise inferir o comportamento:
--   1. O ON DELETE EFETIVO das FKs de classificação contábil (comentário "RESTRICT" nas
--      migrations 047/052 vs DDL sem ON DELETE = NO ACTION — o efeito de BLOQUEAR o delete
--      de um cadastro em uso é equivalente, e o backend ainda devolve 409).
--   2. A coluna `status` é a 4ª coluna gravável por `authenticated` em
--      financial_account_control (migration 036), além de reviewed_at (030) e
--      has_invoice/has_bank_slip (033) — edição inline da situação em /consulta.
--
-- Todas as instruções abaixo são COMMENT ON (idempotentes): podem ser reaplicadas sem erro.
-- Diferente de 042/050/051/053/039, esta migration é SEGURA para re-run.

-- 1. ON DELETE efetivo das FKs de classificação (NO ACTION ≡ RESTRICT sem deferição).
COMMENT ON CONSTRAINT fk_fac_cost_center ON financial_account_control IS
  'FK -> financial_cost_center(cost_center_id). ON DELETE NO ACTION (efeito = RESTRICT): '
  'bloqueia excluir um centro de custo em uso. O backend (lib/cost-centers) tambem valida e devolve 409.';

COMMENT ON CONSTRAINT fk_fac_chart_account ON financial_account_control IS
  'FK -> financial_chart_of_account(chart_account_id). ON DELETE NO ACTION (efeito = RESTRICT): '
  'bloqueia excluir um plano de contas em uso. O backend (lib/chart-accounts) tambem valida e devolve 409.';

COMMENT ON CONSTRAINT fk_supplier_cost_center ON supplier IS
  'FK -> financial_cost_center(cost_center_id) (classificacao default do fornecedor). ON DELETE NO ACTION (efeito = RESTRICT).';

COMMENT ON CONSTRAINT fk_supplier_chart_account ON supplier IS
  'FK -> financial_chart_of_account(chart_account_id) (classificacao default do fornecedor). ON DELETE NO ACTION (efeito = RESTRICT).';

-- 2. Colunas gravaveis por `authenticated` em financial_account_control (grant por coluna).
COMMENT ON COLUMN financial_account_control.status IS
  'Situacao/ciclo de vida (10 valores). GRANT UPDATE (status) TO authenticated na migration 036 '
  '(edicao inline em /consulta). E a 4a coluna gravavel pelo frontend, junto de reviewed_at (030) '
  'e has_invoice/has_bank_slip (033); a trigger fn_set_status_from_due_date sincroniza status_id.';
