-- Migration 079 — anexos MÚLTIPLOS por conta (financial_account_attachment)
--
-- Até aqui a conta guardava UM anexo em financial_account_control.source_file (coluna TEXT), e
-- só o pipeline Python escrevia no bucket `attachments` (service_role). Conta lançada MANUALMENTE
-- não tinha como receber arquivo: source_file é bloqueada no CRUD manual pelo Zod (S3-2).
--
-- Esta tabela é o PADRÃO ÚNICO de anexo — o painel lista igual o que veio do e-mail (origin
-- 'pipeline') e o que o usuário enviou ('manual'). source_file PERMANECE em
-- financial_account_control (dedup/auditoria do pipeline); esta tabela a espelha via backfill.
--
-- Chave do objeto (storage_key) = chave CRUA do bucket, passada direto ao createSignedUrl:
--   pipeline → nome flat  (ex.: `ester_RES_..._HYOSUNG.pdf`)
--   manual   → `manual/{account_id}/{ts}_{rand8}_{nome}.ext`
-- Os namespaces são disjuntos POR CONSTRUÇÃO: o safe_filename do pipeline
-- (read_emails.py, `re.sub(r"[^\w\s-]", "", text)`) REMOVE a barra, então nenhuma chave do
-- pipeline contém '/'. Anexo manual nunca sobrescreve anexo de e-mail.
--
-- APLICADA via Supabase MCP em 2026-07-15 (base compartilhada dev/prod) — histórico; não reaplicar.
-- Idempotente-segura (DDL só aditivo; backfill guardado por NOT EXISTS).

-- (a) Tabela.
CREATE TABLE IF NOT EXISTS public.financial_account_attachment (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES public.financial_account_control(id) ON DELETE CASCADE,
  storage_key TEXT   NOT NULL CHECK (btrim(storage_key) <> ''),
  file_name   TEXT   NOT NULL CHECK (btrim(file_name) <> ''),  -- nome ORIGINAL, só p/ exibição
  mime_type   TEXT   NOT NULL DEFAULT 'application/octet-stream',
  size_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  -- 'pipeline' (documento que ORIGINOU a conta) é trilha de auditoria → irremovível pela UI (403).
  origin      TEXT   NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'pipeline')),
  uploaded_by UUID   NOT NULL DEFAULT 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e'
              REFERENCES auth.users(id) ON DELETE SET DEFAULT,   -- sentinela das 076/077
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- SOFT DELETE: some da UI, o OBJETO FICA no bucket (política de preservação + policy da 073).
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Só barra o estado ABSURDO (autor da remoção sem remoção). NÃO exige a recíproca: quando
  -- o usuário que removeu é apagado do Auth, a FK faz SET NULL e a linha fica
  -- (deleted_at=t, deleted_by=NULL) = "removido, autor desconhecido" — que é válido.
  -- Com o CHECK bidirecional `(deleted_at IS NULL) = (deleted_by IS NULL)`, esse SET NULL
  -- violaria a constraint e **ABORTARIA o `DELETE FROM auth.users`** (verificado no banco):
  -- o admin levaria um erro incompreensível vindo da tabela de anexos e não conseguiria
  -- apagar o usuário. `ON DELETE SET DEFAULT` (como em uploaded_by) não serve aqui: o
  -- default entraria também nos INSERTs normais, com deleted_at nulo, quebrando tudo.
  CONSTRAINT ck_faa_deleted_consistente CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

COMMENT ON TABLE  public.financial_account_attachment IS
  'Anexos (PDF/imagem) de uma conta a pagar. origin=pipeline vem da extração de e-mail (espelha '
  'financial_account_control.source_file); origin=manual vem do upload do usuário. Soft delete: '
  'deleted_at oculta a linha, o objeto permanece no bucket attachments.';
COMMENT ON COLUMN public.financial_account_attachment.storage_key IS
  'Chave CRUA do objeto no bucket attachments (o AttachmentViewer a passa direto ao createSignedUrl). '
  'Pipeline: nome flat (nunca contém /). Manual: manual/{account_id}/{ts}_{rand8}_{nome}.ext';

-- (b) Índices.
--     A UNIQUE é TOTAL (não parcial) de propósito: o `on_conflict` do PostgREST — usado pela
--     idempotência do register do pipeline — NÃO resolve índice PARCIAL. Reanexar o mesmo arquivo
--     à mesma conta após remover não ocorre: a chave manual carrega timestamp+rand8, e anexo
--     'pipeline' não é removível.
CREATE UNIQUE INDEX IF NOT EXISTS ux_faa_account_storage_key
  ON public.financial_account_attachment (account_id, storage_key);

