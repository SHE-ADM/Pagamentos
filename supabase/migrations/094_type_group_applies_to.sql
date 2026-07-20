-- 094_type_group_applies_to.sql
-- Discriminador de ESCOPO em financial_type_group — resolve a poluição dos dois lookups
-- (achado da revisão de 2026-07-20): o catálogo passou a hospedar DUAS taxonomias sem
-- distinção — a NATUREZA do grupo (Receitas/Despesas/Ativo/Passivo, ids 1-4) e o TIPO do
-- subgrupo (Despesas Fixas/Variáveis, ids 5-6, migrations 092/093). Como os selects "Natureza"
-- (Grupo) e "Tipo" (Subgrupo) liam o MESMO lookup, cada um oferecia as opções do outro
-- (ex.: subgrupo com Tipo="Ativo", grupo com Natureza="Despesas Fixas") — sem sentido e
-- sem guarda. `applies_to` escopa cada linha, filtrando o lookup por cadastro (Finding 1) e
-- servindo de base à validação de aplicação que impede atribuição cross-taxonomia (Finding 2).
--
-- Valores: 'group' (só no CRUD de Grupos), 'subgroup' (só no de Sub grupos), 'both'
-- (aparece nos dois — o sentinela id 0 "Não informado", que permite desclassificar).
-- DEFAULT 'both' é permissivo por segurança: linha nova (o catálogo é editado direto no
-- Supabase, sem CRUD) aparece nos dois selects até ser classificada explicitamente.
--
-- Sem REVOKE: coluna nova herda o grant de SELECT de `authenticated` (a tabela não tem
-- grant de escrita para o papel; escrita só via service_role). Idempotente.

ALTER TABLE public.financial_type_group
  ADD COLUMN IF NOT EXISTS applies_to VARCHAR(10) NOT NULL DEFAULT 'both';

ALTER TABLE public.financial_type_group
  DROP CONSTRAINT IF EXISTS chk_type_group_applies_to;
ALTER TABLE public.financial_type_group
  ADD CONSTRAINT chk_type_group_applies_to
  CHECK (applies_to IN ('group', 'subgroup', 'both'));

-- Classificação das linhas atuais (id 0 permanece 'both' pelo DEFAULT).
UPDATE public.financial_type_group SET applies_to = 'group'
  WHERE type_group_id IN (1, 2, 3, 4) AND applies_to <> 'group';
UPDATE public.financial_type_group SET applies_to = 'subgroup'
  WHERE type_group_id IN (5, 6) AND applies_to <> 'subgroup';
