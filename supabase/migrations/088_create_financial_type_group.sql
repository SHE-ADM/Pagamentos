-- 088_create_financial_type_group.sql
-- Catálogo de NATUREZA contábil (Receitas/Despesas/Ativo/Passivo) — normaliza a
-- classificação dos grupos do plano de contas (fonte de verdade nova que substitui o
-- legado group_type CHAR(1)). Espelha o padrão de catálogo do user_group (063).
-- APLICADA DIRETO VIA SUPABASE MCP (histórico). Idempotente — não reaplicar no SQL Editor.

CREATE TABLE IF NOT EXISTS public.financial_type_group (
  type_group_id           SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- 0 = "Não informado"
  type_group_description  VARCHAR(60)  NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financial_type_group_description
  ON public.financial_type_group (type_group_description);

CREATE OR REPLACE TRIGGER trg_financial_type_group_updated_at
  BEFORE UPDATE ON public.financial_type_group
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- RLS: leitura TO authenticated, escrita TO service_role (padrão do projeto).
ALTER TABLE public.financial_type_group ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_select_financial_type_group ON public.financial_type_group;
CREATE POLICY authenticated_select_financial_type_group
  ON public.financial_type_group FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS service_role_all_financial_type_group ON public.financial_type_group;
CREATE POLICY service_role_all_financial_type_group
  ON public.financial_type_group FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Higiene dos grants default do Supabase (mantém só leitura p/ authenticated).
REVOKE INSERT, UPDATE, DELETE ON public.financial_type_group FROM authenticated, anon;

-- Seed: sentinela id 0 + os 4 tipos. OVERRIDING SYSTEM VALUE por ser IDENTITY ALWAYS.
INSERT INTO public.financial_type_group (type_group_id, type_group_description)
OVERRIDING SYSTEM VALUE VALUES
  (0, 'Não informado'),
  (1, 'Receitas'),
  (2, 'Despesas'),
  (3, 'Ativo'),
  (4, 'Passivo')
ON CONFLICT (type_group_id) DO NOTHING;

-- Alinha a sequence de IDENTITY para inserts futuros não colidirem com os ids semeados.
SELECT setval(
  pg_get_serial_sequence('public.financial_type_group', 'type_group_id'),
  GREATEST((SELECT COALESCE(MAX(type_group_id), 0) FROM public.financial_type_group), 1)
);
