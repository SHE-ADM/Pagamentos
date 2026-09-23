-- =============================================================
-- 146_barcodes_corrompidos_historicos.sql
-- Curadoria de dados (sem DDL): os 16 códigos de barras corrompidos que restavam na base.
--
-- Projeto: pagamentos | Data: 2026-09-23
--
-- POR QUE EXISTE: no caminho VISUAL o modelo às vezes CONVERTE por conta própria a linha
-- digitável de 47 dígitos em código de barras de 44 e erra o campo livre — valor e fator saem
-- intactos, então só o DV geral acusa. Medidos em 2026-09-22: 20 códigos assim na base, **100%
-- `pdf_vision`** (zero em `pdf_text`/`email_body`). Quatro foram corrigidos pela migration 144
-- (RAINHA MARIA); estes são os 16 restantes. Desde 2026-09-22 o pipeline descarta o código
-- refutado pelo DV em vez de gravá-lo (`_discard_dv_refuted_barcode`), então esta é uma dívida
-- FECHADA: não nascem códigos novos assim.
--
-- POR QUE IMPORTA numa conta já paga: o código de barras é a 1ª impressão digital da dedup. Um
-- código errado NÃO casa a 2ª via do mesmo título quando ela chega por outro e-mail — e nasce
-- conta DUPLICADA, sem erro nenhum. Corrigi-los devolve a chave forte de deduplicação ao
-- acervo inteiro.
--
-- PROCEDÊNCIA DE CADA VALOR: linha digitável **impressa**, lida do PDF original no bucket
-- `attachments` (todos os 16 são PDFs sem camada de texto — por isso `pdf_vision`), e validada
-- por TRÊS testes independentes antes de entrar aqui:
--   (a) DV geral FEBRABAN fecha;
--   (b) valor embutido (posições 10-19) == `amount` da conta;
--   (c) fator de vencimento (posições 6-9) == data de vencimento IMPRESSA no próprio boleto.
-- As sondas abaixo repetem (a) e (b) em SQL: os dígitos foram transcritos à mão, e um erro de
-- transcrição gravaria outro código inventado — exatamente o defeito que esta migration corrige.
--
-- ⚠️ O teste (c) NÃO vira sonda, e o motivo é um achado à parte: em 9 destas contas o
-- `due_date` gravado DIVERGE do vencimento impresso no boleto, porque o código corrompido
-- reprovava no gate de valor e o fator nunca corrigia a data. Exemplos: conta 646 (gravado
-- 2026-07-20, boleto 2026-08-07), conta 1572 (gravado 2026-09-21, boleto 2026-10-19), contas
-- 649/650/651/652 (gravado 2026-07-20, boleto 2026-07-23). **Nada disso é alterado aqui** — as
-- 16 estão PAGAS (status 8) e mexer no vencimento de conta fechada é decisão do usuário, não
-- consequência de uma correção de código de barras. Fica registrado para essa decisão.
--
-- EFEITO: só a coluna `barcode` das 16 contas. Nenhuma outra coluna muda; o `status_id` não é
-- recalculado (a trigger só age em conta EM ABERTO). Reexecução = UPDATE 0 e sondas verdes.
-- =============================================================

BEGIN;

