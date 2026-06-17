-- =============================================================
-- 030_email_control_reviewed_at.sql
-- Marca de "revisado" para e-mails com falha em /emails.
-- Projeto: pagamentos | Data: 2026-06-17
--
-- Contexto: em /emails o usuário precisa saber, visualmente, quais e-mails com
-- status 'falha' ele já revisou. Ao abrir o card de detalhes de um e-mail com
-- falha, o frontend marca reviewed_at = now() (compartilhado entre usuários).
--
-- Segurança: o frontend escreve via REST com o papel `authenticated`. Para que
-- ele NÃO possa alterar outras colunas de email_control, o privilégio de UPDATE
-- é concedido APENAS à coluna reviewed_at (column-level grant), além da policy
-- de RLS. service_role (pipeline Python) não é afetado.
-- =============================================================

ALTER TABLE email_control ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- authenticated só pode escrever a coluna reviewed_at (revoga UPDATE de tabela,
-- se houver por grant default do Supabase, e concede só a coluna).
REVOKE UPDATE ON email_control FROM authenticated;
GRANT  UPDATE (reviewed_at) ON email_control TO authenticated;

-- RLS: habilita UPDATE para authenticated (a restrição de coluna acima é o que
-- limita o que pode ser alterado). Leitura/escrita do pipeline seguem inalteradas.
DROP POLICY IF EXISTS authenticated_update_email_control ON email_control;
CREATE POLICY authenticated_update_email_control
  ON email_control FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
