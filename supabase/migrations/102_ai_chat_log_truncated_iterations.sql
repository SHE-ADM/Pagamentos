-- 102_ai_chat_log_truncated_iterations.sql
-- Auditoria do TETO DE ITERAÇÕES no log do chat de IA.
--
-- =============================================================================
-- POR QUE (achado da primeira validação real, 30/07/2026 — §20.9 do doc)
-- =============================================================================
-- A leitura das 5 primeiras interações reais expôs a lacuna. A interação id 6 registrou SEIS
-- chamadas a `gasto_por_fornecedor`, 101 linhas, 30 s e 9.877 tokens de entrada — e o teto do loop
-- do gateway é justamente 6 iterações. Ou seja: essa pergunta pode ter batido no limite e devolvido
-- uma resposta INCOMPLETA, e não havia como saber pelo log.
--
-- Isso morde exatamente onde o §11 do desenho diz que o `ai_chat_log` é a fonte de verdade — "de
-- onde sai quais tools faltam". A pergunta que atinge o teto é a mais informativa (revela a lacuna
-- de ferramentas) E a mais cara (paga N chamadas ao modelo), e era indistinguível de um run limpo
-- que por acaso usou 6 consultas. O `truncated` já existia no `ChatResult` do gateway; só não era
-- persistido.
--
-- `iterations` conta as CHAMADAS AO MODELO DENTRO DO LOOP (não a chamada de fechamento, que é
-- implicada por `truncated = true`). Com as duas colunas, uma consulta responde "quais perguntas
-- estouraram o teto":
--
--   SELECT question, iterations, row_count FROM analytics.ai_chat_log WHERE truncated;
--
-- Aditiva e idempotente: colunas nullable, sem default, sem backfill. As 5 linhas anteriores são
-- legitimamente desconhecidas — inventar `false`/`0` para elas seria afirmar o que não se mediu.

ALTER TABLE analytics.ai_chat_log
  ADD COLUMN IF NOT EXISTS truncated  BOOLEAN,
  ADD COLUMN IF NOT EXISTS iterations SMALLINT;

COMMENT ON COLUMN analytics.ai_chat_log.truncated IS
  'Resposta possivelmente incompleta: teto de iteracoes atingido OU corte por max_tokens. '
  'NULL nas linhas anteriores a esta migration; false em run que falhou (nao ha resposta a cortar).';

COMMENT ON COLUMN analytics.ai_chat_log.iterations IS
  'Chamadas ao modelo dentro do loop de tool use (a de fechamento nao conta). '
  'Igual ao teto do gateway indica pergunta que estourou o limite — candidata a tool nova.';

-- Sem GRANT novo: coluna de tabela existente herda os privilégios de TABELA, e a 101 concedeu
-- `SELECT, INSERT` em `analytics.ai_chat_log` ao `service_role` no nível da tabela (não por
-- coluna). A escrita segue exclusiva dele; o usuário auditado só LÊ as próprias linhas (policy da
-- 098). Nada a revogar.
--
-- APLICAÇÃO: aplicada via psql em 2026-07-30 (Supabase MCP indisponível nesta sessão). Idempotente
-- — `ADD COLUMN IF NOT EXISTS` e `COMMENT ON` podem ser reexecutados sem efeito colateral.