-- ── (id, código correto — linha digitável impressa, já convertida para 44 dígitos) ──────
CREATE TEMP TABLE _bc_146 (
  id       BIGINT PRIMARY KEY,
  bc_certo TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO _bc_146 (id, bc_certo) VALUES
  ( 463, '34192150300032400001122502026142938645989000'),
  ( 503, '23792150500000465733507090000012972200168000'),
  ( 550, '00198151000000778970000002800586000373853317'),
  ( 582, '00196151400000076840000003738976100219382517'),
  ( 583, '00192151400000038420000003738976100219380117'),
  ( 645, '00192151500000151010000003738976100220017117'),
  ( 646, '00191153100000686830000003222164001161437717'),
  ( 649, '00195151600000227850000003738976100220937317'),
  ( 650, '00198151600000227850000003738976100220940417'),
  ( 651, '00197151600000263600000003738976100220941517'),
  ( 652, '00194151600000227850000003738976100220942817'),
  ( 929, '00191154300020388900000003753061000008965517'),
  ( 935, '23796153800015394400165090000000188700836500'),
  ( 999, '00193154800005064780000003708960000000097417'),
  (1004, '03391154000005477759028925400000000049760101'),
  (1572, '00192160400000240000000002836585014336802917');

-- ── Baseline: a linha INTEIRA antes do UPDATE (oráculo de "nada além do código mudou") ──
CREATE TEMP TABLE _baseline_146 ON COMMIT DROP AS
SELECT f.id, to_jsonb(f) AS linha
FROM   public.financial_account_control f
JOIN   _bc_146 b ON b.id = f.id;

-- ── UPDATE — só onde o código atual É o corrompido (DV refutado). O predicado não lista o
-- valor errado uma a uma: ele exige que o código atual NÃO seja o certo, e a sonda P1 fecha
-- o contrato. Reexecutar não encontra linha.
UPDATE public.financial_account_control f
   SET barcode = b.bc_certo
  FROM _bc_146 b
 WHERE f.id = b.id
   AND f.barcode IS DISTINCT FROM b.bc_certo;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sondas — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): as 16 contas existem e entraram no baseline.
  SELECT count(*) INTO v_n FROM _baseline_146;
  IF v_n <> 16 THEN RAISE EXCEPTION 'P0: baseline com % conta(s), esperado 16', v_n; END IF;

  -- P1: as 16 estão com o código transcrito.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _bc_146 b ON b.id = f.id
  WHERE  f.barcode = b.bc_certo;
  IF v_n <> 16 THEN RAISE EXCEPTION 'P1: % de 16 conta(s) com o código corrigido', v_n; END IF;

  -- P2: o DV geral FEBRABAN fecha em TODOS — é o teste que os 16 reprovavam antes. Módulo 11
  -- sobre os 43 dígitos (pesos 2..9 da direita), resto 0/10/11 => DV 1, comparado com a pos. 5.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _bc_146 b ON b.id = f.id
  WHERE  (SELECT CASE WHEN (11 - soma % 11) IN (0, 10, 11) THEN 1 ELSE 11 - soma % 11 END
          FROM (SELECT sum(d::int * (((ord - 1) % 8) + 2)) AS soma
                FROM (SELECT ch AS d, row_number() OVER (ORDER BY i DESC) AS ord
                      FROM regexp_split_to_table(
                             substr(f.barcode, 1, 4) || substr(f.barcode, 6), '') WITH ORDINALITY AS t(ch, i)
                     ) s
               ) c
         ) <> substr(f.barcode, 5, 1)::int;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P2: % código(s) com DV refutado — transcrição errada', v_n; END IF;

  -- P3: o valor embutido no código é o da PRÓPRIA conta — prova que o código não é de outro
  -- título. (O fator NÃO entra: ver a nota sobre vencimentos divergentes no cabeçalho.)
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _bc_146 b ON b.id = f.id
  WHERE  substr(f.barcode, 10, 10)::bigint / 100.0 <> f.amount;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3: % código(s) com valor divergente da conta', v_n; END IF;

  -- P4: nenhum código REPETIDO na base inteira. Dois títulos com o mesmo código fariam a
  -- dedup por barcode fundir contas distintas — o oposto do que esta migration busca.
  SELECT count(*) INTO v_n
  FROM   (SELECT barcode FROM public.financial_account_control
          WHERE barcode IS NOT NULL GROUP BY barcode HAVING count(*) > 1) d;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P4: % código(s) repetido(s) na base', v_n; END IF;

  -- P5: NADA além do `barcode` mudou.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _baseline_146 b ON b.id = f.id
  WHERE  (to_jsonb(f) - 'barcode' - 'updated_at' - 'updated_by')
      <> (b.linha     - 'barcode' - 'updated_at' - 'updated_by');
  IF v_n <> 0 THEN RAISE EXCEPTION 'P5: % conta(s) com outra coluna alterada', v_n; END IF;

  -- P6 (o oráculo do acervo): acabou a dívida — nenhuma conta da base inteira segue com código
  -- de BOLETO cujo DV se refuta. Restrita a códigos de 44 dígitos moeda '9' (arrecadação de 48
  -- tem outro esquema de DV e chave fiscal não é boleto).
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  WHERE  f.barcode IS NOT NULL
    AND  length(regexp_replace(f.barcode, '\D', '', 'g')) = 44
    AND  substr(f.barcode, 4, 1) = '9'
    AND  substr(f.barcode, 1, 3) <> '000'
    AND  (SELECT CASE WHEN (11 - soma % 11) IN (0, 10, 11) THEN 1 ELSE 11 - soma % 11 END
          FROM (SELECT sum(d::int * (((ord - 1) % 8) + 2)) AS soma
                FROM (SELECT ch AS d, row_number() OVER (ORDER BY i DESC) AS ord
                      FROM regexp_split_to_table(
                             substr(f.barcode, 1, 4) || substr(f.barcode, 6), '') WITH ORDINALITY AS t(ch, i)
                     ) s
               ) c
         ) <> substr(f.barcode, 5, 1)::int;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P6: ainda ha % conta(s) com DV de boleto refutado', v_n; END IF;
END $$;

COMMIT;
