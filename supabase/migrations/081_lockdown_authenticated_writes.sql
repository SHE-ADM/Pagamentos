-- Migration 081 — fecha a ESCRITA do papel `authenticated` no caminho REST direto
--
-- O frontend escreve DIRETO no PostgREST (sem passar pela Next API) em dois pontos: a curadoria
-- inline de /consulta (has_invoice/has_bank_slip/status_id) e o "revisado" de /emails
-- (reviewed_at). Esse caminho não tem `canSeeConta` — quem manda é a RLS. Auditando as policies
-- e os grants do papel, achei três problemas, do mais grave para o menor.
--
-- ===========================================================================================
-- (a) CRÍTICO — escalada de privilégio pela VIEW `app_user` (criada na 077)
-- ===========================================================================================
-- A view é `SELECT id, email FROM auth.users` com `security_invoker = false`, ou seja, roda como
-- o OWNER (postgres) e por isso ignora a RLS de auth.users — o que é NECESSÁRIO para o /consulta
-- resolver o e-mail do autor. O problema é o outro lado: o Supabase concede grants DEFAULT de
-- INSERT/UPDATE/DELETE ao papel `authenticated` em todo objeto novo do schema public, e uma view
-- simples como esta é AUTO-ATUALIZÁVEL (`information_schema.views.is_updatable = YES`).
--
-- Resultado, verificado com o papel `authenticated` real (ester@otimotex.com.br, grupo Comercial —
-- o mais restrito do sistema):
--     UPDATE public.app_user SET email='invadido@atacante.test' WHERE email='ricardo@sheild.com.br';
--     → 1 linha alterada EM auth.users.
-- Ou seja: qualquer usuário logado podia trocar o e-mail de qualquer outro (inclusive do
-- Administrador) e, com isso, tomar a conta dele via "esqueci minha senha". O DELETE só não passou
-- porque uma FK (status_changed_by) segurou — um usuário SEM contas seria apagável.
--
-- A view precisa continuar rodando como owner (senão o autor some da tela: auth.users não tem
-- policy para `authenticated`). A correção é tirar a ESCRITA: a view é read-only por natureza.
REVOKE INSERT, UPDATE, DELETE ON public.app_user FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.app_user FROM anon;

-- ===========================================================================================
-- (b) As policies de UPDATE eram `USING (true)` — ignoravam a visibilidade por dono
-- ===========================================================================================
-- REGRA (decisão do usuário): "grupo restrito só vê as contas em que é dono". Quem NÃO PODE VER
-- também NÃO PODE EDITAR — senão um PATCH forjado por id (fora da tela) alteraria conta alheia.
-- As 076/078 restringiram o SELECT, mas o UPDATE ficou `USING (true)`.
--
-- IMPORTANTE — a curadoria inline de /consulta CONTINUA funcionando por clique (NF/BOL/situação):
-- o predicado é o MESMO do SELECT, então o usuário edita exatamente as linhas que a tela mostra.
-- Grupo irrestrito (Financeiro/Diretor/Administrador) segue editando tudo, como hoje.
-- O `WITH CHECK` repete o `USING` para a linha não poder ser movida para fora da visibilidade
-- (hoje improvável — o grant é só das 3 colunas de curadoria —, mas é a forma correta).
-- Os GRANTs por coluna (033/068/030) não mudam: continuam sendo o que limita o que é gravável.

DROP POLICY IF EXISTS authenticated_update_financial_flags ON public.financial_account_control;
CREATE POLICY authenticated_update_financial_flags
  ON public.financial_account_control
  FOR UPDATE TO authenticated
  USING      (NOT public.auth_group_sees_only_own() OR created_by = auth.uid())
  WITH CHECK (NOT public.auth_group_sees_only_own() OR created_by = auth.uid());

-- Espelha a policy de SELECT da 078 (casa o REMETENTE com o e-mail do logado, não o created_by).
DROP POLICY IF EXISTS authenticated_update_email_control ON public.email_control;
CREATE POLICY authenticated_update_email_control
  ON public.email_control
  FOR UPDATE TO authenticated
  USING      (NOT public.auth_group_sees_only_own() OR lower(sender_email) = lower(auth.email()))
  WITH CHECK (NOT public.auth_group_sees_only_own() OR lower(sender_email) = lower(auth.email()));

-- ===========================================================================================
-- (c) Grants DEFAULT residuais de escrita (defesa em profundidade — padrão das 056/057/079)
-- ===========================================================================================
-- Estas tabelas têm RLS ligada e NENHUMA policy de escrita para `authenticated`, então a RLS já
-- nega 100% (default deny) — mas o grant default do Supabase continuava lá. Sem o REVOKE, o grant
-- seria a única barreira caso a RLS fosse desligada por engano, e as tabelas ficam assimétricas
-- com supplier/status (057) e financial_account_attachment (079). Não toca SELECT nem service_role.
DO $$
DECLARE
  t text;
  alvos text[] := ARRAY[
    'email_processing_errors',  -- /erros é só leitura
    'cobranca_envios_log',      -- escritos pelo batch de cobrança (service_role)
    'cobranca_erros_log',
    'user_group',               -- catálogo de grupos: editado só via Supabase
    'user_profile',             -- vínculo usuário→grupo: idem (era gravável em group_id!)
    'supplier_tmp'              -- resíduo de migração (464 linhas, sem policy alguma)
  ];
BEGIN
  FOREACH t IN ARRAY alvos LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    ELSE
      RAISE NOTICE 'Tabela % não encontrada — pulando.', t;
    END IF;
  END LOOP;
END $$;

-- As duas tabelas da curadoria também tinham INSERT/DELETE residuais (a RLS nega — não há policy
-- de INSERT/DELETE para o papel). Revogados SEPARADAMENTE e SEM `UPDATE` de propósito: um
-- `REVOKE UPDATE` aqui derrubaria os grants POR COLUNA das 030/033/068 e quebraria a curadoria
-- inline de /consulta (NF/BOL/situação) e o "revisado" de /emails — que é justamente o que a
-- policy acima preserva. É por isso que a 057 não tocou nestas duas tabelas.
REVOKE INSERT, DELETE ON public.financial_account_control FROM authenticated;
REVOKE INSERT, DELETE ON public.email_control            FROM authenticated;

-- APLICADA via Supabase MCP em 2026-07-15 (base compartilhada dev/prod) — histórico; não reaplicar.
-- Idempotente-segura.
--
-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (com o papel `authenticated` de cada perfil)
-- ---------------------------------------------------------------------------
-- (a) escalada fechada — esperado: 42501 permission denied
--   BEGIN; SET LOCAL ROLE authenticated;
--     UPDATE public.app_user SET email='x' WHERE email='ricardo@sheild.com.br';
--   ROLLBACK;
--
-- (b) curadoria inline PRESERVADA — esperado: ester edita as PRÓPRIAS (>0) e 0 nas alheias
--   BEGIN;
--     SELECT set_config('request.jwt.claims','{"sub":"<uuid ester>","role":"authenticated","email":"ester@otimotex.com.br"}', true);
--     SET LOCAL ROLE authenticated;
--     WITH u AS (UPDATE financial_account_control SET has_invoice=true
--                 WHERE created_by='<uuid ester>' RETURNING 1) SELECT count(*) FROM u;
--   ROLLBACK;
