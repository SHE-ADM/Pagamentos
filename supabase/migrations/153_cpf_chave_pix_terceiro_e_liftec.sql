-- =============================================================
-- 153_cpf_chave_pix_terceiro_e_liftec.sql
-- Curadoria de dados (sem DDL): CPF de chave PIX gravado como identidade do fornecedor.
--
-- Projeto: pagamentos | Data: 2026-11-10
--
-- POR QUE EXISTE (review max 2026-11-10): o passo de CPF da RPC resolve_supplier_id roda ANTES
--   do nome e NAO filtra deleted_at. Um CPF que nao e do fornecedor captura contas alheias; e o
--   reader agora confia no CPF do cadastro para devolver a chave PIX do proprio fornecedor
--   (_confirmed_pix_key_cpf). Dois cadastros ainda carregavam CPF errado:
--
--   1. sk 1326 JACACAR (MONOCAR): cpf = 02179782152, chave PIX de Eliezer Nogueira, que comprou as
--      pecas e recebe por ele (e-mail 1302: "o pix nao bate com o CNPJ da nota"). Mesmo padrao do
--      mecanico que a 151 tirou do sk 1497. `pix_key1` FICA: e por onde se paga.
--   2. sk 1424: cadastro SEM NOME criado pelo "PIX (CPF): 318.169.878-40" (titular Fabricio
--      Melquiades) dos e-mails da Liftec, com o e-mail financeiro@liftecelevadores.com.br — duplica
--      a LIFTEC sk 1210. Unica conta: 1562 (cancelada, R$ 80.133,06). A conta vai para o sk 1210,
--      o CPF e a chave PIX passam ao sk 1210 (os e-mails da Liftec trazem so a chave, sem nome nem
--      CNPJ, e precisam resolver para a Liftec) e o sk 1424 e removido (soft delete) SEM os
--      identificadores — senao a RPC, que ignora deleted_at, continuaria a devolve-lo.
--
-- Reexecucao = 0 linhas e sondas verdes: todo UPDATE e condicionado ao estado antigo.
-- =============================================================

BEGIN;

CREATE TEMP TABLE _m153_antes ON COMMIT DROP AS
SELECT (SELECT count(*) FROM public.financial_account_control WHERE sk_supplier = 1210) AS contas_1210,
       (SELECT count(*) FROM public.financial_account_control WHERE sk_supplier = 1424) AS contas_1424,
       (SELECT cnpj     FROM public.supplier WHERE sk_supplier = 1210)                 AS cnpj_1210;

-- 1. JACACAR: o CPF do terceiro deixa de ser identidade.
UPDATE public.supplier
SET    cpf = NULL
WHERE  sk_supplier = 1326
  AND  cpf = '02179782152';

-- 2a. Conta 1562 -> LIFTEC.
UPDATE public.financial_account_control
SET    sk_supplier = 1210
WHERE  sk_supplier = 1424;

-- 2b. Identificadores saem do sk 1424 e ele e removido (soft delete). chk_supplier_has_identifier
--     exige nome ou documento: fica um NOME-MARCADOR que nenhuma extracao produz (o passo por nome
--     da RPC tambem ignora deleted_at), no padrao do cadastro-lixo da 147. < 60 caracteres (138).
UPDATE public.supplier
SET    legal_name = 'DUPLICADO DE LIFTEC SK 1210 (REMOVIDO)',
       cpf        = NULL,
       email      = NULL,
       pix_key1   = NULL,
       deleted_at = now()
WHERE  sk_supplier = 1424
  AND  deleted_at IS NULL;

-- 2c. CPF e chave PIX do titular passam a identificar a LIFTEC (so onde ela nao tem nenhum).
UPDATE public.supplier
SET    cpf      = COALESCE(cpf, '31816987840'),
       pix_key1 = COALESCE(pix_key1, '31816987840')
WHERE  sk_supplier = 1210
  AND  (cpf IS NULL OR pix_key1 IS NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transacao: qualquer divergencia desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_b   _m153_antes%ROWTYPE;
  v_n   BIGINT;
  v_txt TEXT;
BEGIN
  SELECT * INTO v_b FROM _m153_antes;

  -- P0 (anti-vacuidade): a LIFTEC existe com o CNPJ esperado.
  IF v_b.cnpj_1210 IS DISTINCT FROM '04121151000159' THEN
    RAISE EXCEPTION 'P0: sk 1210 ausente ou com CNPJ inesperado (%)', v_b.cnpj_1210;
  END IF;

  -- P1: nenhum cadastro carrega o CPF do Eliezer; a chave PIX da JACACAR continua.
  SELECT count(*) INTO v_n FROM public.supplier WHERE cpf = '02179782152';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P1: % cadastro(s) ainda com o CPF 02179782152', v_n;
  END IF;
  SELECT pix_key1 INTO v_txt FROM public.supplier WHERE sk_supplier = 1326;
  IF v_txt IS DISTINCT FROM '02179782152' THEN
    RAISE EXCEPTION 'P1: chave PIX da JACACAR alterada (%)', v_txt;
  END IF;

  -- P2: o sk 1424 nao tem conta e, removido, nao carrega identificador nenhum.
  SELECT count(*) INTO v_n FROM public.financial_account_control WHERE sk_supplier = 1424;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P2: sk 1424 ainda com % conta(s)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.supplier
  WHERE  sk_supplier = 1424
    AND  deleted_at IS NOT NULL AND cpf IS NULL AND email IS NULL AND pix_key1 IS NULL
    AND  legal_name = 'DUPLICADO DE LIFTEC SK 1210 (REMOVIDO)' AND cnpj IS NULL AND trade_name IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P2: sk 1424 nao removido ou ainda com identificador';
  END IF;

  -- P3: as contas do 1424 chegaram ao 1210, sem perda nem sobra.
  SELECT count(*) INTO v_n FROM public.financial_account_control WHERE sk_supplier = 1210;
  IF v_n <> v_b.contas_1210 + v_b.contas_1424 THEN
    RAISE EXCEPTION 'P3: sk 1210 com % contas (antes % + %)', v_n, v_b.contas_1210, v_b.contas_1424;
  END IF;

  -- P4: o CPF do titular identifica UM cadastro so, a LIFTEC, que manteve o CNPJ.
  SELECT count(*) INTO v_n FROM public.supplier WHERE cpf = '31816987840';
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM public.supplier
                             WHERE sk_supplier = 1210 AND cpf = '31816987840'
                               AND cnpj = '04121151000159') THEN
    RAISE EXCEPTION 'P4: CPF 31816987840 fora do sk 1210 ou em % cadastro(s)', v_n;
  END IF;
END $$;

COMMIT;
