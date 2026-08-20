-- =============================================================
-- 133_doc_type_dar_dare_consolidado.sql
-- Consolida 'dar' (criado horas antes pela 132) e 'dare' num ÚNICO document_type:
-- 'dar / dare' — Documento de Arrecadação ESTADUAL. Backfill das contas 'dare'.
--
-- Projeto: pagamentos | Data: 2026-08-19
--
-- POR QUE: DAR e DARE nomeiam o MESMO instrumento — a guia de arrecadação estadual —
-- e o acrônimo impresso varia por estado (MT imprime "DOCUMENTO DE ARRECADACAO - DAR
-- MODELO 1 - AUT"; SP imprime "DARE"). Mantê-los separados criava dois rótulos para a
-- mesma coisa no filtro de /consulta, no ContaForm e nos dashboards, e obrigava o
-- extrator a escolher entre eles a cada documento. Mesmo padrão de 'dam / duam', que
-- já resolve DAM e DUAM (arrecadação municipal) com uma entrada só.
--
-- 🔴 A 132 NÃO É EDITADA — migration aplicada é IMUTÁVEL neste projeto, e ela já rodou
-- na base compartilhada dev+prod. Esta migration é a correção, e o registro honesto é
-- que 'dar' existiu como valor próprio entre a 132 e a 133. Nenhuma conta chegou a
-- usá-lo (a 132 foi aplicada sem backfill), então o UPDATE abaixo cobre só 'dare'.
--
-- 🔴 ORDEM OBRIGATÓRIA: DROP do CHECK -> UPDATE -> ADD do CHECK. Invertendo, o
-- ADD CONSTRAINT falharia com 23514 nas 26 linhas que ainda dizem 'dare'.
--
-- ⚠️ O UPDATE dispara as triggers BEFORE da tabela. Medido antes de aplicar: das 26
-- contas 'dare', 24 estão em `pago` (8) — que `fn_set_status_from_due_date` NÃO toca,
-- pois só recalcula quando status_id ∈ {1,2,3} — e as 2 em `a vencer` (3) ainda não
-- venceram, então recalculam para 3 de novo. Nenhuma situação muda.
--
-- ⚠️ A trilha registra este backfill com `ator_via = 'servico'`, e isso é CORRETO:
-- backfill de migration É automação. O GUC `app.audit_actor` é para edição HUMANA
-- atribuível; usá-lo aqui atribuiria a uma pessoa uma mudança que ela não fez.
--
-- Idempotente: o UPDATE tem WHERE restritivo (nada a fazer na 2ª execução) e o CHECK
-- é DROP IF EXISTS + recria.
-- =============================================================

BEGIN;

-- 1) Libera o domínio para o backfill.
ALTER TABLE financial_account_control
  DROP CONSTRAINT IF EXISTS financial_account_control_document_type_check;

-- 2) Backfill: 'dare' e 'dar' passam a ser o valor consolidado.
UPDATE financial_account_control
   SET document_type = 'dar / dare'
 WHERE lower(document_type) IN ('dare', 'dar');

-- 3) Recria o CHECK sem 'dar'/'dare' e com o valor consolidado. Espelha 1:1 o enum
--    DOCUMENT_TYPES de @sheild/shared (32 valores).
ALTER TABLE financial_account_control
  ADD CONSTRAINT financial_account_control_document_type_check CHECK (
    lower(document_type) = ANY (ARRAY[
      'boleto', 'cte', 'nfe', 'nfse', 'seguro', 'fatura', 'recibo', 'contrato',
      'outro', 'darf', 'gps', 'das', 'gru', 'dae',
      -- Documento de Arrecadacao ESTADUAL — os dois acronimos num tipo so (migration 133)
      'dar / dare',
      'gnre', 'ipva', 'iptu',
      'dam / duam', 'iss', 'itbi', 'gare', 'tributo', 'multa', 'honorários',
      'container', 'cartório', 'cheque', 'comprovante',
      -- Contas de concessionaria (migration 043)
      'conta de água', 'conta de luz', 'conta de telefone / internet'
    ]::text[])
  );

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — a migration verifica a si mesma.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def         text;
  v_qtd         int;
  v_consolidado int;
  v_residuo     int;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM   pg_constraint c
  WHERE  c.conrelid = 'public.financial_account_control'::regclass
    AND  c.conname  = 'financial_account_control_document_type_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'sonda vazia: o constraint nao existe apos o DDL';
  END IF;

  -- P1: o valor consolidado entrou e os dois antigos SAIRAM do dominio.
  IF v_def NOT LIKE '%''dar / dare''::text%' THEN
    RAISE EXCEPTION 'P1: dar / dare ausente do CHECK';
  END IF;
  IF v_def LIKE '%''dare''::text%' OR v_def LIKE '%''dar''::text%' THEN
    RAISE EXCEPTION 'P1: dar/dare isolados sobreviveram no CHECK — dominio duplicado';
  END IF;

  -- P2: 'darf' NAO foi engolido pelo prefixo (o modo de falha mais provavel aqui).
  IF v_def NOT LIKE '%''darf''::text%' THEN
    RAISE EXCEPTION 'P2: darf sumiu do CHECK';
  END IF;

  -- P3: cardinalidade — 32 literais (os 32 da 087, com 'dare' trocado por 'dar / dare').
  SELECT count(*) INTO v_qtd FROM regexp_matches(v_def, '''([^'']+)''::text', 'g');
  IF v_qtd <> 32 THEN
    RAISE EXCEPTION 'CHECK com % valores, esperado 32', v_qtd;
  END IF;

  -- P4 (anti-vacuidade + efeito do backfill): existe conta com o valor consolidado e
  -- NENHUMA sobrou com os rotulos antigos.
  SELECT count(*) INTO v_consolidado
  FROM   financial_account_control WHERE document_type = 'dar / dare';
  SELECT count(*) INTO v_residuo
  FROM   financial_account_control WHERE lower(document_type) IN ('dare', 'dar');

  IF v_consolidado = 0 THEN
    RAISE EXCEPTION 'sonda vazia: nenhuma conta com dar / dare — o backfill nao provou nada';
  END IF;
  IF v_residuo <> 0 THEN
    RAISE EXCEPTION 'P4: % conta(s) ainda com o rotulo antigo', v_residuo;
  END IF;
END $$;
