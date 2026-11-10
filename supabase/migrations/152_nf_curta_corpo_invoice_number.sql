-- =============================================================
-- 152_nf_curta_corpo_invoice_number.sql
-- Curadoria de dados (sem DDL): grava o no CURTO da NF citada no corpo nas 9 contas que
-- nasceram com o no SINTETICO 'pix_R$ ...'.
--
-- Projeto: pagamentos | Data: 2026-11-09
--
-- POR QUE EXISTE: `_BODY_INVOICE_RE` exigia 3+ digitos, e as notas internas de pagamento
--   ("pagamento da NF 57 em anexo") caiam no no sintetico. O reader corrigido le o curto como
--   ULTIMO recurso (`_short_body_invoice_number`). A varredura dos 1.992 corpos achou
--   exatamente estas 9 contas (H20IL, EFE INDUSTRIA, TURBO DRIVE).
--
-- O QUE FAZ: para cada conta, se `invoice_number` ainda e o sintetico original, grava a NF
--   com a MESMA regra de unicidade do pipeline (`unique_invoice_number`): a NF pura se livre,
--   senao o 1o `NF(N)` livre, N >= 2. Hoje "56" e "57" ja existem no sk 1434 -> 56(2)/57(2).
--   Contas processadas em ordem de id: o resultado e deterministico.
--
-- Reexecucao = 0 linhas e sondas verdes: o UPDATE e condicionado ao sintetico original.
-- =============================================================

BEGIN;

CREATE TEMP TABLE _m152_alvo (
  id         BIGINT PRIMARY KEY,
  nf         TEXT          NOT NULL,
  sintetico  TEXT          NOT NULL,
  amount     NUMERIC(15,2) NOT NULL
) ON COMMIT DROP;

INSERT INTO _m152_alvo (id, nf, sintetico, amount) VALUES
  ( 964, '56', 'pix_R$ 340,00',      340.00),
  (1251, '11', 'pix_R$ 22.000,00', 22000.00),
  (1305, '15', 'pix_R$ 17.600,00', 17600.00),
  (1381, '21', 'pix_R$ 31.380,00', 31380.00),
  (1528, '59', 'pix_R$ 385,00',      385.00),
  (1789, '60', 'pix_R$ 835,00',      835.00),
  (2120, '62', 'pix_R$ 705,00',      705.00),
  (2121, '63', 'pix_R$ 810,00',      810.00),
  (2396, '57', 'pix_R$ 1.590,00',   1590.00);

DO $$
DECLARE
  r       RECORD;
  v_novo  TEXT;
  v_n     INT;
BEGIN
  FOR r IN SELECT a.id, a.nf
           FROM   _m152_alvo a
           JOIN   public.financial_account_control f
             ON   f.id = a.id AND f.invoice_number = a.sintetico
           ORDER  BY a.id
  LOOP
    -- Mesma regra de unique_invoice_number: base livre, senao base(N), N >= 2.
    v_novo := r.nf;
    v_n    := 2;
    WHILE EXISTS (SELECT 1 FROM public.financial_account_control
                  WHERE invoice_number = v_novo) LOOP
      v_novo := r.nf || '(' || v_n || ')';
      v_n    := v_n + 1;
    END LOOP;

    UPDATE public.financial_account_control
    SET    invoice_number = v_novo
    WHERE  id = r.id;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transacao: qualquer divergencia desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n BIGINT;
BEGIN
  -- P0 (anti-vacuidade): as 9 contas existem com o valor esperado.
  SELECT count(*) INTO v_n
  FROM   _m152_alvo a JOIN public.financial_account_control f
    ON   f.id = a.id AND f.amount = a.amount;
  IF v_n <> 9 THEN
    RAISE EXCEPTION 'P0: % de 9 contas com id/valor esperado', v_n;
  END IF;

  -- P1: nenhuma ficou com o sintetico.
  SELECT count(*) INTO v_n
  FROM   _m152_alvo a JOIN public.financial_account_control f
    ON   f.id = a.id AND f.invoice_number = a.sintetico;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P1: % contas ainda com o no sintetico', v_n;
  END IF;

  -- P2: cada conta tem a SUA NF, pura ou com sufixo de unicidade.
  SELECT count(*) INTO v_n
  FROM   _m152_alvo a JOIN public.financial_account_control f ON f.id = a.id
  WHERE  f.invoice_number !~ ('^' || a.nf || '(\(\d+\))?$');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P2: % contas com invoice_number fora da NF esperada', v_n;
  END IF;

  -- P3: os numeros gravados nao colidem com nenhuma outra conta.
  SELECT count(*) INTO v_n
  FROM   _m152_alvo a
  JOIN   public.financial_account_control f ON f.id = a.id
  JOIN   public.financial_account_control o
    ON   o.invoice_number = f.invoice_number AND o.id <> f.id;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P3: % colisoes de invoice_number', v_n;
  END IF;
END $$;

COMMIT;
