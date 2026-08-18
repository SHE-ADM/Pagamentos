---
name: chat-ia-gateway
description: >-
  Trabalhar no assistente de IA embarcado do projeto `pagamentos` — o gateway em
  `apps/api-backend/lib/ai-chat/`, as tools de `analytics` (funções SQL SECURITY INVOKER), o
  streaming SSE, o gate de acesso por grupo, o rate limit e o log de auditoria. Cobre os
  invariantes que impedem escalada de privilégio, perda de auditoria e explosão de custo, mais o
  modelo de latência medido em produção. Acione SEMPRE que o usuário disser "chat de IA",
  "assistente", "tool nova", "system prompt", "prompt caching", "ai_chat_log", "analytics",
  "streaming da resposta", "rate limit do chat", ou tocar `lib/ai-chat/` ou o schema `analytics`
  — mesmo sem dizer "skill".
---

# Chat de IA — gateway e camada `analytics`

**Desenho, histórico de cada fase, code reviews e medições:**
[docs/arquitetura-chat-ia-pagamentos.md](../../../docs/arquitetura-chat-ia-pagamentos.md) —
§13 Fase 0 · §16 Fase 1 · §18 Fase 2 · §19 review · §20 Fase 3. **Ler antes de implementar.**

## Mapa

| Camada | Onde |
|---|---|
| Gateway | `apps/api-backend/lib/ai-chat/` — `tools.ts` · `errors.ts` · `gateway.ts` · `log.ts` · `model.ts` · `rate-limit.ts` · `gate.ts` · `session.ts` · `sse.ts` |
| Rotas | `app/api/ai-chat/route.ts` (JSON) · `app/api/ai-chat/stream/route.ts` (SSE) |
| Dados | schema `analytics` (migration 098+) — 2 views + **12 tools** + `ai_chat_log` |
| UI | `organisms/AiChatWidget.tsx` (estado) + `AiChatPanel.tsx` (`lazy`, `<dialog>`) |

⚠️ **São 12 tools, não 6.** A lista viva é `lib/ai-chat/tools.ts`, travada por teste — menções a
"6 funções" no doc descrevem a Fase 1 e valem como histórico.

## Segurança — os quatro invariantes que não se negociam

🔴 **`getAnonClient()` + JWT do usuário no caminho de dados, NUNCA `getSupabaseAdmin`.** É isso
que faz a RLS valer para o chat. Só o **log** usa `service_role`, e é exceção deliberada: deixar
o usuário auditado escrever a própria trilha permitiria omitir a própria pergunta.

🔴 **Views e funções são `SECURITY INVOKER`.** `DEFINER` aqui seria escalada silenciosa — o chat
passaria a ver contas de todo mundo. Provado com usuário real do grupo Comercial: `vw_payables`
**830 → 5**, batendo com o oráculo.

🔴 **`gate.ts` NÃO pode ser fundido ao `rate-limit.ts`** — é a política de falha que os separa:
o gate é AUTORIZAÇÃO e falha **FECHADO**; o rate limit é VOLUME e falha **ABERTO**. Sob um arquivo
só, o refactor natural ("unificar o tratamento de erro dos dois pré-checks") vira bypass de
autorização, sem erro e sem teste vermelho. Falha de consulta do gate lança `Error` **comum**
(500 genérico), nunca `AiChatError` — esta classe significa "mensagem escrita para o usuário ler".

🔴 **O grupo vem de `user_profile`, NUNCA do JWT.** Medido: `raw_app_meta_data->>'group_id'`
existe em 2 dos 13 usuários e nos dois diz `0` enquanto o `user_profile` diz `1` e `7`. Ler o
claim autorizaria e negaria as pessoas erradas **sem levantar erro**.

🔴 **A ORDEM na rota é dependência de DADOS:** `assertWithinRateLimit(user.id, gate)` consome o
retorno do gate. **Chamar o gate e ignorar o retorno COMPILA** (o parâmetro é opcional) e deixa a
cota do grupo **inerte, sem sintoma** — é o defeito mais provável desta área.

🔴 **`assertChatAllowed` é obrigatório em TODA rota de chat**, e vive em `session.ts` — nunca
copiado. O modo de falha da cópia é a rota nova nascer **sem o gate**, entregando recurso pago a
quem não tem direito. Guarda: `tests/test_onda8_gate_ia.py` varre `app/api/ai-chat/**/route.ts`.

