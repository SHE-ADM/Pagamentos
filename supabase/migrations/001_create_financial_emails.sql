-- =============================================================
-- 001_create_financial_emails.sql
-- Criação inicial da tabela financial_emails
-- Projeto: email-pago | Data: 2025-06-05
-- =============================================================

CREATE TABLE IF NOT EXISTS financial_emails (
  -- Chave primária
  id                  BIGSERIAL PRIMARY KEY,

  -- Identificação e deduplicação
  gmail_message_id    TEXT        UNIQUE,
  source_file         TEXT,

  -- Classificação do documento
  document_type       TEXT        CHECK (document_type IN (
                        'boleto','nfe','nfse','fatura','recibo','contrato','outro'
                      )),
  extraction_source   TEXT        CHECK (extraction_source IN (
                        'email_body','pdf_text','pdf_vision','error'
                      )),

  -- Dados do fornecedor
  supplier_name       TEXT,
  supplier_cnpj       CHAR(14),

  -- Dados do documento
  invoice_number      TEXT,
  competence_date     TEXT,                         -- YYYY-MM
  issue_date          DATE,
  due_date            DATE,

  -- Dados financeiros
  amount              NUMERIC(15,2),
  currency            CHAR(3)     NOT NULL DEFAULT 'BRL',
  payment_method      TEXT        CHECK (payment_method IN (
                        'boleto','pix','ted','cartao','outro'
                      )),
  barcode             TEXT,
  description         TEXT,

  -- Controle de status
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','cancelled','error')),

  -- Auditoria
  processing_notes    TEXT,
  extracted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_fe_supplier_cnpj  ON financial_emails (supplier_cnpj);
CREATE INDEX IF NOT EXISTS idx_fe_due_date        ON financial_emails (due_date);
CREATE INDEX IF NOT EXISTS idx_fe_status          ON financial_emails (status);
CREATE INDEX IF NOT EXISTS idx_fe_document_type   ON financial_emails (document_type);
CREATE INDEX IF NOT EXISTS idx_fe_extraction_src  ON financial_emails (extraction_source);

-- Trigger: atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fe_updated_at
  BEFORE UPDATE ON financial_emails
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
