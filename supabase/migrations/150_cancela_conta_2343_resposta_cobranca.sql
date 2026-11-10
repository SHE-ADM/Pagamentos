-- =============================================================
-- 150_cancela_conta_2343_resposta_cobranca.sql
-- Curadoria de dados (sem DDL): cancela a conta falsa nascida de resposta interna a nossa cobranca.
--
-- Projeto: pagamentos | Data: 2026-11-05
--
-- POR QUE EXISTE: "RES: COBRANCA OTIMOTEX TECIDO" (Rose, e-mail 3364) so comenta o titulo 254697-A
--   da cliente Gloriascloset, a RECEBER. O reader anterior ao deploy de 2026-11-05 gravou o valor
--   citado como conta a pagar (R$ 2.987,25, vencida). A versao atual ignora esse e-mail. O cancelamento
--   e decisao do usuario. O valor antigo e o ator (servico) ficam em `audit_log`.
--
-- FORA DE PROPOSITO: o cadastro sk 1472 fica, pois tem outras contas, e o e-mail segue como esta.
--
-- Reexecucao = 0 linhas e sondas verdes: o UPDATE e condicionado ao estado antigo.
-- =============================================================

BEGIN;

-- Baseline ANTES do UPDATE: a sonda nao pode reavaliar o predicado que ele altera.
CREATE TEMP TABLE _m150_antes ON COMMIT DROP AS
SELECT id, status_id, amount, due_date, sk_supplier, payment_date,
       (SELECT count(*) FROM public.financial_account_control WHERE status_id <> 9) AS nao_canceladas
FROM   public.financial_account_control
WHERE  id = 2343;

UPDATE public.financial_account_control
SET    status_id = 9
WHERE  id = 2343
  AND  sk_supplier = 1472
  AND  amount = 2987.25
  AND  status_id IN (1, 2, 3);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transacao: qualquer divergencia desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_b _m150_antes%ROWTYPE;
  v_c public.financial_account_control%ROWTYPE;
  v_nao_canceladas BIGINT;
  v_esperadas BIGINT;
BEGIN
  -- P0 (anti-vacuidade): a conta existe e e a esperada.
  SELECT * INTO v_b FROM _m150_antes;
  IF NOT FOUND OR v_b.amount <> 2987.25 OR v_b.sk_supplier <> 1472 THEN
    RAISE EXCEPTION 'P0: conta 2343 ausente ou diferente da esperada';
  END IF;

  -- P1: cancelada, sem data de pagamento e com valor e vencimento preservados.
  SELECT * INTO v_c FROM public.financial_account_control WHERE id = 2343;
  IF v_c.status_id <> 9 OR v_c.payment_date IS NOT NULL
     OR v_c.amount <> v_b.amount OR v_c.due_date <> v_b.due_date THEN
    RAISE EXCEPTION 'P1: conta 2343 divergente (status_id %)', v_c.status_id;
  END IF;

  -- P2: nenhuma outra conta saiu do conjunto em aberto: so a 2343 muda.
  SELECT count(*) INTO v_nao_canceladas FROM public.financial_account_control WHERE status_id <> 9;
  v_esperadas := v_b.nao_canceladas;
  IF v_b.status_id <> 9 THEN
    v_esperadas := v_esperadas - 1;
  END IF;
  IF v_nao_canceladas <> v_esperadas THEN
    RAISE EXCEPTION 'P2: % nao canceladas, esperadas %', v_nao_canceladas, v_esperadas;
  END IF;
END $$;

COMMIT;
