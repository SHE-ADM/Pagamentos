-- 049_authenticated_read_classification_lookups.sql
--
-- Corrige a exibição de Centro de custo / Plano de contas no /consulta (grid e card
-- de detalhe), que mostravam o id (#1) em vez da descrição.
--
-- Causa: financial_cost_center e financial_chart_of_account tinham RLS HABILITADO
-- porém SEM nenhuma policy (default deny). O frontend lê financial_account_control
-- direto via REST com o papel `authenticated` e embute os cadastros
-- (cost_center:financial_cost_center(...) / chart_account:financial_chart_of_account(...));
-- como o RLS bloqueava a leitura desses cadastros para `authenticated`, o PostgREST
-- devolvia o embed NULL e a UI caía no fallback `#id`. (A Next API funciona porque usa
-- service_role, que ignora RLS.)
--
-- Correção: policy de SELECT `TO authenticated` (somente leitura) nas duas tabelas —
-- mesmo padrão da dimensão `status` (migration 036) e de `supplier`. São cadastros de
-- consulta; nenhuma escrita é liberada (continua restrita ao service_role).
--
-- Projeto: pagamentos | Data: 2026-06-25

BEGIN;

-- Garante o grant de tabela (idempotente; o RLS continua sendo o gate efetivo).
GRANT SELECT ON financial_cost_center      TO authenticated;
GRANT SELECT ON financial_chart_of_account TO authenticated;

-- Centro de custo — leitura pelo usuário autenticado (lookup do /consulta e do modal).
CREATE POLICY "authenticated read cost center"
ON financial_cost_center FOR SELECT
TO authenticated
USING (true);

-- Plano de contas — idem.
CREATE POLICY "authenticated read chart of account"
ON financial_chart_of_account FOR SELECT
TO authenticated
USING (true);

COMMIT;
