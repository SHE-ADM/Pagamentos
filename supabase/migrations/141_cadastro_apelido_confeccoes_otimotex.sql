-- =============================================================
-- 141_cadastro_apelido_confeccoes_otimotex.sql
-- Curadoria de dados (sem DDL): conta 933 sob o cadastro-APELIDO 1227 da própria pagadora.
--
-- Projeto: pagamentos | Data: 2026-09-15
--
-- POR QUE EXISTE: o cadastro 1227 "CONFECCOES OTIMOTEX" (sem CNPJ) é a OTIMOTEX (sk 1) com um
-- nome curto. Ele nasceu em 2026-08-07 pelo auto-insert, na leitura Vision do e-mail "BOLETOS
-- SAMUEL - SHADOW 3" (email_control 1334, 7 boletos com pagadora CONFECCOES SHADOW LTDA). O
-- boleto da conta 933 imprime como BENEFICIÁRIO "CONFECCOES OTIMOTEX - CNPJ/CPF:
-- 047.273.917/0001-23" — o CNPJ do sk 1, conferido na página 6 do PDF. O pipeline descartou o
-- CNPJ pela raiz da pagadora, e o nome, que não é a razão social exata, foi à RPC e criou o
-- cadastro. Mesma família da migration 140, só que fora de guia de tributo.
--
-- EFEITO:
--   1. Conta 933 → sk 1. Classificação (12 Comercial / 631 "Acordos de Terceiros"), situação
--      (8 pago) e data de pagamento NÃO mudam: foram curadas por usuário em 2026-08-25 e são as
--      mesmas dos 6 boletos irmãos do e-mail.
--   2. Cadastro 1227: soft delete, sem conta restante.
--      ⚠️ A RPC de resolução não filtra `deleted_at` no passo por nome (ver 140): quem impede um
--      boleto futuro com o mesmo nome e o CNPJ da pagadora de voltar ao 1227 é a regra
--      BENEFICIÁRIO = pagadora ⇒ sk 1 do pipeline (`_beneficiary_is_own_payer`).
--
-- Cada UPDATE casa o estado ANTERIOR exato; a sonda confere o estado FINAL contra um BASELINE
-- capturado antes do UPDATE (nada de número mágico). Reexecução: UPDATE 0 e sonda verde.
-- =============================================================

BEGIN;

-- ── Baseline: tudo o que NÃO pode mudar na conta 933 ────────────────────────────
CREATE TEMP TABLE _baseline_933 ON COMMIT DROP AS
SELECT id, cost_center_id, chart_account_id, status_id, payment_date, amount_charged, due_date
FROM   public.financial_account_control
WHERE  id = 933;

-- ── 1. Conta 933 → OTIMOTEX ──────────────────────────────────────────────────────
UPDATE public.financial_account_control
   SET sk_supplier = 1
 WHERE id = 933
   AND sk_supplier = 1227;

-- ── 2. Soft delete do cadastro-apelido sem conta ─────────────────────────────────
UPDATE public.supplier s
   SET deleted_at = now()
 WHERE s.sk_supplier = 1227
   AND s.deleted_at IS NULL
   AND COALESCE(s.cnpj, '') = ''
   AND normalize_search(s.trade_name) LIKE '%otimotex%'
   AND NOT EXISTS (SELECT 1 FROM public.financial_account_control f WHERE f.sk_supplier = s.sk_supplier);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): o baseline capturou a conta — sem ela a sonda nao provaria nada.
  SELECT count(*) INTO v_n FROM _baseline_933;
  IF v_n <> 1 THEN RAISE EXCEPTION 'P0: conta 933 ausente do baseline (% linhas)', v_n; END IF;

  -- P1: a 933 esta no sk 1 e NADA alem do fornecedor mudou (oraculo = baseline).
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _baseline_933 b ON b.id = f.id
  WHERE  f.sk_supplier = 1
    AND  f.cost_center_id   = b.cost_center_id
    AND  f.chart_account_id = b.chart_account_id
    AND  f.status_id        = b.status_id
    AND  f.payment_date     IS NOT DISTINCT FROM b.payment_date
    AND  f.amount_charged   = b.amount_charged
    AND  f.due_date         IS NOT DISTINCT FROM b.due_date;
  IF v_n <> 1 THEN RAISE EXCEPTION 'P1: conta 933 fora do sk 1 ou com outro campo alterado'; END IF;

  -- P2: o apelido esta removido e sem conta.
  SELECT count(*) INTO v_n FROM public.supplier s
   WHERE s.sk_supplier = 1227 AND s.deleted_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.financial_account_control f WHERE f.sk_supplier = s.sk_supplier);
  IF v_n <> 1 THEN RAISE EXCEPTION 'P2: cadastro 1227 fora do estado esperado'; END IF;

  -- P3 (oraculo — a MESMA varredura que achou o caso): nenhuma conta, de QUALQUER tipo, sob
  -- cadastro sem CNPJ, fora do sk 1, cujo nome traz a marca OTIMOTEX.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   public.supplier s ON s.sk_supplier = f.sk_supplier
  WHERE  f.sk_supplier <> 1
    AND  COALESCE(s.cnpj, '') = ''
    AND  normalize_search(concat_ws(' ', s.trade_name, s.legal_name)) LIKE '%otimotex%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3: ainda ha % conta(s) sob cadastro-apelido da OTIMOTEX', v_n; END IF;
END $$;

COMMIT;
