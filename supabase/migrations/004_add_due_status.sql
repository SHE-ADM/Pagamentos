-- =============================================================
-- 004_add_due_status.sql
-- Adiciona o status de vencimento (due_status) em financial_emails
-- Projeto: pagamentos | Data: 2026-06-05
--
-- Regra de negocio (conferida com o responsavel):
--   due_date >= data de extracao  ->  'A Vencer' (ainda no prazo)
--   due_date <  data de extracao  ->  'Vencido'  (prazo ja passou)
--   due_date IS NULL              ->  NULL       (sem vencimento extraido)
--
-- A "data de extracao" e a porcao DATE de extracted_at, convertida para
-- o fuso America/Sao_Paulo. Quando extracted_at for nulo, usa-se now().
--
-- Por que TRIGGER e nao GENERATED COLUMN: o cast de timestamptz para date
-- depende do fuso (STABLE, nao IMMUTABLE), o que o Postgres recusa em
-- coluna gerada STORED. O trigger calcula de forma deterministica e
-- persiste o valor independentemente de quem faz o INSERT (pipeline
-- Python, n8n ou insercao manual).
-- =============================================================

-- 1. Coluna persistida com dominio restrito aos dois valores de negocio
ALTER TABLE financial_emails
  ADD COLUMN IF NOT EXISTS due_status TEXT
    CHECK (due_status IN ('A Vencer', 'Vencido'));

-- 2. Funcao que deriva o status comparando vencimento x data de extracao
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
    NEW.due_status := 'A Vencer';
  ELSE
    NEW.due_status := 'Vencido';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Trigger: recalcula due_status a cada INSERT/UPDATE da linha
DROP TRIGGER IF EXISTS trg_fe_due_status ON financial_emails;
CREATE TRIGGER trg_fe_due_status
  BEFORE INSERT OR UPDATE ON financial_emails
  FOR EACH ROW EXECUTE FUNCTION fn_set_due_status();

-- 4. Indice para filtrar/agrupar por situacao de vencimento
CREATE INDEX IF NOT EXISTS idx_fe_due_status ON financial_emails (due_status);

-- 5. Backfill: preenche linhas ja existentes (idempotente).
--    O UPDATE dispara o trigger acima, que faz o calculo.
UPDATE financial_emails
   SET due_status = due_status
 WHERE due_date IS NOT NULL;
