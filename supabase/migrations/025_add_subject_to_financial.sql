-- =============================================================
-- 025_add_subject_to_financial.sql
-- Adiciona o assunto do e-mail (email_control.subject) à conta, para exibição
-- no card de detalhes e busca na tela /consulta. Populado na extração (corpo e
-- PDF) a partir de email_rec.subject; backfill via gmail_message_id.
-- Projeto: pagamentos | Data: 2026-06-15
-- =============================================================

ALTER TABLE financial_account_control
  ADD COLUMN IF NOT EXISTS subject TEXT;

-- Backfill: copia o assunto do email_control casando por message_id
-- (gmail_message_id pode ter sufixo '#N' para múltiplos PDFs do mesmo e-mail).
UPDATE financial_account_control f
SET    subject = ec.subject
FROM   email_control ec
WHERE  ec.message_id = split_part(f.gmail_message_id, '#', 1)
  AND  f.subject IS NULL
  AND  ec.subject IS NOT NULL;

-- Backfill companheiro de sender_email: a coluna existe desde a migration 023,
-- mas registros anteriores ficaram NULL. Necessário para exibir/pesquisar o
-- remetente em /consulta também no histórico.
UPDATE financial_account_control f
SET    sender_email = ec.sender_email
FROM   email_control ec
WHERE  ec.message_id = split_part(f.gmail_message_id, '#', 1)
  AND  f.sender_email IS NULL
  AND  ec.sender_email IS NOT NULL;
