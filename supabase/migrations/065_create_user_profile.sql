-- 065_create_user_profile.sql
-- Vínculo usuário → grupo por FK REAL (fonte de verdade), evoluindo o claim
-- `app_metadata.group_id` da migration 063.
--
-- Contexto: a 063 criou o catálogo `public.user_group` e atribuiu o grupo a cada usuário
-- apenas por um claim em `app_metadata.group_id` (SEM tabela de perfil, SEM trigger em
-- auth.users). A decisão de design TRAVADA (docs/design/permissoes-por-grupo.md, decisão 1)
-- é vincular usuário → grupo por FK real numa tabela `public.user_profile`, que passa a ser a
-- fonte de verdade — o schema `auth` não é exposto à Data API e a Supabase desaconselha criar
-- FK/colunas diretamente em `auth.users`, então o vínculo mora em `public`.
--
-- Esta migration implementa o PASSO 1 do roadmap RBAC (só o vínculo). NÃO cria
-- permission/group_permission/group_* nem RLS de escopo — esses são os passos 065→067 do
-- blueprint e ficam para quando o RBAC for liberado.
--
-- group_id 0 = sentinela "não informado" (herda a semântica da 063).
-- Idempotente: IF NOT EXISTS / ON CONFLICT / DROP ... IF EXISTS.

-- ── Seção 1 — Tabela public.user_profile ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_profile (
  user_id     UUID        PRIMARY KEY
              REFERENCES auth.users (id) ON DELETE CASCADE,
  group_id    SMALLINT    NOT NULL DEFAULT 0
              REFERENCES public.user_group (group_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice na FK group_id (o user_id já é indexado pela PRIMARY KEY).
CREATE INDEX IF NOT EXISTS idx_user_profile_group_id ON public.user_profile (group_id);

-- updated_at automático (reusa a função já existente no projeto).
DROP TRIGGER IF EXISTS trg_user_profile_updated_at ON public.user_profile;
CREATE TRIGGER trg_user_profile_updated_at
  BEFORE UPDATE ON public.user_profile
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ── Seção 2 — RLS ───────────────────────────────────────────────────────────────────────
-- Leitura: cada usuário lê SÓ o próprio perfil (auth.uid() = user_id) — suficiente para o app
-- confirmar o grupo do usuário logado e para as futuras funções STABLE de escopo (que leem o
-- próprio uid). Escrita: apenas service_role (atribuição via Next API / Supabase).
ALTER TABLE public.user_profile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_select_own_user_profile ON public.user_profile;
CREATE POLICY authenticated_select_own_user_profile ON public.user_profile
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS service_role_all_user_profile ON public.user_profile;
CREATE POLICY service_role_all_user_profile ON public.user_profile
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Seção 3 — Auto-provisionamento de perfil para novos usuários ─────────────────────────
-- Todo usuário criado (Dashboard ou POST /api/users) ganha um perfil com group_id=0.
-- Padrão canônico Supabase "handle_new_user" (SECURITY DEFINER — o trigger roda no contexto
-- do dono da função, contornando o RLS de user_profile no INSERT).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profile (user_id, group_id)
  VALUES (NEW.id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auth_user_created ON auth.users;
CREATE TRIGGER trg_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Seção 4 — Backfill dos usuários atuais (perfil com group_id=0) ───────────────────────
INSERT INTO public.user_profile (user_id, group_id)
SELECT id, 0 FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ── Seção 5 — Classificar ricardo@sheild.com.br no grupo 1 (Administrador) ────────────────
-- group_id 1 já existe em user_group (= "Administrador"). Atualiza a FK na tabela de perfil.
UPDATE public.user_profile p
SET group_id = 1
FROM auth.users u
WHERE u.id = p.user_id
  AND lower(u.email) = 'ricardo@sheild.com.br';
