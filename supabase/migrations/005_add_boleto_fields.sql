-- =============================================================
-- 005_add_boleto_fields.sql
-- Campos especificos do boleto bancario em financial_emails
-- Projeto: pagamentos | Data: 2026-06-05
--
-- Mapeamento dos rotulos do boleto -> colunas:
--   Beneficiario            -> supplier_name      (ja existia)
--   CPF/CNPJ do Beneficiario-> supplier_cnpj      (ja existia)
--   Data do Documento       -> issue_date         (ja existia)
--   N Documento             -> invoice_number     (ja existia)
--   Vencimento              -> due_date           (ja existia)
--   Valor do Documento      -> amount             (ja existia)
--   Linha digitavel         -> barcode            (ja existia)
--   Instrucoes/observacoes  -> description        (ja existia)
--   Nosso Numero            -> nosso_numero       (NOVO)
--   (-) Desconto/Abatimentos-> discount           (NOVO)
--   (-) Outras deducoes     -> other_deductions   (NOVO)
--   (+) Mora/Multa          -> fine_interest      (NOVO)
--   (+) Outros acrescimos   -> other_additions    (NOVO)
--   (=) Valor cobrado       -> amount_charged     (NOVO)
--
-- Regra: campos de valor em branco no boleto sao gravados como 0
-- (NOT NULL DEFAULT 0). Todos monetarios em NUMERIC(15,2).
-- =============================================================

ALTER TABLE financial_emails
  ADD COLUMN IF NOT EXISTS nosso_numero     TEXT,
  ADD COLUMN IF NOT EXISTS discount         NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_deductions NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fine_interest    NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_additions  NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_charged   NUMERIC(15,2) NOT NULL DEFAULT 0;

-- Indice por nosso_numero (consulta/conciliacao bancaria futura)
CREATE INDEX IF NOT EXISTS idx_fe_nosso_numero ON financial_emails (nosso_numero);
