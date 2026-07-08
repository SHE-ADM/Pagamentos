-- 073_seed_admin_group_and_storage_delete_policy.sql
-- ============================================================================
-- Higiene do review 2026-07-08 — dois achados BAIXO, ambos idempotentes:
--
-- 1) A5-2 — Seed do grupo 1 ("Administrador") em user_group.
--    A 065 faz UPDATE user_profile SET group_id = 1 (FK -> user_group), mas a 063
--    só semeia o sentinela id 0 — em aplicação LIMPA e em ordem, o grupo 1 não
--    existiria e a 065 abortaria por violação de FK. No banco vivo o grupo 1 já
--    existe (criado via Dashboard) → o INSERT é no-op (ON CONFLICT DO NOTHING).
--
-- 2) S2-2 — Policy EXPLÍCITA de bloqueio de DELETE no bucket `attachments`.
--    A 021 só criou a policy de SELECT; o DELETE por `authenticated` estava
--    bloqueado apenas pelo default-deny da RLS de storage.objects (proteção
--    implícita/frágil). Esta policy RESTRICTIVE torna o controle explícito e
--    resistente a uma futura policy permissiva de DELETE em outro contexto:
--    para `authenticated`, DELETE em objetos do bucket `attachments` NUNCA passa.
--    (Limpeza do bucket continua pelo service_role via Storage API — ignora RLS.)
--
-- Idempotente: ON CONFLICT DO NOTHING + DROP POLICY IF EXISTS antes do CREATE.
-- ============================================================================

-- 1) A5-2 — grupo 1 "Administrador" (OVERRIDING SYSTEM VALUE: PK é IDENTITY ALWAYS).
INSERT INTO public.user_group (group_id, group_name)
OVERRIDING SYSTEM VALUE VALUES (1, 'Administrador')
ON CONFLICT (group_id) DO NOTHING;

-- Realinha a sequence da IDENTITY acima do maior id semeado/manual, para o próximo
-- INSERT automático não colidir com ids inseridos via OVERRIDING SYSTEM VALUE.
SELECT setval(
  pg_get_serial_sequence('public.user_group', 'group_id'),
  GREATEST((SELECT COALESCE(MAX(group_id), 1) FROM public.user_group), 1)
);

-- 2) S2-2 — bloqueio explícito de DELETE por `authenticated` no bucket attachments.
DROP POLICY IF EXISTS "attachments_no_delete_authenticated" ON storage.objects;
CREATE POLICY "attachments_no_delete_authenticated"
  ON storage.objects
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (bucket_id <> 'attachments');

-- ============================================================================
-- VERIFICAÇÃO (após aplicar):
--   SELECT group_id, group_name FROM public.user_group WHERE group_id IN (0, 1);
--   SELECT policyname, cmd, permissive FROM pg_policies
--   WHERE  schemaname = 'storage' AND tablename = 'objects'
--     AND  policyname = 'attachments_no_delete_authenticated';
-- ============================================================================
