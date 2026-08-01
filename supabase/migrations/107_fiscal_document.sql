-- 107_fiscal_document.sql
--
-- ONDA 3 (itens 3.1) do roadmap — docs/roadmap-enriquecimento-dados.md
--
-- PROBLEMA: 172 DACTEs e 33 DANFEs já foram baixados, extraídos e guardados no bucket — e
-- produziram **zero** dado estruturado. A regra de negócio está certa e permanece intacta
-- (CT-e/NF-e sem boleto NÃO é conta a pagar), mas hoje o documento fiscal é descartado por
-- inteiro: a chave de acesso, o CNPJ do emitente e o número do documento se perdem junto.
--
-- Esta tabela guarda o documento fiscal como PROVENIÊNCIA — não como obrigação financeira.
--
-- ---------------------------------------------------------------------------
-- 🔴 INVARIANTE: documento fiscal NUNCA soma em relatório financeiro
-- ---------------------------------------------------------------------------
-- O frete já entra no sistema como BOLETO e a NF-e é a origem da mercadoria, não a obrigação
-- de pagamento. Somar `fiscal_document` a `financial_account_control` duplicaria despesa. Por
-- isso esta tabela NÃO tem valor monetário nem entra em nenhuma view de `analytics.vw_payables`,
-- e a tool da migration 108 declara isso na própria descrição, para o modelo não ser tentado.
--
-- ---------------------------------------------------------------------------
-- POR QUE NÃO HÁ `account_id`
-- ---------------------------------------------------------------------------
-- O gancho do reader roda no **Passo 1** de `extract_and_store_accounts` — onde os anexos são
-- extraídos e a conta ainda NÃO existe (ela nasce no Passo 2, e na maioria destes casos nem
-- nasce). Preencher a FK depois transformaria uma tabela imutável em mutável, que é exatamente
-- a propriedade que a protege do problema dos agregados: um CT-e não muda de emitente amanhã.
-- A ligação com o e-mail (e, por ele, com a conta) já existe via `gmail_message_id` e
-- `storage_key`.
--
-- ---------------------------------------------------------------------------
-- APPEND-ONLY POR CONTRATO, NÃO POR TRIGGER
-- ---------------------------------------------------------------------------
-- O único caminho de escrita é o INSERT do reader com `Prefer: resolution=ignore-duplicates`
-- sobre a UNIQUE de `access_key` (o mesmo padrão idempotente do `register_attachment`, 079).
-- Não há trigger bloqueando UPDATE/DELETE de propósito: ela só afetaria o `service_role` — o
-- papel `authenticated` já não escreve (RLS + REVOKE abaixo) — e impediria corrigir um backfill
-- errado, sem impedir nada que hoje aconteça.

