-- =============================================================
-- 148_reconciliacao_cobranca_pedido_interno.sql
-- Curadoria de dados (sem DDL): contas gravadas pelas duas regras que o pipeline deixou de
-- aplicar em 2026-11-04.
--
-- Projeto: pagamentos | Data: 2026-11-04
--
-- POR QUE EXISTE — o codigo corrigido so vale para e-mails novos.
--
-- BLOCO 1 — contas 162, 167 e 194 (R$ 8.883,44): nasceram de respostas de CLIENTE a nossa
--   cobranca, com situacao 'pago' desde junho, e somam como despesa nos relatorios. A 194 e o
--   comprovante de pagamento de um cliente. Vao para 'cancelado' (decisao do usuario). A trigger
--   fn_set_payment_date limpa `payment_date`; o valor antigo fica em `audit_log`.
--
-- BLOCO 2 — conta 2215 (VALLETEX): o anexo era pedido de compra, o vencimento caiu na data da
--   extracao e a forma ficou 'outro'. O corpo declara vencimento 28/10/2026 e PIX. O fornecedor
--   (sk 473) ja casa o CNPJ do corpo e a situacao 'pago' e do usuario: nada disso muda.
--
-- BLOCO 3 — conta 2227: o corpo pede R$ 140,28 ao REPRESENTANTE PRPP Comercial e Servs Ltda,
--   vencimento 28/10/2026, PIX; o pipeline gravou o recibo dos Correios de R$ 114,30 sob AC
--   IMBITUBA, com o rastreio em `nosso_numero`. O cadastro nasce pela RPC, que e a porta unica de
--   auto-insert. A classificacao fica no sentinela 0: o cadastro novo nao tem default. O sk 1482
--   (AC IMBITUBA) fica: tem CNPJ real. A 1a foto, que esta no Storage sem vinculo, entra como
--   anexo com os metadados reais do objeto.
--
-- FORA DE PROPOSITO: contas 161, 166 e 182 (honorarios, respostas internas com a baixa) nao mudam.
--
-- AUTORIA: fn_stamp_account_authorship, sem JWT, mantem o ultimo editor em `updated_by`, como em
-- toda curadoria por migration (147). A trilha fiel e `audit_log`, onde o ator fica como servico.
--
-- Reexecucao = 0 linhas afetadas e sondas verdes: todo UPDATE e condicionado ao estado antigo.
-- =============================================================

BEGIN;

-- Baseline ANTES dos UPDATEs: a sonda nao pode reavaliar o predicado que eles alteram.
CREATE TEMP TABLE _m148_antes ON COMMIT DROP AS
SELECT id, status_id, sk_supplier, sk_company, due_date, amount, payment_date
FROM   public.financial_account_control
WHERE  id IN (161, 162, 166, 167, 182, 194, 2215, 2227);

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Respostas de cliente a cobranca → cancelado
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.financial_account_control
SET    status_id = 9
WHERE  id IN (162, 167, 194)
  AND  status_id = 8;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Conta 2215 → dados do corpo
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.financial_account_control
SET    due_date         = DATE '2026-10-28',
       payment_method   = 'pix',
       processing_notes = NULL
WHERE  id = 2215
  AND  due_date = DATE '2026-10-27';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Conta 2227 → dados do corpo + 1a foto vinculada
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.financial_account_control
SET    sk_supplier      = public.resolve_supplier_id(NULL, NULL, 'PRPP Comercial e Servs Ltda', NULL),
       amount           = 140.28,
       amount_charged   = 140.28,
       due_date         = DATE '2026-10-28',
       document_type    = 'outro',
       payment_method   = 'pix',
       invoice_number   = 'pix_R$ 140,28',
       nosso_numero     = NULL,
       processing_notes = NULL
WHERE  id = 2227
  AND  sk_supplier = 1482
  AND  amount = 114.30;

INSERT INTO public.financial_account_attachment
       (account_id, storage_key, file_name, mime_type, size_bytes, origin, uploaded_by)
SELECT 2227, o.name, o.name, o.metadata->>'mimetype', (o.metadata->>'size')::bigint, 'pipeline', a.uploaded_by
FROM   storage.objects o
JOIN   public.financial_account_attachment a ON a.account_id = 2227
WHERE  o.bucket_id = 'attachments'
  AND  o.name = 'estela_LE_BIANCO_-_PAGAMENTO_20261027_WhatsApp_Image_2026-.jpeg'
ON CONFLICT (account_id, storage_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transacao: qualquer divergencia desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n   INTEGER;
  v_2227 public.financial_account_control%ROWTYPE;
  v_2215 public.financial_account_control%ROWTYPE;
BEGIN
  -- P0 (anti-vacuidade): as 8 contas existem no baseline.
  SELECT count(*) INTO v_n FROM _m148_antes;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'P0: baseline com % de 8 contas', v_n;
  END IF;

  -- P1: as 3 contas de cliente estao canceladas e sem data de pagamento.
  SELECT count(*) INTO v_n FROM public.financial_account_control
  WHERE  id IN (162, 167, 194) AND status_id = 9 AND payment_date IS NULL;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'P1: % de 3 contas de cliente canceladas', v_n;
  END IF;

  -- P2: honorarios intactos (decisao do usuario).
  SELECT count(*) INTO v_n
  FROM   _m148_antes b
  JOIN   public.financial_account_control f ON f.id = b.id
  WHERE  b.id IN (161, 166, 182)
    AND  (f.status_id, f.sk_supplier, f.due_date, f.amount, f.payment_date)
         IS NOT DISTINCT FROM (b.status_id, b.sk_supplier, b.due_date, b.amount, b.payment_date);
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'P2: honorarios alterados (% de 3 intactas)', v_n;
  END IF;

  -- P3: a 2215 tem os dados do corpo, e o que era do usuario nao mudou.
  SELECT * INTO v_2215 FROM public.financial_account_control WHERE id = 2215;
  IF v_2215.due_date <> DATE '2026-10-28' OR v_2215.payment_method <> 'pix'
     OR v_2215.sk_supplier <> 473 OR v_2215.status_id <> 8 OR v_2215.processing_notes IS NOT NULL THEN
    RAISE EXCEPTION 'P3: conta 2215 divergente';
  END IF;

  -- P4: a 2227 tem os dados do corpo e o fornecedor certo, mantendo a empresa.
  SELECT * INTO v_2227 FROM public.financial_account_control WHERE id = 2227;
  IF v_2227.amount <> 140.28 OR v_2227.amount_charged <> 140.28
     OR v_2227.due_date <> DATE '2026-10-28' OR v_2227.payment_method <> 'pix'
     OR v_2227.nosso_numero IS NOT NULL OR v_2227.sk_company <> 2 THEN
    RAISE EXCEPTION 'P4: conta 2227 divergente';
  END IF;
  SELECT count(*) INTO v_n FROM public.supplier
  WHERE  sk_supplier = v_2227.sk_supplier AND legal_name = 'PRPP Comercial e Servs Ltda'
    AND  deleted_at IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P4: conta 2227 fora do cadastro PRPP (sk %)', v_2227.sk_supplier;
  END IF;

  -- P5: as duas fotos vinculadas, cada uma com o tamanho real do objeto.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_attachment a
  JOIN   storage.objects o ON o.bucket_id = 'attachments' AND o.name = a.storage_key
  WHERE  a.account_id = 2227 AND a.deleted_at IS NULL
    AND  a.size_bytes = (o.metadata->>'size')::bigint;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'P5: % de 2 anexos vinculados a 2227', v_n;
  END IF;
END $$;

COMMIT;
