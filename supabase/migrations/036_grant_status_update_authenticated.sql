-- 036_grant_status_update_authenticated.sql
--
-- Habilita edição inline do status de contas a pagar em /consulta pelo usuário
-- autenticado. A trigger fn_set_status_from_due_date (SECURITY DEFINER) já
-- sincroniza status_id automaticamente a cada UPDATE, sem necessidade de grant
-- adicional para essa coluna.

-- 1. Tabela de dimensão `status` — lida pelo dropdown do frontend
ALTER TABLE status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated read status dimension"
ON status FOR SELECT
TO authenticated
USING (true);

-- 2. Permite ao authenticated atualizar a coluna `status` de financial_account_control
--    (a policy de UPDATE já existe desde a migration 033; aqui só adicionamos o grant
--    de coluna necessário para a escrita via REST com papel authenticated).
GRANT UPDATE (status) ON financial_account_control TO authenticated;