CREATE TABLE IF NOT EXISTS public.fiscal_document (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Identidade do documento. UNIQUE porque a mesma chave chegando de novo (reenvio,
  -- encaminhamento, reprocessamento) é o MESMO documento — nunca um segundo.
  access_key       CHAR(44) NOT NULL UNIQUE CHECK (access_key ~ '^[0-9]{44}$'),

  -- ⚠️ Este domínio espelha `FISCAL_MODELS` em skills/pdf-contas-pagar/scripts/fiscal_key.py.
  --    Há teste cross-layer (tests/test_fiscal_document_consistency.py) lendo os dois e
  --    comparando: divergir aqui faria o INSERT do reader falhar com 23514 em produção.
  --    NFS-e fica de fora porque é MUNICIPAL e não tem chave nacional de 44 dígitos.
  --    (Nome corrigido em 2026-08-01: apontava para `test_fiscal_key_domain_consistency.py`,
  --    que nunca existiu — o arquivo mudou de nome ao ganhar a 2ª guarda, a da purga, e o
  --    comentário ficou para trás. Hoje o próprio teste confere este nome; ver o método
  --    `test_a_migration_aponta_para_ESTE_arquivo`.)
  model            SMALLINT NOT NULL CHECK (model IN (55, 57, 59, 65)),

  -- Derivados da própria chave (posições 0-1, 2-5, 6-19, 22-24, 25-33). Ficam em colunas
  -- para serem filtráveis/indexáveis; a chave permanece a fonte de verdade.
  uf_code          SMALLINT NOT NULL,
  issue_yearmonth  CHAR(4)  NOT NULL CHECK (issue_yearmonth ~ '^[0-9]{4}$'),
  emitter_cnpj     CHAR(14) NOT NULL CHECK (emitter_cnpj ~ '^[0-9]{14}$'),
  series           SMALLINT NOT NULL,
  doc_number       INTEGER  NOT NULL,

  -- 🔴 É POR ESTA COLUNA que scripts/purge_orphan_attachments.py passa a preservar o objeto.
  --    Sem ela na conta de "referenciado", a próxima purga apagaria justamente os PDFs que
  --    esta onda acabou de registrar — de forma irreversível e reportando "órfãos removidos"
  --    com naturalidade. Nome flat do objeto no bucket, como o do pipeline em
  --    financial_account_attachment (nunca contém '/').
  storage_key      TEXT,

  -- Proveniência: de qual e-mail veio. Não é FK para email_control porque o registro é
  -- não-fatal e append-only — uma FK faria a limpeza de e-mails abortar por causa dele.
  gmail_message_id TEXT,
  sender_email     TEXT,
  subject          TEXT,
  received_at      TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fiscal_document IS
  'Documentos fiscais eletrônicos (NF-e 55, CT-e 57, CF-e 59, NFC-e 65) identificados pela chave '
  'de acesso de 44 dígitos nos anexos recebidos. Tabela de PROVENIÊNCIA, append-only: NUNCA soma '
  'em relatório financeiro (o frete já entra como boleto; somar duplicaria despesa).';
COMMENT ON COLUMN public.fiscal_document.storage_key IS
  'Objeto no bucket attachments de onde a chave foi lida. purge_orphan_attachments.py consulta '
  'esta coluna para NÃO apagar o PDF fiscal como se fosse órfão.';
COMMENT ON COLUMN public.fiscal_document.model IS
  'Modelo do documento; domínio espelhado em fiscal_key.FISCAL_MODELS (guarda cross-layer).';

-- Índices. O de storage_key é o mais crítico: a purga o consulta a cada execução.
CREATE INDEX IF NOT EXISTS ix_fiscal_document_storage_key
  ON public.fiscal_document (storage_key) WHERE storage_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_fiscal_document_emitter
  ON public.fiscal_document (emitter_cnpj);

CREATE INDEX IF NOT EXISTS ix_fiscal_document_model_received
  ON public.fiscal_document (model, received_at DESC);

CREATE INDEX IF NOT EXISTS ix_fiscal_document_message_id
  ON public.fiscal_document (gmail_message_id) WHERE gmail_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS — o MESMO recorte da migration 078, por REMETENTE
-- ---------------------------------------------------------------------------
-- Aqui NÃO dá para herdar o predicado por EXISTS como a 079 faz (que se apoia na conta pai):
-- a maioria destas linhas não tem conta nenhuma — é justamente o documento que NÃO virou conta.
-- A chave de recorte correta é a mesma de `email_control` (078): o e-mail de que a linha veio.
-- Sem isto, o grupo Comercial (o único com `sees_only_own_accounts` hoje) passaria a ver CNPJ de
-- emitente e assunto de e-mails alheios — furando pela porta dos fundos o recorte da 078.
ALTER TABLE public.fiscal_document ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_select_fiscal_document ON public.fiscal_document;
CREATE POLICY authenticated_select_fiscal_document
  ON public.fiscal_document FOR SELECT TO authenticated
  USING ( NOT public.auth_group_sees_only_own()
          OR lower(sender_email) = lower(auth.email()) );

DROP POLICY IF EXISTS service_role_all_fiscal_document ON public.fiscal_document;
CREATE POLICY service_role_all_fiscal_document
  ON public.fiscal_document FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT ON public.fiscal_document TO authenticated;
GRANT ALL    ON public.fiscal_document TO service_role;

-- DEFESA EM PROFUNDIDADE (guardrail 3 do roadmap; lição 056/057/079/081): o Supabase concede
-- INSERT/UPDATE/DELETE ao papel `authenticated` em toda tabela nova do schema public, e o
-- ALTER DEFAULT PRIVILEGES da 097 não alcança objeto criado por supabase_admin. A RLS acima já
-- bloqueia a escrita (não há policy de escrita para o papel), mas sem este REVOKE o grant
-- residual seria a única barreira caso a RLS fosse desligada por engano.
REVOKE INSERT, UPDATE, DELETE ON public.fiscal_document FROM authenticated;
REVOKE ALL ON public.fiscal_document FROM anon;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executar após aplicar; em prosa — SQL comentado reprova o SonarCloud)
-- ---------------------------------------------------------------------------
--
--   1. A tabela existe e `access_key` tem índice UNIQUE.
--   2. Inserir a mesma chave duas vezes viola a UNIQUE (é o que torna o register idempotente).
--   3. Uma chave com modelo fora de (55,57,59,65) é recusada pelo CHECK — e o domínio bate com
--      FISCAL_MODELS no Python (o teste cross-layer prova isso a cada suíte).
--   4. `authenticated` tem SELECT e NÃO tem INSERT/UPDATE/DELETE; `anon` não tem nada.
--   5. Com o papel `authenticated` de um usuário do grupo Comercial, o SELECT devolve MENOS
--      linhas que para um irrestrito — prova de que a policy recorta por remetente.
--   6. `get_advisors` não acusa RLS ausente nem SECURITY DEFINER esquecido.
