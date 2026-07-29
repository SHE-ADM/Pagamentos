-- 101_ai_chat_log_grant_and_cache_tokens.sql
-- (1) GRANT que faltava ao service_role em analytics.ai_chat_log  ← CORREÇÃO DE BUG
-- (2) Colunas de tokens de PROMPT CACHING
--
-- =============================================================================
-- (1) O BUG: a trilha de auditoria do chat NUNCA teria gravado uma linha
-- =============================================================================
-- A 098 concedeu `USAGE` no schema e `SELECT` nos objetos ao papel `authenticated`, e nada ao
-- `service_role`. Mas quem grava o log é o `service_role` (exceção deliberada: deixar o usuário
-- auditado escrever a própria trilha permitiria omitir a própria pergunta). Medido no catálogo:
--
--   nspacl de analytics ......... {postgres=UC/postgres, authenticated=U/postgres}
--   has_schema_privilege(service_role, 'analytics', 'USAGE') ......... false
--   has_table_privilege(service_role, 'analytics.ai_chat_log', 'INSERT') ... false
--
-- `service_role` burla RLS (`rolbypassrls`), mas **não é superuser** — sem GRANT explícito o
-- INSERT falha com 42501. E `logInteraction` **nunca lança** por desenho (uma falha de auditoria
-- não pode derrubar uma resposta já produzida), então o erro iria só para o `console.error`: o
-- pilar de auditoria (§8) ficaria morto em produção sem nenhum sintoma visível.
--
-- NÃO se concede nada além disto ao service_role — em especial, **nenhum EXECUTE nas 6 funções
-- nem SELECT nas views**. O caminho de DADOS tem de passar pelo JWT do usuário para a RLS decidir
-- o recorte; service_role ali seria escalada de privilégio silenciosa (o chat veria as contas de
-- todos). USAGE no schema não dá acesso a esses objetos: os ACLs deles não incluem o papel.

GRANT USAGE ON SCHEMA analytics TO service_role;
GRANT SELECT, INSERT ON analytics.ai_chat_log TO service_role;

--
-- =============================================================================
-- (2) COLUNAS DE CACHE
-- =============================================================================
-- POR QUE (achado do code review da Fase 2)
-- `usage.input_tokens` da Claude API é apenas o **resto NÃO-cacheado**. O tamanho real do prompt é
-- `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Gravando só o primeiro,
-- duas coisas ficavam impossíveis:
--
--   1. Estimar custo (§10 do doc de arquitetura) — o log subcontabiliza a entrada.
--   2. **Notar um invalidador silencioso do cache.** Alterar a definição das tools entre chamadas
--      do mesmo turno invalida os três níveis de cache e NÃO gera erro nenhum: o único sintoma é
--      `cache_read_input_tokens` zerado e a fatura subindo. O review encontrou exatamente esse
--      defeito (a chamada de fechamento omitia `tools`), e ele teria passado despercebido em
--      produção sem esta coluna.
--
-- Aditiva e idempotente: colunas nullable, sem default, sem backfill (as linhas anteriores são
-- legitimamente desconhecidas — não há valor honesto para atribuir a elas).

ALTER TABLE analytics.ai_chat_log
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens     INTEGER,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER;

COMMENT ON COLUMN analytics.ai_chat_log.cache_read_input_tokens IS
  'Tokens servidos do prompt cache (~0,1x do preço). Zero constante em perguntas repetidas '
  'indica invalidador silencioso do cache.';

COMMENT ON COLUMN analytics.ai_chat_log.cache_creation_input_tokens IS
  'Tokens escritos no prompt cache (~1,25x do preço).';

COMMENT ON COLUMN analytics.ai_chat_log.input_tokens IS
  'Somente o resto NAO-cacheado. Prompt real = input + cache_creation + cache_read.';

-- Sem GRANT novo para as colunas: a escrita continua exclusiva do service_role (o gateway grava a
-- trilha; o usuário auditado só LÊ as próprias linhas, pela policy da 098). Colunas de tabela já
-- existente herdam os privilégios de tabela, então não há resíduo a revogar.
--
-- APLICAÇÃO: aplicada via Supabase MCP em 2026-07-29, em DUAS chamadas — o ledger do Supabase
-- registra `ai_chat_log_cache_tokens` e `ai_chat_log_grant_service_role` para este único arquivo.
-- O ledger nunca foi a fonte de verdade aqui (as migrations aplicadas pelo SQL Editor sequer
-- aparecem nele); a fonte é este diretório numerado. O arquivo inteiro é idempotente — `GRANT`,
-- `ADD COLUMN IF NOT EXISTS` e `COMMENT ON` podem ser reexecutados sem efeito colateral.
