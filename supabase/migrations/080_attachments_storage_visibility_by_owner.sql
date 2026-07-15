-- Migration 080 — a leitura do BUCKET `attachments` herda a visibilidade da conta
--
-- REGRA (decisão do usuário, 2026-07-15): "grupo restrito só vê as contas em que é dono —
-- POR CONSEQUÊNCIA, o Storage também".
--
-- O buraco (anterior a esta feature): a policy da 021 é `USING (bucket_id = 'attachments')`,
-- SEM filtro de dono. Ela nasceu quando não havia visibilidade por grupo; a 076 restringiu as
-- CONTAS e a 079 os ANEXOS, mas o bucket seguiu aberto. Verificado com o papel `authenticated`
-- real: ester@otimotex.com.br (Comercial, sees_only_own_accounts) via 78 contas / 31 anexos
-- pela tela, mas enxergava os 565 objetos do bucket — bastando a chave, que as rotas
-- `GET /api/contas/:id` (source_file) e `/attachments` (storage_key) entregam (service_role).
--
-- A CORREÇÃO: só libera o objeto se existir uma linha que o PRÓPRIO usuário enxerga. As
-- subconsultas são avaliadas como `authenticated`, então a RLS de financial_account_attachment
-- (079) e de financial_account_control (076) se aplica DENTRO delas — a policy herda a regra
-- sozinha, sem duplicar o predicado de dono (mesma técnica do EXISTS da 079). Se a 076 mudar,
-- esta acompanha.
--   • grupo IRRESTRITO (Financeiro/Diretor/Administrador/…): as subconsultas veem todas as
--     contas → continua vendo todos os anexos. Nada muda para eles.
--   • grupo RESTRITO (Comercial): só as próprias → só os anexos das próprias contas.
--   • service_role (pipeline/Next API): ignora RLS — inalterado.
--
-- Os DOIS `EXISTS` são necessários:
--   a) financial_account_attachment.storage_key → o padrão único (manual + pipeline, 079);
--   b) financial_account_control.source_file    → o anexo do e-mail cuja linha não existe (o
--      registro no reader é NÃO-FATAL) — é o fallback `legacySourceFile` da UI. Sem (b), esse
--      anexo pararia de abrir.
--
-- EFEITO COLATERAL ACEITO: 332 dos 565 objetos não casam nenhuma linha (PDF que subiu no Passo 1
-- e cuja conta nunca foi criada — CT-e ignorado, extração falhou, não-pagável). Eles ficam
-- invisíveis pela API — mas já eram inalcançáveis pela UI (nada os referencia), e o pipeline
-- (service_role) segue enxergando para reprocessar.
--
-- APLICADA via Supabase MCP em 2026-07-15 (base compartilhada dev/prod) — histórico; não reaplicar.
-- Idempotente-segura.

-- (a) Índice do casamento por source_file. Sem ele, CADA download faria seq scan em
--     financial_account_control (~400 linhas hoje, mas cresce sempre). O lado do anexo já tem
--     `ix_faa_storage_key` (079). Parcial: só a linha com anexo interessa.
CREATE INDEX IF NOT EXISTS ix_fac_source_file
  ON public.financial_account_control (source_file)
  WHERE source_file IS NOT NULL;

-- (b) A policy de leitura do bucket passa a herdar a visibilidade da conta.
DROP POLICY IF EXISTS "authenticated_read_attachments" ON storage.objects;
CREATE POLICY "authenticated_read_attachments"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'attachments'
    AND (
      EXISTS (
        SELECT 1 FROM public.financial_account_attachment a
         WHERE a.storage_key = storage.objects.name
      )
      OR EXISTS (
        SELECT 1 FROM public.financial_account_control f
         WHERE f.source_file = storage.objects.name
      )
    )
  );

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (rodar após aplicar) — com o papel `authenticated` de cada perfil:
--
-- BEGIN;
--   SELECT set_config('request.jwt.claims','{"sub":"<uuid>","role":"authenticated","email":"<email>"}', true);
--   SET LOCAL ROLE authenticated;
--   SELECT count(*) FROM storage.objects WHERE bucket_id = 'attachments';
-- ROLLBACK;
--
-- Esperado (2026-07-15): Comercial (ester) = 31 · Financeiro (barbara) = 233 · antes: 565 para
-- ambos. O nº do irrestrito é o total de objetos COM linha (228 anexos + os source_file órfãos
-- de linha), não 565 — os 332 sem vínculo saem para todos.
