-- 126_fix_ester_terceiros_classification.sql
--
-- Correção pontual de dado (sem DDL): contas lançadas pela usuária ester@otimotex.com.br em
-- 72.1.06 — Estamparia ou 21.1.01 — Mercadorias para Revenda deveriam ter sido classificadas em
-- 83.1.01 — Acordos de Terceiros. Pedido do usuário, 2026-08-14.
--
-- Alvo: chart_account_id 631 (83.1.01 — Acordos de Terceiros), cost_center_id 12 (Comercial) —
-- par validado contra financial_chart_of_account.cost_center_id, a mesma regra que
-- checkClassificationPair (apps/api-backend/lib/classification.ts) aplicaria via API.
--
-- Escopo: SÓ contas com created_by = ester — nenhuma conta de outro usuário é tocada, mesmo
-- quando o fornecedor é compartilhado (ver UPDATE 2).
--
-- IDEMPOTENTE: o WHERE casa só o par antigo (chart_account_id, cost_center_id); numa reexecução
-- os pares já estão em 631/12 e nada é afetado.

-- 1) Contas da ester: 152/19 (21.1.01) ou 528/10 (72.1.06) -> 631/12 (83.1.01)
UPDATE public.financial_account_control
   SET chart_account_id = 631,
       cost_center_id   = 12
 WHERE created_by = '2649d755-192f-4793-8efa-1d4649e68343'
   AND (
        (chart_account_id = 152 AND cost_center_id = 19)
     OR (chart_account_id = 528 AND cost_center_id = 10)
   )
RETURNING id, chart_account_id, cost_center_id;

-- 2) Default dos fornecedores envolvidos, espelhando a correção acima. Decisão do usuário:
--    aplica aos 4 fornecedores, inclusive 792 e 611 (cujo default hoje também é usado por
--    contas de OUTROS usuários, não tocadas aqui) — isto muda só o pré-preenchimento de conta
--    NOVA, não altera nenhuma conta já lançada por outro usuário.
UPDATE public.supplier
   SET chart_account_id = 631,
       cost_center_id   = 12
 WHERE sk_supplier IN (611, 792, 883, 1317)
   AND (
        (chart_account_id = 152 AND cost_center_id = 19)
     OR (chart_account_id = 528 AND cost_center_id = 10)
   )
RETURNING sk_supplier, chart_account_id, cost_center_id;
