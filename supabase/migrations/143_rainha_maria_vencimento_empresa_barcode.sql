-- =============================================================
-- 143_rainha_maria_vencimento_empresa_barcode.sql
-- Curadoria de dados (sem DDL): as contas da RAINHA MARIA afetadas pelos defeitos corrigidos
-- no pipeline em 2026-09-22 (vencimento prorrogado, empresa pagadora e código de barras).
--
-- Projeto: pagamentos | Data: 2026-09-22
--
-- POR QUE EXISTE — três blocos, três causas distintas:
--
-- BLOCO 1 (vencimento, 6 contas). A RAINHA MARIA PRORROGA títulos: reimprime a ficha com a data
--   nova (e os juros "A PARTIR DE" dela) mantendo o FATOR ORIGINAL na linha digitável. O
--   pipeline tratava o fator como autoritativo em toda situação — e a última palavra era do
--   `read_emails._apply_barcode_due_date`, que revertia a data impressa já decidida pelo
--   extrator (a nota DUPLICADA da conta 1613 é a assinatura disso). As contas nasceram com a
--   data velha e apareciam VENCIDAS. Mesmo caso da conta 1029, corrigida À MÃO em 14/08/2026.
--   Data conferida no PDF de cada conta (bucket `attachments`), nas DUAS vias da ficha:
--     1613  NF17241-10  21/09 → 05/10  (juros a partir de 06/10/26)
--     1582  NF16713-7   17/09 → 25/09  (juros a partir de 26/09/26)
--     1583  NF16942-7   17/09 → 25/09
--     1584  NF16943-7   18/09 → 25/09
--     1585  NF16945-7   22/09→ 23/09
--     1588  NF16964-6   21/09 → 24/09
--   `processing_notes` recebe a MESMA ressalva que o pipeline corrigido passa a gravar
--   (`febraban.due_date_extension_note`) — na 1613 ela SUBSTITUI as duas notas antigas, que
--   descrevem a correção ora desfeita.
--
-- BLOCO 2 (empresa pagadora, 9 contas). O e-mail "BOLETOS ESTER" <00b601dd49f2...> foi enviado
--   pela barbara@ (e não pelo endereço exato ester@), então a regra de `sk_company` caiu no
--   default 1 (TECIDOS). São boletos da Ester: empresa 3 (FARDOS), como as outras 72 contas
--   da RAINHA MARIA. Decisão do usuário em 2026-09-22. A REGRA não muda — ampliar o sinal do
--   remetente para o assunto destruiria classificações existentes.
--
-- BLOCO 3 (código de barras, 4 contas). No caminho visual o modelo CONVERTE a linha digitável
--   de 47 dígitos para 44 por conta própria e erra o campo livre (mantém os DVs de bloco). O
--   valor e o fator continuam certos, então `barcode_self_refuted` não pegava; o DV geral pega,
--   e passou a ser a 2ª barreira do Vision. Código errado NÃO casa a 2ª via na dedup e faz
--   nascer conta DUPLICADA. Aqui os 4 recebem a linha digitável REAL, lida do PDF e validada
--   por código (DV geral fecha, valor embutido == `amount` e fator == `due_date` da conta).
--
-- EFEITO: só as colunas citadas. Valores, fornecedor, classificação e anexos NÃO mudam. O
-- `status_id` do bloco 1 é recalculado pela trigger `fn_set_status_from_due_date` (as 6 estão
-- em aberto) — é o efeito DESEJADO: deixam de aparecer como vencidas.
--
-- Cada UPDATE casa o valor ERRADO exato: reexecução = UPDATE 0 e sonda verde. Edição manual
-- posterior de qualquer uma dessas colunas faz a reexecução ABORTAR nas sondas, de propósito.
-- =============================================================

BEGIN;

-- ── Bloco 1 — vencimento PRORROGADO (id, data errada atual, data impressa no PDF) ──────
CREATE TEMP TABLE _venc_143 (
  id          BIGINT PRIMARY KEY,
  venc_errado DATE NOT NULL,
  venc_certo  DATE NOT NULL,
  fator       DATE NOT NULL   -- o que a linha digitável codifica (vai para a ressalva)
) ON COMMIT DROP;

