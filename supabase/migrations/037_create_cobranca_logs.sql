-- 037_create_cobranca_logs.sql
--
-- Cria as tabelas de log do pipeline de cobrança automática de títulos vencidos
-- (skill cobranca-vencidos). Duas tabelas com responsabilidades distintas:
--
--   cobranca_envios_log  → email enviado com sucesso (UNIQUE em document_id)
--   cobranca_erros_log   → falha de qualquer natureza (sem UNIQUE — reprocessável)
--
-- Deduplicação: o script Python consulta cobranca_envios_log antes de enviar.
-- Títulos em cobranca_erros_log NÃO bloqueiam reenvio — podem ser retentados.

-- =============================================================================
-- 1. cobranca_envios_log
-- =============================================================================

CREATE TABLE IF NOT EXISTS cobranca_envios_log (
    id              BIGSERIAL       PRIMARY KEY,
    document_id     TEXT            NOT NULL UNIQUE,   -- TITULO no Firebird
    customer_name   TEXT            NOT NULL,
    primary_email   TEXT            NOT NULL,           -- CD_EMAIL (To)
    cc_email        TEXT,                               -- CV_EMAIL (Cc), pode ser nulo
    due_date        DATE            NOT NULL,
    bill_amount     NUMERIC(15, 2)  NOT NULL,
    email_subject   TEXT            NOT NULL,
    sent_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_envios_log_document_id ON cobranca_envios_log (document_id);
CREATE INDEX IF NOT EXISTS idx_envios_log_sent_at     ON cobranca_envios_log (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_envios_log_due_date    ON cobranca_envios_log (due_date DESC);
CREATE INDEX IF NOT EXISTS idx_envios_log_customer    ON cobranca_envios_log (customer_name);

ALTER TABLE cobranca_envios_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access — cobranca_envios_log"
    ON cobranca_envios_log FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read — cobranca_envios_log"
    ON cobranca_envios_log FOR SELECT TO authenticated
    USING (true);

COMMENT ON TABLE  cobranca_envios_log                IS 'Log de emails de cobrança enviados com sucesso. UNIQUE em document_id: cada título processado uma única vez.';
COMMENT ON COLUMN cobranca_envios_log.document_id    IS 'TITULO no Firebird — chave de deduplicação';
COMMENT ON COLUMN cobranca_envios_log.primary_email  IS 'CD_EMAIL — destinatário principal (To)';
COMMENT ON COLUMN cobranca_envios_log.cc_email       IS 'CV_EMAIL — cópia (Cc), pode ser nulo';
COMMENT ON COLUMN cobranca_envios_log.sent_at        IS 'Timestamp exato do envio SMTP confirmado';

-- =============================================================================
-- 2. cobranca_erros_log
-- =============================================================================

CREATE TABLE IF NOT EXISTS cobranca_erros_log (
    id              BIGSERIAL       PRIMARY KEY,
    document_id     TEXT,                               -- nulo se erro ocorreu antes da leitura
    customer_name   TEXT,
    primary_email   TEXT,                               -- nulo quando error_type = email_ausente
    cc_email        TEXT,
    due_date        DATE,
    bill_amount     NUMERIC(15, 2),
    email_subject   TEXT,
    error_type      TEXT            NOT NULL,
    -- Valores esperados:
    --   email_ausente    → PRIMARY_EMAIL nulo ou vazio no Firebird
    --   email_invalido   → endereço com formato inválido
    --   smtp_falha       → exceção no envio SMTP
    --   supabase_falha   → erro ao gravar log de sucesso
    --   firebird_falha   → erro na consulta ao Firebird
    --   erro_inesperado  → exceção não categorizada
    error_message   TEXT            NOT NULL,
    error_detail    TEXT,                               -- stack trace ou contexto adicional
    occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erros_log_document_id ON cobranca_erros_log (document_id);
CREATE INDEX IF NOT EXISTS idx_erros_log_error_type  ON cobranca_erros_log (error_type);
CREATE INDEX IF NOT EXISTS idx_erros_log_occurred_at ON cobranca_erros_log (occurred_at DESC);

ALTER TABLE cobranca_erros_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access — cobranca_erros_log"
    ON cobranca_erros_log FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "authenticated read — cobranca_erros_log"
    ON cobranca_erros_log FOR SELECT TO authenticated
    USING (true);

COMMENT ON TABLE  cobranca_erros_log               IS 'Log de falhas do pipeline de cobrança. Sem UNIQUE: mesmo documento pode falhar em execuções distintas.';
COMMENT ON COLUMN cobranca_erros_log.document_id   IS 'TITULO no Firebird — nulo se erro ocorreu antes da leitura do registro';
COMMENT ON COLUMN cobranca_erros_log.primary_email IS 'Nulo quando error_type = email_ausente';
COMMENT ON COLUMN cobranca_erros_log.error_type    IS 'Categoria: email_ausente | email_invalido | smtp_falha | supabase_falha | firebird_falha | erro_inesperado';
COMMENT ON COLUMN cobranca_erros_log.error_message IS 'Mensagem de erro técnica completa';
COMMENT ON COLUMN cobranca_erros_log.error_detail  IS 'Stack trace ou contexto adicional para diagnóstico';
