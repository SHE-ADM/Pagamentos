-- =============================================================
-- 154_email_3865_duplicidade_anexo_deduplicado.sql
-- Curadoria de dados (sem DDL): corrige o status de UM e-mail, de 'ignorado' para 'duplicidade'.
--
-- Projeto: pagamentos | Data: 2026-11-24
--
-- POR QUE EXISTE: "ENVIO DE NOTA FISCAL (00021851/1)" (4R Ambiental, e-mail 3865) trazia em anexo
--   o boleto `Boleto_18454-117.pdf`, que casou por dedup a conta 2594 — criada dias antes pelo
--   encaminhamento do mesmo documento. O assunto e de NF-e pura, e `status_for_result` avaliava
--   `pure_nfe` ANTES de `duplicate`: o e-mail saiu 'ignorado' sem nota (o card de /emails que
--   significa "nao-financeiro, nada a fazer"), quando o honesto e 'duplicidade'. O reader foi
--   corrigido no call site (`process_message`: `pure_nfe`/`nonpayable` so valem quando o anexo
--   NAO respondeu por pagavel); esta migration alinha a unica linha ja gravada nesse estado.
--
-- MEDIDO ANTES (2026-11-24): entre os e-mails 'ignorado' com anexo extraido, so o 3865 tem o
--   anexo vinculado a uma conta de OUTRO e-mail sem nota que explique o status.
--
-- FORA DE PROPOSITO: nenhuma conta e tocada; a duplicata vinda do CORPO com assunto de NF-e
--   segue 'ignorado' (regra de produto, nao alterada).
--
-- Reexecucao = 0 linhas e sondas verdes: o UPDATE e condicionado ao estado antigo.
-- =============================================================

BEGIN;

-- Baseline ANTES do UPDATE: a sonda nao pode reavaliar o predicado que ele altera.
CREATE TEMP TABLE _m154_antes ON COMMIT DROP AS
SELECT id, message_id, subject, status, notes, attachment_names
FROM   public.email_control
WHERE  id = 3865;

DO $$
DECLARE
  v_b          _m154_antes%ROWTYPE;
  v_vinculos   BIGINT;
  v_alteradas  BIGINT;
  v_status     TEXT;
  v_notes      TEXT;
BEGIN
  -- P0 (anti-vacuidade): o e-mail existe e e o esperado.
  SELECT * INTO v_b FROM _m154_antes;
  IF NOT FOUND
     OR v_b.message_id <> '<E1xToZ2-FnQW0hPoEdJ-i5gp@message-id.smtpcorp.com>'
     OR v_b.subject NOT LIKE 'ENVIO DE NOTA FISCAL (00021851/1)%' THEN
    RAISE EXCEPTION 'P0: e-mail 3865 ausente ou diferente do esperado';
  END IF;
  IF v_b.status NOT IN ('ignorado', 'duplicidade') THEN
    RAISE EXCEPTION 'P0: e-mail 3865 em estado inesperado (%)', v_b.status;
  END IF;

  -- P0b (a evidencia da dedup): o anexo deste e-mail esta vinculado a conta 2594, que
  -- pertence a OUTRO e-mail. Sem isso 'duplicidade' seria uma afirmacao sem prova.
  SELECT count(*) INTO v_vinculos
  FROM   public.financial_account_attachment a
  JOIN   public.financial_account_control   f ON f.id = a.account_id
  WHERE  a.account_id = 2594
    AND  a.deleted_at IS NULL
    AND  position(a.file_name IN v_b.attachment_names) > 0
    AND  split_part(f.gmail_message_id, '#', 1) <> v_b.message_id;
  IF v_vinculos = 0 THEN
    RAISE EXCEPTION 'P0b: o anexo do e-mail 3865 nao esta vinculado a conta 2594';
  END IF;

  UPDATE public.email_control
  SET    status = 'duplicidade',
         notes  = 'Boleto do anexo já registrado na conta 2594 (casou por dedup)'
  WHERE  id = 3865
    AND  message_id = '<E1xToZ2-FnQW0hPoEdJ-i5gp@message-id.smtpcorp.com>'
    AND  status = 'ignorado';
  GET DIAGNOSTICS v_alteradas = ROW_COUNT;

  -- P1: exatamente UMA linha na 1a execucao e ZERO na reexecucao. ROW_COUNT, e nao contagem
  -- da tabela: o reader de producao insere em email_control a cada 5 min, e um total
  -- comparado contra o baseline falharia por concorrencia sem que nada estivesse errado.
  IF v_alteradas <> (CASE WHEN v_b.status = 'ignorado' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'P1: % linha(s) alterada(s), estado anterior %', v_alteradas, v_b.status;
  END IF;

  -- P2: estado final.
  SELECT status, notes INTO v_status, v_notes FROM public.email_control WHERE id = 3865;
  IF v_status <> 'duplicidade' OR v_notes IS NULL THEN
    RAISE EXCEPTION 'P2: e-mail 3865 ficou em % (notes %)', v_status, v_notes;
  END IF;
END $$;

COMMIT;
