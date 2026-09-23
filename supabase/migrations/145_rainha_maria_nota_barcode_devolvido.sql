-- =============================================================
-- 145_rainha_maria_nota_barcode_devolvido.sql
-- Curadoria de dados (sem DDL): 7 contas afirmam "Código de barras descartado" E TÊM código.
--
-- Projeto: pagamentos | Data: 2026-09-22
--
-- POR QUE EXISTE: a migration 144 devolveu a linha digitável IMPRESSA às parcelas 4-10 da NF
-- 1724 (transcritas do PDF e validadas por DV + valor + fator), mas não tocou a
-- `processing_notes` que o pipeline havia gravado ao descartar o código lido pelo Vision. O
-- resultado é uma contradição na única coluna que o operador lê para decidir se confere o
-- papel: "Código de barras descartado — DV não confere" numa conta cujo código está lá.
--
-- 🔴 Por que uma migration NOVA e não um ajuste na 144: artefato já aplicado não se reescreve.
-- O registro do que a 144 fez — e do que ela esqueceu — é parte da trilha.
--
-- EFEITO: só `processing_notes`, e só nas contas que (a) têm a nota de descarte e (b) têm
-- barcode. A nota é REMOVIDA por segmento (' | ' é o separador do pipeline), preservando
-- qualquer outra observação da mesma conta. Reexecução = UPDATE 0 e sondas verdes.
-- =============================================================

BEGIN;

CREATE TEMP TABLE _baseline_145 ON COMMIT DROP AS
SELECT id, to_jsonb(f) AS linha
FROM   public.financial_account_control f
WHERE  f.processing_notes ILIKE '%digo de barras descartado%'
  AND  f.barcode IS NOT NULL;

-- Remove SÓ os segmentos de descarte; o que sobrar vazio vira NULL (a coluna aceita, e string
-- vazia apareceria como uma observação em branco na tela).
UPDATE public.financial_account_control f
   SET processing_notes = NULLIF(
         (SELECT string_agg(seg, ' | ' ORDER BY ord)
          FROM   regexp_split_to_table(f.processing_notes, ' \| ') WITH ORDINALITY AS t(seg, ord)
          WHERE  seg NOT ILIKE 'C_digo de barras descartado%'),
         '')
 WHERE  f.processing_notes ILIKE '%digo de barras descartado%'
   AND  f.barcode IS NOT NULL;

DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): havia contradição a corrigir — exatamente as 7 medidas.
  SELECT count(*) INTO v_n FROM _baseline_145;
  IF v_n <> 7 THEN RAISE EXCEPTION 'P0: baseline com % conta(s), esperado 7', v_n; END IF;

  -- P1: nenhuma conta do banco INTEIRO afirma descarte tendo código de barras.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control
  WHERE  processing_notes ILIKE '%digo de barras descartado%'
    AND  barcode IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P1: ainda ha % conta(s) com nota contraditoria', v_n; END IF;

  -- P2: a nota de descarte continua existindo onde ela é VERDADE (conta sem barcode) — o
  -- UPDATE não pode ter varrido o sinal legítimo junto.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control
  WHERE  processing_notes ILIKE '%digo de barras descartado%'
    AND  barcode IS NULL;
  IF v_n < 1 THEN RAISE EXCEPTION 'P2: a nota de descarte sumiu tambem onde era verdadeira'; END IF;

  -- P3: NADA além de `processing_notes` mudou nas 7.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _baseline_145 b ON b.id = f.id
  WHERE  (to_jsonb(f) - 'processing_notes' - 'updated_at' - 'updated_by')
      <> (b.linha     - 'processing_notes' - 'updated_at' - 'updated_by');
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3: % conta(s) com outra coluna alterada', v_n; END IF;
END $$;

COMMIT;
