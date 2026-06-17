-- =============================================================
-- 033_add_invoice_bank_slip_flags.sql
-- Flags de curadoria manual em financial_account_control:
--   has_invoice    "Tem NF ?"   — o usuário marca se a conta tem nota fiscal
--   has_bank_slip  "Tem Boleto" — o usuário marca se a conta tem boleto
-- Projeto: pagamentos | Data: 2026-06-17
--
-- Exibidos e editáveis como checkbox no DataGrid de /consulta. Por serem
-- curadoria feita pelo usuário logado, o frontend (papel `authenticated`)
-- precisa escrevê-los via REST. Mesma estratégia da migration 030 (reviewed_at):
-- o privilégio de UPDATE é concedido APENAS a estas duas colunas (column-level
-- grant) + policy de RLS — authenticated não pode alterar nenhuma outra coluna.
-- service_role (pipeline Python) escreve a tabela inteira e não é afetado.
-- =============================================================

ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS has_invoice   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_bank_slip BOOLEAN NOT NULL DEFAULT FALSE;

-- authenticated só pode escrever estas duas colunas (revoga UPDATE de tabela, se
-- houver por grant default do Supabase, e concede apenas as colunas de curadoria).
REVOKE UPDATE ON financial_account_control FROM authenticated;
GRANT  UPDATE (has_invoice, has_bank_slip) ON financial_account_control TO authenticated;

-- RLS: habilita UPDATE para authenticated (a restrição de coluna acima é o que
-- limita o que pode ser alterado). Escrita do pipeline (service_role) inalterada.
DROP POLICY IF EXISTS authenticated_update_financial_flags ON financial_account_control;
CREATE POLICY authenticated_update_financial_flags
  ON financial_account_control FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
