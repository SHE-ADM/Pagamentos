-- =============================================================
-- 022_email_control_status_v2.sql
-- Nova taxonomia de status de email_control:
--   extraído  = PDF extraído (CSV gerado) — conta de PDF ou erro logado à parte
--   recebido  = sem PDF, conta criada via corpo do e-mail
--   pendente  = PDF salvo mas extração não gerou CSV (substitui 'baixado')
--   falha     = casou keyword mas sem PDF e sem conta no corpo
--   ignorado  = não-financeiro (assunto sem keyword)
-- Projeto: pagamentos | Data: 2026-06-13
--
-- Reclassifica os 224 e-mails já processados de forma determinística. Como
-- 'extraído' = "CSV gerado", quem tem 'extraído' permanece — exceto as contas
-- via corpo (sem PDF/CSV), que o código antigo marcava 'extraído' e agora são
-- 'recebido'. NÃO confundir com o 'baixado' de financial_account_control (baixa
-- de pagamento), que é outro domínio e não é tocado aqui.
-- =============================================================

-- 1. Remove o CHECK antigo para permitir os valores novos durante a reclassificação
--    (o CHECK 019 não conhece 'pendente').
ALTER TABLE email_control
  DROP CONSTRAINT IF EXISTS email_control_status_check;

-- 2. Reclassificação (a ordem importa)
UPDATE email_control SET status = 'falha'    WHERE status = 'recebido';  -- antigo 'recebido' (=nada gerado)
UPDATE email_control SET status = 'pendente' WHERE status = 'baixado';

-- 'extraído' SEM anexo = conta via corpo (não houve CSV) → recebido
UPDATE email_control SET status = 'recebido'
WHERE status = 'extraído' AND has_attachment IS NOT TRUE;

-- 'ignorado' que casou keyword (financeiro sem conta) → falha
UPDATE email_control SET status = 'falha'
WHERE status = 'ignorado' AND keyword_matched IS NOT NULL;

-- 3. Novo domínio + default
ALTER TABLE email_control
  ADD CONSTRAINT email_control_status_check
  CHECK (status IN ('extraído', 'recebido', 'pendente', 'falha', 'ignorado'));

ALTER TABLE email_control
  ALTER COLUMN status SET DEFAULT 'pendente';
