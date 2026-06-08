-- =============================================================
-- 015_authenticated_read_policies.sql
-- Troca as policies de leitura de financial_emails e email_control
-- de `TO anon` para `TO authenticated`, agora que o app implementa
-- Supabase Auth (login via e-mail/senha).
-- Projeto: pagamentos | Data: 2026-06-08
--
-- Contexto: a migration 003 liberava SELECT para a chave anon porque
-- o frontend ainda nao tinha sessao de usuario (fase 1, acesso aberto).
-- Agora o frontend autentica via supabase.auth.signInWithPassword() e
-- envia o token de sessao do usuario nas requisicoes REST — entao as
-- policies passam a exigir o papel `authenticated`, no mesmo padrao ja
-- usado por email_processing_errors (migration 012, policy "authenticated read").
-- =============================================================

DROP POLICY IF EXISTS anon_select_financial_emails ON financial_emails;
DROP POLICY IF EXISTS anon_select_email_control     ON email_control;

CREATE POLICY authenticated_select_financial_emails
  ON financial_emails
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY authenticated_select_email_control
  ON email_control
  FOR SELECT
  TO authenticated
  USING (true);
