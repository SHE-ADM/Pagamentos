-- =============================================================
-- 002_create_email_control.sql
-- Tabela de controle de e-mails processados (deduplicação)
-- Projeto: pagamentos | Data: 2025-06-05
-- =============================================================

CREATE TABLE IF NOT EXISTS email_control (
  id                BIGSERIAL     PRIMARY KEY,

  -- Identificação única do e-mail
  message_id        TEXT          NOT NULL UNIQUE,   -- Message-ID do header MIME
  imap_uid          TEXT,                            -- UID no servidor IMAP

  -- Metadados do e-mail
  received_at       TIMESTAMPTZ,
  sender_name       TEXT,
  sender_email      TEXT,
  subject           TEXT,
  body_preview      TEXT,
  keyword_matched   TEXT,

  -- Controle de anexos
  has_attachment    BOOLEAN       DEFAULT FALSE,
  attachment_names  TEXT,                            -- nomes separados por |
  attachment_saved  BOOLEAN       DEFAULT FALSE,

  -- Controle de extração
  pdf_extracted     BOOLEAN       DEFAULT FALSE,
  extraction_csv    TEXT,                            -- caminho do CSV gerado

  -- Status do processamento
  status            TEXT          NOT NULL DEFAULT 'received'
                      CHECK (status IN (
                        'received',    -- e-mail lido, sem PDF
                        'downloaded',  -- PDF salvo em pdfs_inbox
                        'extracted',   -- extract_pdf.py executado com sucesso
                        'error',       -- falha em alguma etapa
                        'ignored'      -- filtrado mas descartado manualmente
                      )),

  -- Auditoria
  notes             TEXT,
  processed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Índices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_ec_message_id    ON email_control (message_id);
CREATE INDEX IF NOT EXISTS idx_ec_sender_email  ON email_control (sender_email);
CREATE INDEX IF NOT EXISTS idx_ec_received_at   ON email_control (received_at);
CREATE INDEX IF NOT EXISTS idx_ec_status        ON email_control (status);

-- Trigger updated_at
CREATE TRIGGER trg_ec_updated_at
  BEFORE UPDATE ON email_control
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
