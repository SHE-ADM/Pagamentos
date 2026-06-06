-- =============================================================
-- 003_rls_read_policies.sql
-- Habilita RLS em email_control e cria policies de leitura (anon)
-- Projeto: pagamentos | Data: 2026-06-05
--
-- Contexto: o frontend (app/) usa a chave anon e na fase 1 e
-- somente-leitura (paginas E-mails e Consulta). A escrita e feita
-- pelos scripts Python com a service_role, que ignora RLS.
--
-- ATENCAO: estas policies liberam SELECT para qualquer portador da
-- chave anon (USING true). Aceitavel para ferramenta interna em setup.
-- Ao implementar Supabase Auth (padrao Sheild), trocar `TO anon` por
-- `TO authenticated` e restringir o USING conforme a regra de acesso.
-- =============================================================

-- email_control ainda nao tinha RLS habilitado (financial_emails ja tinha)
ALTER TABLE email_control ENABLE ROW LEVEL SECURITY;

-- Leitura de financial_emails pela chave anon
CREATE POLICY anon_select_financial_emails
  ON financial_emails
  FOR SELECT
  TO anon
  USING (true);

-- Leitura de email_control pela chave anon
CREATE POLICY anon_select_email_control
  ON email_control
  FOR SELECT
  TO anon
  USING (true);
