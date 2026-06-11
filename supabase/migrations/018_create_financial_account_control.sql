-- =============================================================
-- 018_create_financial_account_control.sql
-- Cria a tabela financial_account_control — controle central de contas a pagar.
-- Projeto: pagamentos | Data: 2026-06-11
--
-- Contexto: substitui financial_emails (dropada em 020). Mesma estrutura de
-- colunas, mas com dois papeis: (1) destino do pipeline de extracao de e-mail
-- e (2) tabela principal para CRUD manual, baixas, consolidacoes, dashboards
-- e relatorios. Por isso os dominios de status/payment_method/extraction_source
-- foram traduzidos para pt-BR e ampliados para cobrir o ciclo de vida completo
-- do pagamento (vencido, pago, baixado, protestado, cancelado, etc.).
--
-- Reaproveita as funcoes ja criadas pelas migrations anteriores:
--   fn_set_updated_at (001), resolve_company_id/trg_fe_resolve_company (007/008),
--   resolve_supplier_id/trg_fe_resolve_supplier (009/010/013).
-- A funcao fn_set_due_status (004) e recriada aqui em minusculo para casar com
-- o novo CHECK de due_status.
-- =============================================================

CREATE TABLE IF NOT EXISTS financial_account_control (
  -- Chave primaria
  id                  BIGSERIAL PRIMARY KEY,

  -- Identificacao e deduplicacao
  gmail_message_id    TEXT        UNIQUE,
  source_file         TEXT,

  -- Classificacao do documento (lower() — case-insensitive, espelha migration 014/017)
  document_type       TEXT        CHECK (lower(document_type) IN (
                        'boleto','cte','nfe','nfse','seguro','fatura','recibo',
                        'contrato','outro','darf','gps','das','gru','dae','gnre',
                        'ipva','iptu','dam / duam','iss','itbi','gare','tributo','pix'
                      )),
  extraction_source   TEXT        CHECK (extraction_source IN (
                        'email_body','pdf_text','pdf_vision','falha'
                      )),

  -- Dados do fornecedor (credor)
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
                        'boleto','pix','ted','cartão','depósito','duplicata',
                        'bancário','carteira','vale','crédito','débito',
                        'dinheiro','transferência','cheque','outro'
                      )),
  barcode             TEXT,
  description         TEXT,

  -- Status de pagamento (ciclo de vida; default = pendente)
  status              TEXT        NOT NULL DEFAULT 'pendente'
                        CHECK (status IN (
                          'pendente','vencido','a vencer','prorrogado','baixado',
                          'protestado','cartório','pago','pago protesto',
                          'pago cartório','não pago','cancelado','falha'
                        )),

  -- Auditoria
  processing_notes    TEXT,
  extracted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Situacao de vencimento (calculada pela trigger; mesmo dominio de status)
  due_status          TEXT        CHECK (due_status IN (
                          'pendente','vencido','a vencer','prorrogado','baixado',
                          'protestado','cartório','pago','pago protesto',
                          'pago cartório','não pago','cancelado','falha'
                        )),

  -- Campos especificos de boleto (NOT NULL DEFAULT 0)
  nosso_numero        TEXT,
  discount            NUMERIC(15,2) NOT NULL DEFAULT 0,
  other_deductions    NUMERIC(15,2) NOT NULL DEFAULT 0,
  fine_interest       NUMERIC(15,2) NOT NULL DEFAULT 0,
  other_additions     NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_charged      NUMERIC(15,2) NOT NULL DEFAULT 0,

  -- Pagador (sacado) — resolvido pela trigger trg_fe_company_id
  company_id          BIGINT,
  payer_cnpj          CHAR(14),
  payer_name          TEXT,

  -- Fornecedor resolvido — preenchido pela trigger trg_fe_supplier_id (BEFORE INSERT)
  supplier_id         BIGINT      NOT NULL,
  supplier_cpf        CHAR(11),

  -- Corpo do e-mail (quando extraction_source = 'email_body')
  email_body_excerpt  TEXT,

  CONSTRAINT fk_fe_supplier FOREIGN KEY (supplier_id) REFERENCES supplier(supplier_id)
);

-- Indices para consultas frequentes (espelham os da antiga financial_emails)
CREATE INDEX IF NOT EXISTS idx_fac_supplier_cnpj  ON financial_account_control (supplier_cnpj);
CREATE INDEX IF NOT EXISTS idx_fac_due_date        ON financial_account_control (due_date);
CREATE INDEX IF NOT EXISTS idx_fac_status          ON financial_account_control (status);
CREATE INDEX IF NOT EXISTS idx_fac_document_type   ON financial_account_control (document_type);
CREATE INDEX IF NOT EXISTS idx_fac_extraction_src  ON financial_account_control (extraction_source);
CREATE INDEX IF NOT EXISTS idx_fac_due_status      ON financial_account_control (due_status);
CREATE INDEX IF NOT EXISTS idx_fac_nosso_numero    ON financial_account_control (nosso_numero);
CREATE INDEX IF NOT EXISTS idx_fac_company_id      ON financial_account_control (company_id);
CREATE INDEX IF NOT EXISTS idx_fac_supplier_id     ON financial_account_control (supplier_id);

-- Funcao de due_status em pt-BR minusculo (casa com o novo CHECK).
-- Recriada aqui; a versao anterior (migration 004) gravava 'A Vencer'/'Vencido'.
CREATE OR REPLACE FUNCTION fn_set_due_status()
RETURNS TRIGGER AS $$
DECLARE
  ref_date DATE;
BEGIN
  IF NEW.due_date IS NULL THEN
    NEW.due_status := NULL;
    RETURN NEW;
  END IF;

  -- Data de referencia = dia da extracao no fuso de Sao Paulo
  ref_date := (COALESCE(NEW.extracted_at, NOW())
                 AT TIME ZONE 'America/Sao_Paulo')::date;

  IF NEW.due_date >= ref_date THEN
    NEW.due_status := 'a vencer';
  ELSE
    NEW.due_status := 'vencido';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers — reaproveitam funcoes ja existentes
DROP TRIGGER IF EXISTS trg_fe_updated_at ON financial_account_control;
CREATE TRIGGER trg_fe_updated_at
  BEFORE UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_fe_due_status ON financial_account_control;
CREATE TRIGGER trg_fe_due_status
  BEFORE INSERT OR UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION fn_set_due_status();

DROP TRIGGER IF EXISTS trg_fe_company_id ON financial_account_control;
CREATE TRIGGER trg_fe_company_id
  BEFORE INSERT OR UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION trg_fe_resolve_company();

DROP TRIGGER IF EXISTS trg_fe_supplier_id ON financial_account_control;
CREATE TRIGGER trg_fe_supplier_id
  BEFORE INSERT OR UPDATE ON financial_account_control
  FOR EACH ROW EXECUTE FUNCTION trg_fe_resolve_supplier();

-- RLS: leitura para usuarios autenticados (frontend) + acesso total ao service_role (CRUD via Next API)
ALTER TABLE financial_account_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_select_financial_account_control ON financial_account_control;
CREATE POLICY authenticated_select_financial_account_control
  ON financial_account_control
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS service_role_all_financial_account_control ON financial_account_control;
CREATE POLICY service_role_all_financial_account_control
  ON financial_account_control
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
