-- =============================================================
-- 052_supplier_default_classification.sql
-- Classificação contábil PADRÃO do fornecedor: adiciona `cost_center_id` e
-- `chart_account_id` (SMALLINT NOT NULL DEFAULT 0, sentinela 0 = "não informado")
-- em `supplier`, no mesmo padrão de `financial_account_control` (047/048), e faz
-- o MERGE/backfill a partir das contas existentes.
--
-- Objetivo: cada fornecedor passa a carregar a classificação que costuma usar,
-- para pré-preencher o lançamento de contas futuras.
--
-- Regra do merge: grava o par (cost_center_id, chart_account_id) NÃO-ZERO das
-- contas do fornecedor em `financial_account_control`. Diagnóstico em 2026-06-25:
-- 24 fornecedores têm classificação e NENHUM tem par conflitante (cada um usa um
-- único par), então MAX por coluna reconstrói esse par; fornecedores sem
-- classificação permanecem em 0.
--
-- Projeto: pagamentos | Data: 2026-06-25
-- =============================================================

BEGIN;

-- 1. Colunas (sentinela 0 = não informado), espelhando o tipo das PKs referenciadas.
ALTER TABLE supplier
  ADD COLUMN IF NOT EXISTS cost_center_id   SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chart_account_id SMALLINT NOT NULL DEFAULT 0;

-- 2. FKs para os cadastros (id 0 existe nos dois → DEFAULT 0 é válido).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.supplier'::regclass AND conname = 'fk_supplier_cost_center'
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT fk_supplier_cost_center
      FOREIGN KEY (cost_center_id) REFERENCES financial_cost_center(cost_center_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.supplier'::regclass AND conname = 'fk_supplier_chart_account'
  ) THEN
    ALTER TABLE supplier
      ADD CONSTRAINT fk_supplier_chart_account
      FOREIGN KEY (chart_account_id) REFERENCES financial_chart_of_account(chart_account_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_supplier_cost_center_id   ON supplier (cost_center_id);
CREATE INDEX IF NOT EXISTS idx_supplier_chart_account_id ON supplier (chart_account_id);

-- 3. Merge/backfill a partir de financial_account_control (par não-zero por fornecedor).
WITH cls AS (
  SELECT sk_supplier,
         MAX(cost_center_id)   AS cost_center_id,
         MAX(chart_account_id) AS chart_account_id
    FROM financial_account_control
   WHERE cost_center_id <> 0 OR chart_account_id <> 0
   GROUP BY sk_supplier
)
UPDATE supplier s
   SET cost_center_id   = cls.cost_center_id,
       chart_account_id = cls.chart_account_id
  FROM cls
 WHERE s.sk_supplier = cls.sk_supplier;

COMMIT;
