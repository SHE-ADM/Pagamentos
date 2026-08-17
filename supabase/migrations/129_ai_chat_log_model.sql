-- 129_ai_chat_log_model.sql
-- Qual MODELO serviu cada turno do chat de IA.
--
-- =============================================================================
-- POR QUE (análise de 15/08/2026)
-- =============================================================================
-- O `ai_chat_log` registrava latência, os quatro campos de token, `truncated` e `iterations` — tudo
-- menos QUEM produziu a linha. A lacuna apareceu ao tentar responder uma pergunta simples: "trocar
-- de modelo mudou a latência?".
--
-- A base já continha DUAS populações — os turnos até 10/08 rodaram `claude-opus-5`, os de 14/08 em
-- diante rodaram `claude-sonnet-5` — e a única forma de separá-las era cruzar o log com a lembrança
-- de quando a env var mudou. Isso é INFERÊNCIA, não registro, e ela falha de três jeitos:
--
--   1. Morre em silêncio assim que alguém troca `ANTHROPIC_MODEL` sem anotar a data.
--   2. Não separa dois modelos que rodaram no MESMO dia — o que acontece sempre que dev e produção
--      apontarem para modelos diferentes, ainda que por algumas horas. Nada no sistema impede isso:
--      o modelo é env var lida na carga do módulo, com default embutido em `gateway.ts`.
--   3. Produz uma resposta confiante e não-falsificável. Quem consultar o log daqui a seis meses
--      não tem como saber que a atribuição foi deduzida.
--
-- Trocar de modelo é operação rotineira aqui (o CLAUDE.md tem um 🔴 inteiro sobre o efeito disso no
-- prompt caching), então a lacuna se repetiria a cada troca. É a mesma classe que a 101 (tokens de
-- cache) e a 102 (`truncated`/`iterations`) fecharam: um número que já existe no processo e não era
-- persistido, cuja ausência não gera erro nenhum — só uma análise que chega à conclusão errada.
--
-- Estado em 15/08/2026, para registro: dev e produção (Vercel) rodam ambos `claude-sonnet-5`. Não há
-- divergência hoje; o que esta coluna elimina é a impossibilidade de PROVAR isso pelo dado.
--
-- =============================================================================
-- O QUE É GRAVADO: o modelo SERVIDO, não o pedido
-- =============================================================================
-- O gateway grava `response.model` (o que a API respondeu ter usado), não a string de
-- `ANTHROPIC_MODEL`. São coisas diferentes por três motivos, e todos favorecem o servido:
--
--   1. ALIAS — `claude-sonnet-5` é um alias que a API resolve; o servido é a verdade do faturamento.
--   2. FALLBACK — se um dia o `fallbacks` server-side for adotado, um turno recusado é reexecutado
--      em OUTRO modelo e responde 200. O pedido continuaria dizendo o modelo que recusou.
--   3. CONFIG — o pedido é o que se pretendia; o servido é o que aconteceu. Auditoria quer o 2º.
--
-- Quando NENHUMA chamada ao modelo chegou a responder (falha de rede na 1ª iteração, cancelamento
-- antes do primeiro token), não há servido — aí o gateway grava o CONFIGURADO. É a melhor informação
-- disponível e mantém a coluna sempre preenchida, o que dá à ausência um significado único:
--
--   🔴 `model IS NULL` significa EXCLUSIVAMENTE "linha anterior a esta migration". Nunca "não sei".
--
-- Sem essa garantia, todo agregado por modelo teria de decidir o que fazer com nulos ambíguos.
--
-- =============================================================================
-- SEM BACKFILL — deliberado
-- =============================================================================
-- As 42 linhas anteriores ficam NULL. Preenchê-las por data reproduziria no banco a mesma inferência
-- que esta migration existe para eliminar, e com o agravante de virar dado de aparência autoritativa:
-- ninguém que consultasse a coluna depois saberia que aqueles valores foram deduzidos, não medidos.
-- Mesma decisão da 102 ("inventar `false`/`0` seria afirmar o que não se mediu").
--
-- Consulta que a coluna habilita — a comparação que hoje não é possível fazer com honestidade:
--
--   SELECT model, count(*), round(avg(latency_ms)) AS lat, round(avg(output_tokens)) AS saida,
--          round(regr_slope(latency_ms, output_tokens)::numeric, 2) AS ms_por_token
--   FROM analytics.ai_chat_log WHERE error IS NULL AND model IS NOT NULL GROUP BY 1;

ALTER TABLE analytics.ai_chat_log
  ADD COLUMN IF NOT EXISTS model TEXT;

COMMENT ON COLUMN analytics.ai_chat_log.model IS
  'Modelo que SERVIU o turno (response.model). Cai para o configurado (ANTHROPIC_MODEL) quando '
  'nenhuma chamada chegou a responder. NULL significa apenas linha anterior a esta migration.';

-- Sem GRANT novo: coluna de tabela existente herda os privilégios de TABELA, e a 101 concedeu
-- `SELECT, INSERT` em `analytics.ai_chat_log` ao `service_role` no nível da tabela (não por coluna).
-- A escrita segue exclusiva dele; o usuário auditado só LÊ as próprias linhas (policy da 098).
--
-- Sem índice: a tabela tem 42 linhas e cresce ~30/dia; um índice por modelo custaria mais manutenção
-- do que o seq scan que ele evitaria. Reavaliar se o log passar de ~100k linhas.
--
-- APLICAÇÃO: aplicada via psql em 2026-08-15 (Supabase MCP indisponível nesta sessão). Idempotente —
-- `ADD COLUMN IF NOT EXISTS` e `COMMENT ON` podem ser reexecutados sem efeito colateral.