**Gate de UI** (`Layout` + `AuthContext.aiChatEnabled`) é **cosmético** e falha **ABERTO** — o
inverso do servidor. `null` = "ainda não sei" e não monta o widget; `=== true`, nunca `!== false`.
🔴 O embed to-one é **normalizado nas duas pontas** (objeto **ou** array): a forma é propriedade da
VERSÃO do supabase-js, e lendo só objeto o botão sumiria da tela inteira, sem erro.

## Auditoria — perder o log é perder o produto

🔴 **Log gravado ANTES de responder e AGUARDADO.** Em serverless a function é **congelada** no
`return`, então `void gravarLog()` depois dele simplesmente não roda — e nada acusa a perda.
A pergunta que **falhou** também é auditada: é dela que sai "quais tools faltam".

🔴 **O mapeamento de colunas é travado por teste** (`log.test.ts` × migrations 098/101/102/129):
como `logInteraction` **nunca lança**, um nome de coluna errado deixaria a auditoria **morta em
produção** sem erro, sem teste vermelho e sem log.

🔴 **O log registra os QUATRO campos de token + o MODELO servido** (`response.model`, migration
129). `usage.input_tokens` é só o **resto não-cacheado**; sem `cache_read_input_tokens` não há
como notar um invalidador silencioso do cache, que não gera erro — só zera o número e aumenta a
fatura. É o modelo **servido**, não o pedido: com fallback server-side, o pedido registraria quem
**não** respondeu.

🔴 **A falha leva o estado parcial até a auditoria** (`attachPartialRun`), e ela **engole a própria
falha** — chamada dentro do `throw`, uma exceção ali substituiria o erro traduzido.

## Custo e latência — o modelo medido em produção

> **latência ≈ 3,9 s fixos + ~10 ms por token de SAÍDA**

Isso derruba as três explicações intuitivas: **não é o banco** (tools em 44–230 ms, 0,4% do
turno), **não é o input** (processar entrada é paralelo; gerar saída é sequencial) e **não é cold
start** (~1 s). Trocar de modelo move 9%, não 2–3×.

🔴 **Daí o teto de 15 linhas no SYSTEM_PROMPT.** Um caso real trouxe 167 linhas, gerou 4.970
tokens e levou 53 s. Depois do teto: **25,1 s (−53%)**, 2.102 tokens. ⚠️ **O teto vale para a
LISTAGEM, nunca para a RESSALVA** — cobertura, balde parcial e `total_encontrado` valem mais que
a tabela inteira. A guarda de `regression.test.ts` trava as **duas** metades.

🔴 **Trocar `ANTHROPIC_MODEL` pode desligar o prompt caching EM SILÊNCIO** — o mínimo de prefixo
cacheável varia por modelo e **não é monotônico entre gerações** (512 no Opus 5, 1.024 no Sonnet
5, 4.096 no Opus 4.6 e Haiku 4.5). Abaixo do mínimo o `cache_control` é ignorado sem erro. Quem
vigia é `warnIfCachingDisabled`, a cada turno. Conferência atribuível:

```sql
SELECT model, count(*), sum(cache_read_input_tokens) FROM analytics.ai_chat_log GROUP BY 1;
```

🔴 **`CONFIGURED_MODEL` vive em `lib/ai-chat/model.ts`, não no gateway** — configuração não fica
refém do mock de um módulo de comportamento. E o **default espelha o que roda de fato**: um
default que nenhum ambiente usa só entra em cena por esquecimento da env var, trocando o modelo em
silêncio. ⚠️ **Nunca asserte um literal de modelo em teste** — compare com `CONFIGURED_MODEL`.

⚠️ **Acrescentar tool invalida os 3 níveis de cache** e engorda o prefixo (~1,2k tokens/tool:
3.653 com 6 tools → 7.408 com 9). Por isso a lista é travada por teste.

## Loop e transporte

- **Teto de 6 iterações**; ao atingi-lo, uma chamada final com `tool_choice: none` **e as tools
  ainda presentes** — remover o array é mudança de DEFINIÇÃO, que invalida o cache justamente na
  chamada de histórico mais longo.
- **Tool calls paralelos voltam em UMA mensagem `user`**; falha de tool vira `tool_result` com
  `is_error`, nunca bloco omitido (quebraria o pareamento).
- **A data de hoje vai na MENSAGEM, não no system prompt** — no bloco cacheado o prefixo mudaria a
  cada requisição e o caching nunca acertaria, silenciosamente.
