-- =============================================================
-- 149_conta_honorarios_email_1720.sql
-- Curadoria de dados (sem DDL): grava a conta de honorarios que o e-mail 1720 nunca gerou.
--
-- Projeto: pagamentos | Data: 2026-11-05
--
-- POR QUE EXISTE: "PAGAMENTO Honorarios 26/08/2026" (Rose, R$ 450,00, PIX, "p/ fornecedor Wesley")
--   nao identificava o credor pela RPC. A conta nao foi gravada e o e-mail ficou 'ignorado', sem
--   linha em /erros. O codigo corrigido so vale para e-mails novos, e este saiu da caixa IMAP, entao
--   reprocess_message.py nao o alcanca (decisao do usuario: migration).
--
-- COMO: os campos seguem as contas irmas (1224, mesmo modelo de e-mail). Fornecedor sk 1188, plano
--   86 e centro 1 sao o default do cadastro. Por decisao do usuario, o vencimento e o dia do
--   lancamento (05/11/2026) e a observacao declara o atraso e a data real do e-mail. A emissao segue
--   sendo a do servico. A conta nasce EM ABERTO: a data de pagamento e da trigger e nao e inventada
--   aqui. O anexo image001.png, que esta no Storage sem vinculo, entra com os metadados reais do objeto.
--
-- VISIBILIDADE: /consulta abre no mes atual sobre due_date e ordena por created_at desc. Com o
--   vencimento de hoje e created_at = now(), a conta abre no topo da tela, sem coluna nem regra nova.
--   Contas gravadas depois passam a vir acima dela, como em toda conta.
--
-- OBSERVACAO nas duas colunas: a tela mostra processing_notes como "Observacoes" e additional_info
--   na linha do grid e no formulario.
--
-- AUTORIA: created_by vem de resolve_user_for_account, como no pipeline. Sem JWT, o ator em
-- audit_log fica como servico.
--
-- Reexecucao = 0 linhas: a conta nasce uma vez (UNIQUE gmail_message_id) e o e-mail so muda de
-- 'ignorado'. Depois de aplicada, a conta pode ser baixada no app: as sondas de situacao valem so
-- quando esta execucao a criou.
-- =============================================================

BEGIN;

-- Baseline ANTES das escritas: a sonda nao pode reavaliar o predicado que elas alteram.
CREATE TEMP TABLE _m149_antes ON COMMIT DROP AS
SELECT e.id AS email_id, e.message_id, e.status AS email_status, e.sender_email, e.subject,
       (SELECT count(*) FROM public.financial_account_control f
        WHERE  f.gmail_message_id = e.message_id) AS contas_do_email,
       (SELECT count(*) FROM public.financial_account_control f
        WHERE  f.sk_supplier = 1188 AND f.amount = 450.00
          AND  f.due_date IN (DATE '2026-08-26', DATE '2026-11-05')
          AND  f.gmail_message_id <> e.message_id) AS contas_iguais_de_outro_email
FROM   public.email_control e
WHERE  e.id = 1720;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Conta
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.financial_account_control
       (gmail_message_id, source_file, document_type, extraction_source, invoice_number,
        issue_date, due_date, amount, amount_charged, currency, payment_method,
        discount, other_deductions, fine_interest, other_additions,
        processing_notes, additional_info, extracted_at, email_body_excerpt, sender_email, subject,
        status_id, sk_supplier, cost_center_id, chart_account_id, sk_company, created_by)
SELECT e.message_id, 'rose_PAGAMENTO_Honorarios_26082026_20260826_image001.png', 'honorários',
       'email_body', 'honorários_260826',
       DATE '2026-08-26', DATE '2026-11-05', 450.00, 450.00, 'BRL', 'pix',
       0, 0, 0, 0,
       'Conta cadastrada em atraso. Data real do e-mail: 26/08/2026 18:39.',
       'Conta cadastrada em atraso. Data real do e-mail: 26/08/2026 18:39.',
       now(), e.body_full, e.sender_email, e.subject,
       1, 1188, 1, 86, 1, public.resolve_user_for_account(e.sender_email)
