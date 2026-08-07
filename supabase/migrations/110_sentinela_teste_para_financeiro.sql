-- 110_sentinela_teste_para_financeiro.sql
--
-- Substitui a identidade SENTINELA de autoria: teste@otimotex.com.br → financeiro@otimotex.com.br.
--
-- O sentinela é o usuário atribuído quando o pipeline não consegue resolver um dono real para a
-- conta (migrations 076/077). Ele aparece em QUATRO lugares independentes, e é justamente por
-- serem independentes que trocar só um deixa o sistema meio-migrado sem nenhum erro:
--
--   (1) DEFAULT de financial_account_control.created_by / updated_by / status_changed_by
--   (2) DEFAULT de financial_account_attachment.uploaded_by
--   (3) fallback COALESCE embutido em resolve_user_for_account()  ← o mais perigoso
--   (4) constante SENTINEL_AUTHOR_ID/EMAIL no frontend (fora desta migration; ver o guarda
--       cross-layer em apps/frontend-vite/src/pages/Consulta.sentinel.test.ts)
--
-- 🔴 Por que (3) é o mais perigoso: a RPC devolve o UUID do sentinela quando o e-mail do
-- remetente não casa nenhum usuário, e o reader grava esse retorno em created_by. Se o usuário
-- antigo for APAGADO sem esta troca, a RPC passa a devolver um UUID inexistente e **todo INSERT
-- de conta cujo remetente não seja usuário do sistema viola a FK** — o pipeline para de gravar,
-- e o sintoma aparece longe da causa.
--
-- IDEMPOTENTE: os defaults são reescritos por valor final (não por delta) e a função é
-- CREATE OR REPLACE. Reexecutar é no-op.
--
-- NÃO faz parte desta migration:
--   · a migração dos DADOS já gravados (feita à parte, com contenção de triggers e prova por
--     hash de conteúdo — ver o bloco "Substituição do sentinela" no CLAUDE.md);
--   · a EXCLUSÃO do usuário antigo, que depende de trocar antes o secret A11Y_TEST_EMAIL do
--     GitHub (o workflow de acessibilidade loga com ele a cada PR).

BEGIN;

-- Guarda de pré-condição: sem o usuário de destino, os DEFAULT abaixo passariam a apontar para
-- um UUID inexistente e a próxima inserção violaria a FK. Falhar aqui é barato; falhar no
-- pipeline, à meia-noite, não é.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE id = '89ce3055-1d8f-4da7-8355-f855817e61e0'
  ) THEN
    RAISE EXCEPTION
      'ABORTADO: o usuário de destino (financeiro@otimotex.com.br) não existe em auth.users';
  END IF;
END $$;

-- (1) Autoria da conta — as três colunas da migration 076/077.
ALTER TABLE public.financial_account_control
  ALTER COLUMN created_by        SET DEFAULT '89ce3055-1d8f-4da7-8355-f855817e61e0'::uuid,
  ALTER COLUMN updated_by        SET DEFAULT '89ce3055-1d8f-4da7-8355-f855817e61e0'::uuid,
  ALTER COLUMN status_changed_by SET DEFAULT '89ce3055-1d8f-4da7-8355-f855817e61e0'::uuid;

-- (2) Anexo (migration 079). `deleted_by` não tem default (é ON DELETE SET NULL) — nada a fazer.
ALTER TABLE public.financial_account_attachment
  ALTER COLUMN uploaded_by SET DEFAULT '89ce3055-1d8f-4da7-8355-f855817e61e0'::uuid;

-- (3) Fallback da resolução de dono. Assinatura, volatilidade, SECURITY DEFINER e search_path
-- são reproduzidos EXATAMENTE como estão hoje (conferidos em `pg_get_functiondef` antes de
-- escrever esta migration) — só o UUID do COALESCE muda.
--
-- Observação deliberadamente NÃO aplicada aqui: o `search_path` não menciona `pg_temp`, que
-- por isso é pesquisado PRIMEIRO — o vetor clássico de shadowing em SECURITY DEFINER. Corrigir
-- pede `SET search_path = public, auth, pg_temp`, mas é mudança de SEGURANÇA e merece migration
-- e verificação próprias; embutir aqui tornaria este diff (uma substituição de identidade) mais
-- difícil de conferir do que precisa ser.
CREATE OR REPLACE FUNCTION public.resolve_user_for_account(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT COALESCE(
    (SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1),
    '89ce3055-1d8f-4da7-8355-f855817e61e0'::uuid);
$$;

-- O REVOKE/GRANT é reaplicado porque CREATE OR REPLACE **preserva** os privilégios existentes,
-- mas uma execução em base limpa (onde a função nasceria aqui) herdaria o EXECUTE que o
-- PostgreSQL concede a PUBLIC por default — o resíduo que a 097 teve de limpar em massa.
REVOKE EXECUTE ON FUNCTION public.resolve_user_for_account(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_user_for_account(text) TO service_role;

COMMIT;

-- VERIFICAÇÃO (rodar após aplicar; esperado: 4 defaults no novo UUID, fallback novo, 0 antigos)
--
--   SELECT table_name, column_name, column_default
--     FROM information_schema.columns
--    WHERE column_default LIKE '%fe8d268d%';        -- esperado: 0 linhas
--
--   SELECT prosrc FROM pg_proc WHERE proname = 'resolve_user_for_account';
--                                                   -- esperado: COALESCE com 89ce3055