INSERT INTO _venc_143 (id, venc_errado, venc_certo, fator) VALUES
  (1613, '2026-09-21', '2026-10-05', '2026-09-21'),
  (1582, '2026-09-17', '2026-09-25', '2026-09-17'),
  (1583, '2026-09-17', '2026-09-25', '2026-09-17'),
  (1584, '2026-09-18', '2026-09-25', '2026-09-18'),
  (1585, '2026-09-22', '2026-09-23', '2026-09-22'),
  (1588, '2026-09-21', '2026-09-24', '2026-09-21');

-- ── Bloco 3 — barcode (id, código corrompido atual, linha digitável real convertida) ───
CREATE TEMP TABLE _bc_143 (
  id        BIGINT PRIMARY KEY,
  bc_errado TEXT NOT NULL,
  bc_certo  TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO _bc_143 (id, bc_errado, bc_certo) VALUES
  (1614, '00191157700025092000000090358032905000043301',
         '00191157700025092000000003580329000000433017'),
  (1615, '00193157800025092000000003580329000004333117',
         '00193157800025092000000003580329000000433117'),
  (1616, '00193115830002509200000090358032905000043341',
         '00191158300025092000000003580329000000433417'),
  (1589, '00192115780002755200000090358032905000042781',
         '00191157800027552000000003580329000000427812');

-- ── Baseline: a linha INTEIRA antes do UPDATE (oráculo de "nada além disso mudou") ─────
CREATE TEMP TABLE _baseline_143 ON COMMIT DROP AS
SELECT f.id, to_jsonb(f) AS linha
FROM   public.financial_account_control f
WHERE  f.id IN (SELECT id FROM _venc_143)
   OR  f.id IN (SELECT id FROM _bc_143)
   OR  f.id BETWEEN 1581 AND 1589;

-- ── Bloco 1 — UPDATE do vencimento + ressalva ─────────────────────────────────────────
-- A ressalva é a MESMA frase que `febraban.due_date_extension_note` passa a gravar — inclusive
-- o formato ISO da data (`to_char`, nunca o cast implícito, que depende do DateStyle da sessão).
UPDATE public.financial_account_control f
   SET due_date = v.venc_certo,
       processing_notes =
         'Vencimento IMPRESSO mantido (' || to_char(v.venc_certo, 'YYYY-MM-DD')
         || ') — o fator do código de barras indica ' || to_char(v.fator, 'YYYY-MM-DD')
         || ' (boleto prorrogado/reemitido pelo beneficiário)'
  FROM _venc_143 v
 WHERE f.id = v.id
   AND f.due_date = v.venc_errado;

-- ── Bloco 2 — empresa pagadora do e-mail "BOLETOS ESTER" ──────────────────────────────
-- Casa pelo E-MAIL (não por faixa de id): o conjunto é "as contas daquela mensagem".
UPDATE public.financial_account_control
   SET sk_company = 3
 WHERE split_part(gmail_message_id, '#', 1) = '<00b601dd49f2$9aa21650$cfe642f0$@otimotex.com.br>'
   AND sk_company = 1;

-- ── Bloco 3 — barcode real ────────────────────────────────────────────────────────────
UPDATE public.financial_account_control f
   SET barcode = b.bc_certo
  FROM _bc_143 b
 WHERE f.id = b.id
   AND f.barcode = b.bc_errado;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sondas — estado FINAL, dentro da transação.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): as 13 linhas distintas dos três blocos (as 9 do scan — que já contêm
  -- 1582/1583/1584/1585/1588/1589 — mais 1613, 1614, 1615 e 1616) entraram no baseline.
  SELECT count(*) INTO v_n FROM _baseline_143;
  IF v_n <> 13 THEN RAISE EXCEPTION 'P0: baseline com % linha(s), esperado 13', v_n; END IF;

  -- P1: as 6 contas estão com o vencimento IMPRESSO e com a ressalva.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _venc_143 v ON v.id = f.id
  WHERE  f.due_date = v.venc_certo
    AND  f.processing_notes LIKE 'Vencimento IMPRESSO mantido%';
  IF v_n <> 6 THEN RAISE EXCEPTION 'P1: % de 6 conta(s) com o vencimento corrigido', v_n; END IF;

  -- P1b: nenhuma delas guardou a nota da correção que acabou de ser DESFEITA (conta 1613).
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _venc_143 v ON v.id = f.id
  WHERE  f.processing_notes ILIKE '%Vencimento corrigido pelo c%digo de barras%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'P1b: % conta(s) ainda com a nota antiga do fator', v_n; END IF;

  -- P2: as 9 contas do e-mail "BOLETOS ESTER" estão na empresa 3 (FARDOS) — e são 9.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control
  WHERE  split_part(gmail_message_id, '#', 1) = '<00b601dd49f2$9aa21650$cfe642f0$@otimotex.com.br>';
  IF v_n <> 9 THEN RAISE EXCEPTION 'P2: e-mail do scan com % conta(s), esperado 9', v_n; END IF;

  SELECT count(*) INTO v_n
  FROM   public.financial_account_control
  WHERE  split_part(gmail_message_id, '#', 1) = '<00b601dd49f2$9aa21650$cfe642f0$@otimotex.com.br>'
    AND  sk_company <> 3;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P2: % conta(s) do scan fora da empresa 3', v_n; END IF;

  -- P3: os 4 códigos corrigidos e nenhum deles com o DV geral refutado. A conferência do DV
  -- é feita AQUI, em SQL, e não só na origem: o valor foi digitado nesta migration, e um erro
  -- de transcrição gravaria outro código inventado — exatamente o defeito que ela corrige.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _bc_143 b ON b.id = f.id
  WHERE  f.barcode = b.bc_certo;
  IF v_n <> 4 THEN RAISE EXCEPTION 'P3: % de 4 conta(s) com o código corrigido', v_n; END IF;

  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _bc_143 b ON b.id = f.id
  WHERE  -- DV geral FEBRABAN: módulo 11 sobre os 43 dígitos (pesos 2..9 da direita), resto
         -- 0/10/11 => DV 1. Compara com o dígito da posição 5.
         (SELECT CASE WHEN (11 - soma % 11) IN (0, 10, 11) THEN 1 ELSE 11 - soma % 11 END
          FROM (SELECT sum(d::int * (((ord - 1) % 8) + 2)) AS soma
                FROM (SELECT ch AS d, row_number() OVER (ORDER BY i DESC) AS ord
                      FROM regexp_split_to_table(
                             substr(f.barcode, 1, 4) || substr(f.barcode, 6), '') WITH ORDINALITY AS t(ch, i)
                     ) s
               ) c
         ) <> substr(f.barcode, 5, 1)::int;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3: % código(s) com DV geral refutado — transcrição errada', v_n; END IF;

  -- P3b: o código transcrito descreve ESTA conta — valor embutido (posições 10-19, em centavos)
  -- == `amount` e fator (posições 6-9, base do reset FEBRABAN de 22/02/2025) == `due_date`.
  -- Complementa o DV: ele prova que o código é internamente coerente, não que é o desta conta.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _bc_143 b ON b.id = f.id
  WHERE  substr(f.barcode, 10, 10)::bigint / 100.0 <> f.amount
     OR  DATE '2025-02-22' + (substr(f.barcode, 6, 4)::int - 1000) <> f.due_date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P3b: % código(s) com valor/fator divergente da conta', v_n; END IF;

  -- P4: NADA além das colunas previstas mudou (oráculo = linha inteira do baseline). Ficam de
  -- fora as colunas efetivamente alteradas, as carimbadas por trigger e as GERADAS que delas
  -- derivam (`days_late` é consequência do vencimento, não uma alteração).
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _baseline_143 b ON b.id = f.id
  WHERE  (to_jsonb(f) - 'due_date' - 'processing_notes' - 'sk_company' - 'barcode'
                      - 'status_id' - 'status_changed_at' - 'status_changed_by'
                      - 'days_late' - 'updated_at' - 'updated_by')
      <> (b.linha     - 'due_date' - 'processing_notes' - 'sk_company' - 'barcode'
                      - 'status_id' - 'status_changed_at' - 'status_changed_by'
                      - 'days_late' - 'updated_at' - 'updated_by');
  IF v_n <> 0 THEN RAISE EXCEPTION 'P4: % linha(s) com outra coluna alterada', v_n; END IF;

  -- P5: efeito pretendido do bloco 1 — nenhuma das 6 segue marcada como vencida (a trigger
  -- recalculou contra a data de hoje). É o que o usuário vê na tela, e o motivo da migration.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_control f
  JOIN   _venc_143 v ON v.id = f.id
  WHERE  f.status_id = 2;
  IF v_n <> 0 THEN RAISE EXCEPTION 'P5: % conta(s) ainda marcada(s) como vencida', v_n; END IF;
END $$;

COMMIT;
