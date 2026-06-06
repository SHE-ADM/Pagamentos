-- =============================================================
-- 012_create_email_processing_errors.sql
-- Log de emails/documentos que falharam no processamento.
-- Registra data+hora, dados do email, arquivo e motivo da falha.
-- Projeto: pagamentos | Data: 2026-06-06
--
-- Tipos de erro (error_type):
--   sem_valor        — amount ausente ou zero no documento extraido
--   sem_fornecedor   — cnpj, cpf e nome do fornecedor ausentes
--   extracao_falhou  — extract_pdf.py nao gerou CSV para o PDF
--   db_erro          — falha ao gravar em financial_emails (HTTP error)
--   processamento_erro — excecao inesperada no processamento do email
-- =============================================================

CREATE TABLE email_processing_errors (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  logged_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  gmail_message_id TEXT,
  sender_name      TEXT,
  sender_email     TEXT,
  subject          TEXT,
  received_at      TIMESTAMPTZ,
  source_file      TEXT,
  error_type       TEXT         NOT NULL,
  error_message    TEXT,
  raw_payload      JSONB
);

CREATE INDEX idx_epe_message_id ON email_processing_errors (gmail_message_id);
CREATE INDEX idx_epe_error_type ON email_processing_errors (error_type);
CREATE INDEX idx_epe_logged_at  ON email_processing_errors (logged_at DESC);

ALTER TABLE email_processing_errors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
ON email_processing_errors FOR ALL
TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read"
ON email_processing_errors FOR SELECT
TO authenticated USING (true);
