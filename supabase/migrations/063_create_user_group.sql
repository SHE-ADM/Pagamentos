-- 063_create_user_group.sql
-- Fundação para permissões por GRUPO de usuário.
--
-- Contexto: a autorização do projeto hoje é um *claim* em `app_metadata` (ex.: `role`,
-- lido de forma idêntica no back `lib/auth.ts` e no front `AuthContext.tsx`) — não há
-- tabela. O schema `auth` NÃO é exposto à Data API (PostgREST) e a Supabase desaconselha
-- criar objetos próprios em `auth`/colunas em `auth.users`. Por isso o pedido original
-- (`auth.group` + `auth.users.group_id`) é implementado assim:
--   * catálogo relacional em `public.user_group` (legível pelo frontend via REST; extensível
--     — novos campos entram nesta tabela);
--   * atribuição de cada usuário via `app_metadata.group_id` (claim no JWT, server-controlled),
--     reaproveitando o mesmo mecanismo do `role`. SEM tabela de perfil e SEM trigger em
--     `auth.users`.
--
-- id 0 = sentinela "não informado" (padrão dos cadastros, ex. financial_cost_center).
-- Leitores tratam `group_id` AUSENTE no app_metadata como 0.
-- Idempotente: IF NOT EXISTS / ON CONFLICT.

-- ── Seção 1 — Catálogo public.user_group ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_group (
  group_id    INT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- 0 = "não informado"
  group_name  VARCHAR(30) NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  -- futuros campos entram aqui (ex.: descrição, flags de permissão)
);

-- Índices de performance:
--  * group_id já é indexado pela PRIMARY KEY (btree único) — não duplicar.
--  * group_name: busca/ordenação por nome do grupo.
CREATE INDEX IF NOT EXISTS idx_user_group_group_name ON public.user_group (group_name);

-- Seed do sentinela id 0 (nome em branco). OVERRIDING SYSTEM VALUE por ser IDENTITY ALWAYS.
INSERT INTO public.user_group (group_id, group_name)
OVERRIDING SYSTEM VALUE VALUES (0, '')
ON CONFLICT (group_id) DO NOTHING;

CREATE TRIGGER trg_user_group_updated_at
  BEFORE UPDATE ON public.user_group
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- RLS: leitura TO authenticated, escrita TO service_role (padrão do projeto).
ALTER TABLE public.user_group ENABLE ROW LEVEL SECURITY;

CREATE POLICY authenticated_select_user_group ON public.user_group
  FOR SELECT TO authenticated USING (true);

CREATE POLICY service_role_all_user_group ON public.user_group
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Seção 2 — Backfill da atribuição nos usuários atuais (claim no JWT) ──────────────────
-- Espelha group_id=0 no app_metadata dos usuários existentes (mesmo padrão do `role`).
-- Não há FK de app_metadata.group_id para user_group (app_metadata é schemaless) — a
-- validação do id contra o catálogo é feita na aplicação (futuro endpoint de atribuição).
UPDATE auth.users
SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                        || jsonb_build_object('group_id', 0)
WHERE (raw_app_meta_data ->> 'group_id') IS NULL;
