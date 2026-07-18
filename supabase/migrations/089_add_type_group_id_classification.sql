-- 089_add_type_group_id_classification.sql
-- FK type_group_id (NATUREZA → financial_type_group) em grupo E subgrupo do plano de
-- contas. Coluna SMALLINT NOT NULL DEFAULT 0 (sentinela "Não informado"), FK sem
-- ON DELETE (NO ACTION ≡ RESTRICT — bloqueia excluir um tipo em uso) + índice parcial
-- (ignora o sentinela). Espelha o padrão da 052/058.
-- APLICADA DIRETO VIA SUPABASE MCP (histórico). Idempotente — não reaplicar no SQL Editor.
-- NOTA: a coluna do SUBGRUPO existe por simetria estrutural, mas a CLASSIFICAÇÃO é feita
-- só no GRUPO (todos os subgrupos ficam em 0 — decisão de negócio).

BEGIN;

-- === financial_chart_of_account_group ===
ALTER TABLE public.financial_chart_of_account_group
  ADD COLUMN IF NOT EXISTS type_group_id SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_chart_of_account_group'::regclass
       AND conname  = 'fk_coa_group_type_group'
  ) THEN
    ALTER TABLE public.financial_chart_of_account_group
      ADD CONSTRAINT fk_coa_group_type_group
      FOREIGN KEY (type_group_id) REFERENCES public.financial_type_group(type_group_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coa_group_type_group_id
  ON public.financial_chart_of_account_group (type_group_id)
  WHERE type_group_id <> 0;

-- === financial_chart_of_account_subgroup ===
ALTER TABLE public.financial_chart_of_account_subgroup
  ADD COLUMN IF NOT EXISTS type_group_id SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.financial_chart_of_account_subgroup'::regclass
       AND conname  = 'fk_coa_subgroup_type_group'
  ) THEN
    ALTER TABLE public.financial_chart_of_account_subgroup
      ADD CONSTRAINT fk_coa_subgroup_type_group
      FOREIGN KEY (type_group_id) REFERENCES public.financial_type_group(type_group_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coa_subgroup_type_group_id
  ON public.financial_chart_of_account_subgroup (type_group_id)
  WHERE type_group_id <> 0;

COMMIT;
