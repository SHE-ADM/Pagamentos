-- =============================================================
-- 059_backfill_account_classification_from_supplier.sql
-- Backfill da classificação contábil das contas a partir do fornecedor.
--
-- ⚠️ EXECUÇÃO ÚNICA (one-time). NÃO faz parte do pipeline de extração do dia a dia
-- (read_emails.py / extract_pdf.py permanecem intocados). Corrige apenas o histórico;
-- contas novas continuam herdando a classificação pela regra "Default na criação".
--
-- Direção INVERSA da 052 (que populou supplier ← financial_account_control):
-- aqui, toda conta SEM classificação (cost_center_id = 0 E chart_account_id = 0)
-- HERDA a classificação DEFAULT do seu fornecedor (supplier.cost_center_id /
-- supplier.chart_account_id), espelhando a regra "Default na criação" já aplicada
-- a contas novas — agora aplicada ao histórico.
--
-- Regra do merge:
--   - Só toca contas TOTALMENTE sem classificação (ambos os ids = 0).
--   - Só atualiza quando o fornecedor tem ALGUMA classificação (ao menos um id <> 0);
--     copia o par do fornecedor (um id 0 do fornecedor permanece 0 na conta — sentinela
--     "não informado"). O id 0 existe nos dois cadastros, então as FKs continuam válidas.
--
-- Idempotente: após rodar, as contas atualizadas deixam de ter ambos = 0 e ficam
-- fora do filtro — reaplicar é seguro (não há linhas a alterar de novo).
--
-- Trigger de status: `trg_fe_status_vencimento` (BEFORE UPDATE) só recalcula
-- 'a vencer'/'vencido' quando o status está em aberto (migration 034); contas
-- baixadas/pagas/canceladas preservam o status neste UPDATE.
--
-- Projeto: pagamentos | Data: 2026-06-29
-- =============================================================

BEGIN;

UPDATE financial_account_control fac
   SET cost_center_id   = s.cost_center_id,
       chart_account_id = s.chart_account_id
  FROM supplier s
 WHERE fac.sk_supplier = s.sk_supplier
   AND fac.cost_center_id = 0
   AND fac.chart_account_id = 0
   AND (s.cost_center_id <> 0 OR s.chart_account_id <> 0);

COMMIT;

-- Verificação (rodar separadamente após o COMMIT):
--   SELECT count(*) AS contas_sem_classificacao
--     FROM financial_account_control
--    WHERE cost_center_id = 0 AND chart_account_id = 0;
