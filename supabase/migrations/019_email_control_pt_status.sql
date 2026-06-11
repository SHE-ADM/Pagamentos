-- =============================================================
-- 019_email_control_pt_status.sql
-- Traduz o dominio de email_control.status para pt-BR e recria a policy
-- de leitura ausente.
-- Projeto: pagamentos | Data: 2026-06-11
--
-- Mapa de valores: received->recebido, downloaded->baixado,
-- extracted->extraido (com acento: 'extraído'), error->falha, ignored->ignorado.
-- =============================================================

-- 1. Atualiza o CHECK de status
ALTER TABLE email_control
  DROP CONSTRAINT IF EXISTS email_control_status_check;

ALTER TABLE email_control
  ADD CONSTRAINT email_control_status_check
  CHECK (status IN ('recebido','baixado','extraído','falha','ignorado'));

-- 2. Novo default em pt-BR
ALTER TABLE email_control
  ALTER COLUMN status SET DEFAULT 'recebido';

-- 3. Recria a policy de leitura (perdida na reestruturacao da tabela).
--    Mesmo padrao da migration 015 (TO authenticated).
ALTER TABLE email_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_select_email_control ON email_control;
CREATE POLICY authenticated_select_email_control
  ON email_control
  FOR SELECT
  TO authenticated
  USING (true);