FROM   public.email_control e
WHERE  e.id = 1720
ON CONFLICT (gmail_message_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Anexo, com o tamanho real do objeto
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.financial_account_attachment
       (account_id, storage_key, file_name, mime_type, size_bytes, origin, uploaded_by)
SELECT f.id, o.name, o.name, o.metadata->>'mimetype', (o.metadata->>'size')::bigint, 'pipeline', f.created_by
FROM   _m149_antes b
JOIN   public.financial_account_control f ON f.gmail_message_id = b.message_id
JOIN   storage.objects o ON o.bucket_id = 'attachments'
                        AND o.name = 'rose_PAGAMENTO_Honorarios_26082026_20260826_image001.png'
ON CONFLICT (account_id, storage_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) E-mail: passa a declarar a conta que tem
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.email_control
SET    status = 'recebido',
       notes  = 'Conta extraída do corpo do e-mail'
WHERE  id = 1720
  AND  status = 'ignorado';

-- ─────────────────────────────────────────────────────────────────────────────
-- Sonda — DENTRO da transacao: qualquer divergencia desfaz a migration inteira.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_b _m149_antes%ROWTYPE;
  v_c public.financial_account_control%ROWTYPE;
  v_n INTEGER;
BEGIN
  -- P0 (anti-vacuidade): o e-mail existe e e o esperado.
  SELECT * INTO v_b FROM _m149_antes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P0: e-mail 1720 nao encontrado';
  END IF;
  IF v_b.sender_email <> 'rose@otimotex.com.br' OR v_b.subject !~* 'honor' THEN
    RAISE EXCEPTION 'P0: e-mail 1720 nao e o de honorarios (%)', v_b.subject;
  END IF;

  -- P1: a divida nao estava lancada por outro caminho, o que a tornaria duplicada.
  IF v_b.contas_iguais_de_outro_email <> 0 THEN
    RAISE EXCEPTION 'P1: % conta(s) sk 1188, R$ 450,00, mesmo vencimento ja existem', v_b.contas_iguais_de_outro_email;
  END IF;

  -- P2: uma conta so para o e-mail, no cadastro certo e com os valores do corpo.
  SELECT count(*) INTO v_n FROM public.financial_account_control WHERE gmail_message_id = v_b.message_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P2: % contas para o e-mail 1720', v_n;
  END IF;
  SELECT * INTO v_c FROM public.financial_account_control WHERE gmail_message_id = v_b.message_id;
  IF v_c.sk_supplier <> 1188 OR v_c.amount <> 450.00 OR v_c.amount_charged <> 450.00 THEN
    RAISE EXCEPTION 'P2: conta % divergente', v_c.id;
  END IF;

  -- P3: criada agora, esta em aberto, vence hoje e nao tem pagamento inventado. A observacao declara
  -- o atraso nas duas colunas que a tela exibe.
  IF v_b.contas_do_email = 0 THEN
    IF v_c.status_id NOT IN (1, 3) OR v_c.payment_date IS NOT NULL
       OR v_c.due_date <> DATE '2026-11-05' THEN
      RAISE EXCEPTION 'P3: conta nova com status_id %, venc. % e pagamento %',
        v_c.status_id, v_c.due_date, v_c.payment_date;
    END IF;
    IF v_c.processing_notes !~ 'cadastrada em atraso.*26/08/2026'
       OR v_c.additional_info IS DISTINCT FROM v_c.processing_notes THEN
      RAISE EXCEPTION 'P3: observacao divergente';
    END IF;
    -- P3b: e a primeira na ordem padrao de /consulta (created_at desc, id desc).
    SELECT count(*) INTO v_n FROM public.financial_account_control f
    WHERE  f.due_date >= date_trunc('month', CURRENT_DATE)
      AND  (f.created_at, f.id) > (v_c.created_at, v_c.id);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'P3b: % conta(s) acima dela na ordem padrao', v_n;
    END IF;
  END IF;

  -- P4: o anexo vinculado tem o tamanho real do objeto.
  SELECT count(*) INTO v_n
  FROM   public.financial_account_attachment a
  JOIN   storage.objects o ON o.bucket_id = 'attachments' AND o.name = a.storage_key
  WHERE  a.account_id = v_c.id AND a.deleted_at IS NULL
    AND  a.size_bytes = (o.metadata->>'size')::bigint;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P4: % de 1 anexo vinculado', v_n;
  END IF;

  -- P5: o e-mail declara a conta.
  SELECT count(*) INTO v_n FROM public.email_control WHERE id = 1720 AND status = 'recebido';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'P5: e-mail 1720 fora de recebido';
  END IF;
END $$;

COMMIT;