CREATE INDEX IF NOT EXISTS ix_faa_account_id
  ON public.financial_account_attachment (account_id) WHERE deleted_at IS NULL;

-- Responde "esse objeto ainda é referenciado por OUTRA conta?" — 9 arquivos são compartilhados por
-- até 4 contas (um PDF com 4 boletos vira 4 contas). Guarda de qualquer limpeza futura do bucket.
CREATE INDEX IF NOT EXISTS ix_faa_storage_key
  ON public.financial_account_attachment (storage_key);

-- (c) RLS. O SELECT HERDA a visibilidade da conta pai (076) via EXISTS, sem repetir o predicado: a
--     subconsulta é avaliada como `authenticated`, então a RLS de financial_account_control já se
--     aplica dentro dela. Se a 076 ganhar novas dimensões, esta policy acompanha sozinha —
--     duplicar auth_group_sees_only_own() aqui criaria duas fontes de verdade divergentes.
--     O `deleted_at IS NULL` esconde o removido E dispensa filtrar no embed do PostgREST;
--     o service_role (bypass de RLS) continua enxergando o soft-deletado para auditoria.
ALTER TABLE public.financial_account_attachment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_select_financial_account_attachment
  ON public.financial_account_attachment;
CREATE POLICY authenticated_select_financial_account_attachment
  ON public.financial_account_attachment FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM public.financial_account_control f WHERE f.id = account_id)
  );

DROP POLICY IF EXISTS service_role_all_financial_account_attachment
  ON public.financial_account_attachment;
CREATE POLICY service_role_all_financial_account_attachment
  ON public.financial_account_attachment FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Escrita só pela Next API / pipeline (service_role). O papel `authenticated` só lê.
GRANT SELECT ON public.financial_account_attachment TO authenticated;
GRANT ALL    ON public.financial_account_attachment TO service_role;

-- DEFESA EM PROFUNDIDADE (mesmo motivo das migrations 056/057): o Supabase concede grants
-- DEFAULT de INSERT/UPDATE/DELETE ao papel `authenticated` em toda tabela nova do schema
-- public. A RLS acima já bloqueia 100% da escrita (não há policy de escrita para esse papel
-- — default deny, verificado: o UPDATE afeta 0 linhas), mas sem este REVOKE o grant residual
-- ficaria como única barreira caso a RLS fosse desabilitada por engano. Sem ele, esta tabela
-- também ficaria ASSIMÉTRICA com supplier/status, que passaram pelo REVOKE da 057.
-- Não toca SELECT nem os grants do service_role.
REVOKE INSERT, UPDATE, DELETE ON public.financial_account_attachment FROM authenticated;

-- (d) Backfill do histórico (na aplicação: 249 contas com source_file sobre 228 objetos distintos
--     — há menos objetos que contas porque um PDF com N boletos gera N contas).
--     LEFT JOIN (não INNER): hoje não há source_file órfão, mas se um objeto sumir do bucket o
--     VÍNCULO de auditoria deve sobreviver — o AttachmentViewer já trata o caso ('notfound').
INSERT INTO public.financial_account_attachment
  (account_id, storage_key, file_name, mime_type, size_bytes, origin, uploaded_by, created_at)
SELECT f.id,
       f.source_file,
       f.source_file,
       COALESCE(o.metadata->>'mimetype', 'application/octet-stream'),
       COALESCE((o.metadata->>'size')::bigint, 0),
       'pipeline',
       f.created_by,
       COALESCE(f.extracted_at, f.created_at)
FROM public.financial_account_control f
LEFT JOIN storage.objects o
  ON o.bucket_id = 'attachments' AND o.name = f.source_file
WHERE f.source_file IS NOT NULL
  AND btrim(f.source_file) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.financial_account_attachment a
    WHERE a.account_id = f.id AND a.storage_key = f.source_file
  );

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (rodar após aplicar)
-- ---------------------------------------------------------------------------
-- Na aplicação (2026-07-15): total=249, objetos_distintos=228, contas_sem_anexo=0.
-- Os dois primeiros crescem a cada leitura de e-mail; o que TRAVA é contas_sem_anexo=0.
--
-- SELECT count(*) AS total,
--        count(DISTINCT storage_key) AS objetos_distintos
--   FROM public.financial_account_attachment WHERE origin = 'pipeline';
--
-- SELECT count(*) AS contas_sem_anexo
--   FROM public.financial_account_control f
--  WHERE f.source_file IS NOT NULL AND btrim(f.source_file) <> ''
--    AND NOT EXISTS (SELECT 1 FROM public.financial_account_attachment a
--                    WHERE a.account_id = f.id AND a.storage_key = f.source_file);
