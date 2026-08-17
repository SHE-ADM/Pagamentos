-- 130_backfill_email_status_conta_do_corpo.sql
--
-- Correção de dado (sem DDL): e-mails em 'ignorado' que NA VERDADE geraram conta a pagar
-- pelo CORPO. Contrapartida no banco da correção de `status_for_result` (read_emails.py),
-- em que `body_created` subiu para o 2º lugar da precedência.
--
-- CAUSA (2026-08-17, e-mail 1517 <000601dd2e4a$9cae5030$d60af090$@lebianco.com.br>): o
-- anexo era uma NF pura, pulada por SKIP_ACCOUNT_TYPES → `nonpayable_only = true`. Como
-- `nonpayable` era avaliado ANTES de `body_created`, o status saiu 'ignorado' — o card de
-- /emails que significa "não-financeiro, nada a fazer" — enquanto a conta 1059
-- (R$ 8.250,00) estava gravada em financial_account_control. Medido: 13 e-mails,
-- ~R$ 80 mil escondidos atrás daquele card.
--
-- ESCOPO — só o e-mail cujas contas vieram TODAS do corpo (`extraction_source =
-- 'email_body'`). Deliberadamente de FORA:
--   * e-mail 1292 ("Control iD - NFS-e 1440541"): conta criada por reprocessamento manual
--     (`pdf_text`), causa distinta desta — tocá-lo aqui misturaria dois problemas;
--   * os 13 e-mails hoje em 'extraído' cuja única conta veio do corpo (o novo código os
--     classificaria como 'recebido'): imprecisos, mas NÃO escondem conta — não é correção
--     de bug, é decisão de produto sobre dado histórico. Ficam para pedido explícito.
--
-- 🔴 O CONJUNTO É CONGELADO POR ID numa TEMP TABLE antes do UPDATE. O predicado inclui
-- `status = 'ignorado'`, que o próprio UPDATE altera: reavaliá-lo depois devolveria zero
-- linhas e as asserções passariam sem provar nada.
--
-- 🔴 O casamento do sufixo de múltiplos pagáveis usa `starts_with`, NUNCA
-- `LIKE message_id || '#%'`: Message-ID contém `_` com frequência, que é CURINGA no LIKE —
-- um e-mail casaria a conta de outro e o backfill mudaria o status errado, em silêncio.
--
-- IDEMPOTENTE: reexecução encontra 0 alvos (nenhum sobrou em 'ignorado') e sai limpa.
-- Não há trigger de auditoria em email_control, então o UPDATE não deixa outro rastro.

DO $$
DECLARE
  v_alvos                  int;
  v_atualizados            int;
  v_ignorados_antes        int;
  v_ignorados_depois       int;
  v_outras_origens_antes   int;
  v_outras_origens_depois  int;
  v_restantes              int;
BEGIN
  -- Conjunto congelado: e-mails 'ignorado' com ao menos uma conta do CORPO e nenhuma
  -- conta de outra origem.
  CREATE TEMP TABLE _alvo_130 ON COMMIT DROP AS
  SELECT e.id
    FROM public.email_control e
   WHERE e.status = 'ignorado'
     AND EXISTS (
           SELECT 1 FROM public.financial_account_control f
            WHERE (f.gmail_message_id = e.message_id
                   OR starts_with(f.gmail_message_id, e.message_id || '#'))
              AND f.extraction_source = 'email_body')
     AND NOT EXISTS (
           SELECT 1 FROM public.financial_account_control f
            WHERE (f.gmail_message_id = e.message_id
                   OR starts_with(f.gmail_message_id, e.message_id || '#'))
              AND f.extraction_source IS DISTINCT FROM 'email_body');

  SELECT count(*) INTO v_alvos FROM _alvo_130;

  SELECT count(*) INTO v_ignorados_antes
    FROM public.email_control WHERE status = 'ignorado';

  -- Controle negativo: e-mails com conta de origem NÃO-corpo. Nenhum pode ser tocado.
  SELECT count(*) INTO v_outras_origens_antes
    FROM public.email_control e
   WHERE EXISTS (SELECT 1 FROM public.financial_account_control f
                  WHERE (f.gmail_message_id = e.message_id
                         OR starts_with(f.gmail_message_id, e.message_id || '#'))
                    AND f.extraction_source IS DISTINCT FROM 'email_body');

  UPDATE public.email_control
     SET status = 'recebido'
   WHERE id IN (SELECT id FROM _alvo_130);
  GET DIAGNOSTICS v_atualizados = ROW_COUNT;

  -- P1: o UPDATE alcançou exatamente o conjunto congelado.
  IF v_atualizados <> v_alvos THEN
    RAISE EXCEPTION 'P1: atualizados % != alvos %', v_atualizados, v_alvos;
  END IF;

  -- P2: nenhum e-mail fora do conjunto mudou de status (o total de 'ignorado' caiu
  -- exatamente pelo número de linhas atualizadas — não mais, não menos).
  SELECT count(*) INTO v_ignorados_depois
    FROM public.email_control WHERE status = 'ignorado';
  IF v_ignorados_depois <> v_ignorados_antes - v_atualizados THEN
    RAISE EXCEPTION 'P2: ignorados %->% com % atualizados (efeito colateral)',
      v_ignorados_antes, v_ignorados_depois, v_atualizados;
  END IF;

  -- P3: o controle negativo é estável — conta de PDF/imagem não entrou no backfill.
  SELECT count(*) INTO v_outras_origens_depois
    FROM public.email_control e
   WHERE EXISTS (SELECT 1 FROM public.financial_account_control f
                  WHERE (f.gmail_message_id = e.message_id
                         OR starts_with(f.gmail_message_id, e.message_id || '#'))
                    AND f.extraction_source IS DISTINCT FROM 'email_body');
  IF v_outras_origens_depois <> v_outras_origens_antes THEN
    RAISE EXCEPTION 'P3: população de outras origens mudou de % para %',
      v_outras_origens_antes, v_outras_origens_depois;
  END IF;

  -- P4: o invariante que motivou a migration vale agora — nenhum e-mail em 'ignorado'
  -- esconde conta gravada pelo corpo. Reavalia o predicado do zero, de propósito: é a
  -- asserção que a TEMP TABLE congelada NÃO poderia dar.
  SELECT count(*) INTO v_restantes
    FROM public.email_control e
   WHERE e.status = 'ignorado'
     AND EXISTS (SELECT 1 FROM public.financial_account_control f
                  WHERE (f.gmail_message_id = e.message_id
                         OR starts_with(f.gmail_message_id, e.message_id || '#'))
                    AND f.extraction_source = 'email_body');
  IF v_restantes <> 0 THEN
    RAISE EXCEPTION 'P4: % e-mail(s) seguem ignorados com conta do corpo', v_restantes;
  END IF;

  RAISE NOTICE 'Migration 130: % e-mail(s) reclassificados ignorado -> recebido', v_atualizados;
END $$;
