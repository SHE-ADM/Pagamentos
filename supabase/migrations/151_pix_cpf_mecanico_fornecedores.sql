-- =============================================================
-- 151_pix_cpf_mecanico_fornecedores.sql
-- Curadoria de dados (sem DDL): desfaz a fusao de fornecedores causada pelo CPF de uma CHAVE PIX.
--
-- Projeto: pagamentos | Data: 2026-11-07
--
-- POR QUE EXISTE: os e-mails 3390-3392 (06/11/2026, estela@lebianco.com.br) pedem pagamento a
--   RDR DISTRIBUIDORA, TURBO DRIVE e ELG SERVICOS MECANICOS, todos com "Pix CPF: 28046637874" — o
--   MECANICO que comprou as pecas. O reader leu esse CPF como identidade do fornecedor:
--     - o cadastro criado para a RDR (sk 1497) nasceu com o CPF do mecanico;
--     - a ELG (conta 2374, R$ 3.630,00) casou o sk 1497 pelo passo de CPF da RPC;
--     - a TURBO DRIVE (NF 57, R$ 1.590,00) casou o sk 1497 e, com o mesmo valor e vencimento da
--       NF 2752, foi descartada como `duplicidade` da conta 2373.
--   O reader corrigido descarta o CPF de chave PIX quando ha nome rotulado ou CNPJ.
--
-- O QUE FAZ:
--   1. Remove o CPF do mecanico do sk 1497 (senao ele continua sequestrando contas).
--   2. Cria o cadastro da ELG pela propria RPC (mesmo caminho do pipeline) e move a conta 2374.
-- FORA DE PROPOSITO: a conta da TURBO DRIVE nasce pelo reprocessamento do e-mail 3391
--   (scripts/reprocess_message.py), depois desta migration.
--
-- Reexecucao = 0 linhas e sondas verdes: os UPDATEs sao condicionados ao estado antigo.
-- =============================================================

BEGIN;

CREATE TEMP TABLE _m151_antes ON COMMIT DROP AS
SELECT (SELECT cpf         FROM public.supplier                  WHERE sk_supplier = 1497) AS cpf_1497,
       (SELECT sk_supplier FROM public.financial_account_control WHERE id = 2374)          AS sk_2374,
       (SELECT amount      FROM public.financial_account_control WHERE id = 2374)          AS amount_2374,
       (SELECT count(*)    FROM public.financial_account_control WHERE sk_supplier = 1497) AS contas_1497;

-- 1. O CPF do mecanico sai do cadastro da RDR.
UPDATE public.supplier
SET    cpf = NULL
WHERE  sk_supplier = 1497
  AND  cpf = '28046637874';

-- 2. Conta 2374 -> cadastro proprio da ELG (criado ou casado por nome, nunca por CPF).
DO $$
DECLARE
  v_elg BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_account_control
             WHERE id = 2374 AND sk_supplier = 1497 AND amount = 3630.00) THEN
    v_elg := public.resolve_supplier_id(NULL, NULL, 'ELG SERVIÇOS MECÂNICOS', NULL);
    UPDATE public.financial_account_control
    SET    sk_supplier = v_elg
    WHERE  id = 2374
      AND  sk_supplier = 1497;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transacao: qualquer divergencia desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_b       _m151_antes%ROWTYPE;
  v_cpf     TEXT;
  v_sk      BIGINT;
  v_name    TEXT;
  v_cpf_elg TEXT;
  v_n1497   BIGINT;
  v_esperadas BIGINT;
BEGIN
  -- P0 (anti-vacuidade): o estado de partida e o esperado (ou ja corrigido, na reexecucao).
  SELECT * INTO v_b FROM _m151_antes;
  IF v_b.amount_2374 IS DISTINCT FROM 3630.00 THEN
    RAISE EXCEPTION 'P0: conta 2374 ausente ou com valor inesperado (%)', v_b.amount_2374;
  END IF;

  -- P1: o sk 1497 nao carrega mais o CPF do mecanico.
  SELECT cpf INTO v_cpf FROM public.supplier WHERE sk_supplier = 1497;
  IF v_cpf IS NOT NULL THEN
    RAISE EXCEPTION 'P1: sk 1497 ainda com CPF %', v_cpf;
  END IF;

  -- P2: a 2374 saiu do sk 1497 para um cadastro de nome ELG, sem o CPF do mecanico.
  SELECT f.sk_supplier, s.legal_name, s.cpf INTO v_sk, v_name, v_cpf_elg
  FROM   public.financial_account_control f
  JOIN   public.supplier s USING (sk_supplier)
  WHERE  f.id = 2374;
  IF v_sk = 1497 OR normalize_search(v_name) <> normalize_search('ELG SERVIÇOS MECÂNICOS')
     OR v_cpf_elg IS NOT NULL THEN
    RAISE EXCEPTION 'P2: conta 2374 em sk % (%), cpf %', v_sk, v_name, v_cpf_elg;
  END IF;

  -- P3: so a 2374 saiu do sk 1497 (a 2373 da RDR fica).
  -- 🔴 Esperado em variavel: um CASE ... THEN dentro do IF encerra a condicao no 1º THEN.
  SELECT count(*) INTO v_n1497 FROM public.financial_account_control WHERE sk_supplier = 1497;
  v_esperadas := v_b.contas_1497;
  IF v_b.sk_2374 = 1497 THEN
    v_esperadas := v_esperadas - 1;
  END IF;
  IF v_n1497 <> v_esperadas THEN
    RAISE EXCEPTION 'P3: sk 1497 com % contas (antes %)', v_n1497, v_b.contas_1497;
  END IF;
END $$;

COMMIT;