- **Teto de 60 KB por resultado de tool, cortado POR REGISTRO** — JSON partido ao meio é ilegível.
  Quando um registro estoura sozinho, corta e **DECLARA** (`JSON CORTADO`).
- **`export const maxDuration = 300`** — o default da Vercel (10–15 s) mata um loop de 2–3
  iterações que funciona em dev.
- **401/400 do SDK NÃO são traduzidos** (viram 500 + log): são erro de configuração **nosso**. Só
  se traduz o que o usuário pode agir — 429, 5xx do provedor (→503) e timeout.

**SSE:** 🔴 **duas rotas, UM só loop** — o streaming é observação lateral (`ChatProgress`), nunca
um segundo loop. Duplicar criaria duas cópias do teto, do pareamento e da tradução de erro.
🔴 **Fronteira do status HTTP:** o que pode ser recusado **antes** do corpo abrir (401/400/422/403/
429) é recusado com JSON e status — por isso `assertChatAllowed` fica **fora** do `ReadableStream`.
🔴 **`SseWriter` nunca lança** (`controller.enqueue` lança quando o cliente fechou — o caminho
normal de "Parar"), senão o turno abortaria pulando a auditoria.
🔴 **Stream sem `done` NÃO promove o texto parcial a resposta** — o `answer` vai para o histórico
da pergunta seguinte, e truncado envenenaria a conversa em silêncio.
🔴 **Fallback estreito:** só cai para JSON em **404** e em **200 sem `text/event-stream`**; 403/429/
5xx sobem como erro (reenviar cobraria dois turnos).

## Camada `analytics` — regras de tool nova

🔴 **`REVOKE EXECUTE ... FROM PUBLIC` é obrigatório** (o PostgreSQL concede a PUBLIC por default).
🔴 **Despacho de parâmetro por `CASE` + `IN (...)`, nunca SQL dinâmico**; valor fora do domínio
devolve **vazio** em vez de agregar errado.
🔴 **Toda função com `LIMIT` DECLARA o total** (`count(*) OVER ()` — janela, nunca subconsulta,
que herdaria o `LIMIT`). Truncar é indistinguível de "acabou": `fornecedores_recorrentes` devolvia
50 de 63 com HTTP 200. **5ª ocorrência da mesma armadilha.**
🔴 **`ORDER BY` + `LIMIT` exige ordem TOTAL** — sem desempate único o conjunto truncado varia com
o plano, e o ranking "muda sozinho".
🔴 **Função que agrupa por período DECLARA o balde parcial** (`is_partial`, `days_covered`) — o
número está certo, e a ausência da ressalva faz o leitor concluir o oposto.
🔴 **`cancelado` (id 9) fora dos totais**; "em aberto" é `status_id IN (1,2,3)`; **aging é por
`due_date < CURRENT_DATE`**, nunca pelo rótulo `status_name`.
🔴 **`gasto_por_fornecedor` é RANKING TRUNCADO — somar suas linhas NÃO dá o total.**
🔴 **Âncora de teste não pode ser número absoluto** — o dado deriva em 24 h.

## Decisões que não devem ser reabertas

- **PostgREST + JWT do usuário**, não uma role `ai_readonly` (não casaria policy alguma).
- **Tools são FUNÇÕES SQL (RPC)**, não views filtradas — o PostgREST só agrega com
  `db-aggregates-enabled`, desligado por padrão no Supabase.
- **`generate_sql` (text-to-SQL) ADIADO** — maior vetor de risco.
- **Sem tabelas agregadas / materialized view** — reconfirmado em 2026-08-14 com 12 tools.
  Gatilho para reabrir: alguma tool passar de **~500 ms** warm.
- **Sem vetores/RAG no núcleo analítico** (ADR-001) — o cálculo é determinístico sobre linhas.
- **DRE completo descartado** (0 receitas); o substituto é `demonstrativo_despesas`.

## Configuração

🔴 **A `ANTHROPIC_API_KEY` do `.env` da RAIZ não vale para a Next API** — o Next carrega env do
diretório do próprio app: `apps/api-backend/.env.local`. Até 2026-07-30 ela só existia na raiz, e
por isso a rota devolvia 500 **em dev também**.

**`analytics` precisa estar exposto no PostgREST** (Data API → Exposed schemas). `PGRST106
Invalid schema` significa que a exposição foi desfeita.
🔴 **Em RPC o header é `Content-Profile`, não `Accept-Profile`** — com o segundo, a função é
procurada em `public` e a resposta é `PGRST202`, que aponta para o lugar errado.
