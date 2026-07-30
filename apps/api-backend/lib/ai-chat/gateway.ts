// lib/ai-chat/gateway.ts
// Orquestrador do chat: monta o contexto, roda o loop de tool use com a Claude API e executa as
// tools contra o schema `analytics` com o JWT do usuário.
//
// NÃO é Repository → Service → Route (§17.7). Os CRUDs seguem aquele padrão porque são RECURSOS;
// isto é uma máquina de estados. Forçá-lo no molde de CRUD produziria um "service" que é só um
// loop, e o que precisa ser testável isoladamente (definição das tools, tradução de erro, log)
// já está em arquivos próprios.

import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TOOL_DEFINITIONS, isToolName, parseToolInput, runTool } from './tools';
import { AiChatAbortedError, attachPartialRun, translateAnthropicError } from './errors';
import type { LoggedToolCall } from './log';

/**
 * O modelo padrão do projeto. Configurável por env para permitir troca sem deploy de código.
 *
 * ATENÇÃO AO TROCAR: o prompt caching tem um tamanho MÍNIMO de prefixo que varia por modelo, e
 * abaixo dele o `cache_control` é ignorado **em silêncio** — sem erro, só `cache_read` zerado e a
 * conta subindo. Medido aqui: system + tools ≈ **2.175 tokens**, confortável para o mínimo de 512
 * do Opus 5, mas ABAIXO do mínimo de 4.096 do Opus 4.6 e do Haiku 4.5. Trocar para um desses
 * desliga o cache sem nenhum sintoma além do custo. Confira `cache_read_input_tokens` em
 * `analytics.ai_chat_log` depois de qualquer troca de modelo.
 */
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

/**
 * Teto de iterações do loop (§17.2 — não remover).
 *
 * Sem ele, um modelo que se convença de precisar de "mais uma consulta" itera até a function
 * morrer por timeout, com custo proporcional — e o "limite de custo por sessão" prometido no §8
 * não existiria de fato. 6 é folgado para o uso real (um agregado + um drill-down são 2), e
 * atingi-lo é resposta honesta, não exceção.
 */
const MAX_ITERATIONS = 6;

/**
 * Teto de saída por turno. Cobre thinking + texto: no Opus 5 o thinking está LIGADO por padrão e
 * consome deste orçamento (§17.5). Dimensionar apertado trunca a resposta no meio.
 */
const MAX_TOKENS = 8192;

/** Timeout da chamada ao modelo. Menor que o `maxDuration` da rota, para o erro ser nosso. */
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 120_000);

/**
 * Usado quando o turno termina sem nenhum bloco de texto — acontece se o corte por `max_tokens`
 * cai dentro do raciocínio. Devolver string vazia daria um balão em branco na tela.
 */
const SEM_RESPOSTA = 'Não consegui formular uma resposta. Tente reformular a pergunta.';

/**
 * As tools no formato da API, montadas UMA vez. A ordem e o conteúdo precisam ser idênticos entre
 * as chamadas do mesmo turno: reordenar ou alterar definição invalida os três níveis de cache.
 */
const toolParams: Anthropic.ToolUnion[] = TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
}));

// Contrato de entrada/saída de runChat — consumido pela rota via inferência.
// ts-prune-ignore-next
export interface ChatRequest {
  question: string;
  /** Histórico curto (pares user/assistant já normalizados). */
  history?: { role: 'user' | 'assistant'; content: string }[];
}

// ts-prune-ignore-next
export interface ChatResult {
  answer: string;
  toolCalls: LoggedToolCall[];
  rowCount: number;
  /**
   * ATENÇÃO: `input_tokens` da API é só o **resto não-cacheado**. O tamanho real do prompt é
   * `inputTokens + cacheCreationTokens + cacheReadTokens` — por isso os três são registrados.
   * Sem `cacheReadTokens` não há como notar um invalidador silencioso do cache, que não produz
   * erro nenhum: só a conta subindo.
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** true quando a resposta pode estar incompleta: teto de iterações OU corte por `max_tokens`. */
  truncated: boolean;
}

let client: Anthropic | null = null;

function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY não configurada no ambiente do servidor');
  }
  // Lazy + cacheado pelo mesmo motivo de getAnonClient: não lançar durante o build.
  client ??= new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  return client;
}

/**
 * Bloco ESTÁVEL do contexto: instruções + dicionário de dados. É o alvo do prompt caching.
 *
 * A DATA DE HOJE NÃO ENTRA AQUI (§17.4 — não regredir). Perguntas como "quanto paguei este mês"
 * exigem que o modelo saiba a data corrente, e a tentação é colocá-la no dicionário. Se ela
 * entrar neste bloco, o prefixo muda a cada requisição e NADA cacheia — silenciosamente, sem
 * erro. A data vai na mensagem do usuário, depois do último breakpoint.
 */
const SYSTEM_PROMPT = `Você é um assistente de análise financeira do sistema de contas a pagar da Otimotex.
Responde perguntas sobre contas a pagar consultando o banco através das ferramentas disponíveis.

## Regras de resposta

- Responda SEMPRE em português do Brasil, de forma direta e objetiva.
- Valores monetários em reais, formato brasileiro: R$ 1.234,56.
- Use as ferramentas para obter números. NUNCA invente ou estime valores.
- Se as ferramentas não conseguirem responder, diga isso claramente em vez de aproximar.
- Ao apresentar vários itens, prefira uma tabela markdown enxuta.
- Não repita o número que acabou de mostrar em prosa logo depois; comente o que ele significa.

## Dicionário de dados

**Situações** (10): pendente, vencido, a vencer, prorrogado, baixado, protestado, cartório,
pago, cancelado, falha.
- "Em aberto" = pendente + vencido + a vencer.
- **cancelado fica FORA de todos os totais por padrão** (mesma convenção da tela /consulta).
- O rótulo "vencido" é atualizado por um batch diário e fica DEFASADO. Para "o que está
  vencido", use \`aging_vencidos\` ou os campos overdue_* de \`resumo_situacao\`, que calculam
  pela data de vencimento.

**Empresas pagadoras** (sk_company): 1 = OTIMOTEX TECIDOS, 2 = LEBIANCO, 3 = OTIMOTEX FARDOS.
A empresa pagadora é INDEPENDENTE do fornecedor — pode existir conta da LEBIANCO cujo fornecedor
é a OTIMOTEX. Nunca infira uma a partir da outra.

**Datas**: vencimento (due_date), pagamento (payment_date, quando a conta foi baixada) e
emissão (issue_date). Para "quanto paguei", use pagamento; para "quanto tenho a pagar",
vencimento.

**Classificação contábil**: centro de custo, plano de contas, grupo e subgrupo. O id 0 significa
"não informado" — aparece como tal nos resultados.

## Visibilidade

Você enxerga exatamente as contas que este usuário já veria pela tela — nem mais, nem menos.
Se um resultado vier vazio, pode ser filtro sem correspondência OU ausência de permissão; não
especule sobre dados que não vieram.`;

/**
 * Teto de caracteres de UM resultado devolvido ao modelo.
 *
 * `listar_contas` com `limit=100` e as agregações por fornecedor produzem dezenas de KB, e cada
 * iteração reenvia TODO o histórico — sem teto, uma pergunta com 3 consultas grandes infla o
 * contexto quadraticamente e o custo junto.
 */
const MAX_TOOL_RESULT_CHARS = 60_000;

/** Converte o resultado da tool em texto para o modelo, com teto de tamanho. */
function toolResultText(rows: unknown[]): string {
  if (rows.length === 0) return 'Nenhum registro encontrado para este filtro.';

  const full = JSON.stringify(rows);
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full;

  // Corta por REGISTRO, nunca no meio do JSON: uma string cortada ao meio é ilegível para o
  // modelo, que tentaria interpretar o fragmento como dado.
  let kept = rows.length;
  let text = full;
  while (kept > 1 && text.length > MAX_TOOL_RESULT_CHARS) {
    kept = Math.floor(kept / 2);
    text = JSON.stringify(rows.slice(0, kept));
  }

  // UM único registro pode estourar o teto sozinho (`additional_info` é TEXT sem limite no banco).
  // Aí não existe corte "por registro": ou se devolve o registro inteiro — furando justamente o
  // teto que protege o contexto — ou se corta a string. Cortar é o certo, desde que se DIGA que o
  // JSON ficou partido; caso contrário o modelo lê o fragmento final como se fosse dado.
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[JSON CORTADO no meio de um registro grande `
      + 'demais. Peça um recorte menor ou use um agregado em vez do detalhe.]';
  }

  return `${text}\n\n[Resultado truncado: ${kept} de ${rows.length} registros. Refine o filtro `
    + 'ou use um período menor para ver o restante.]';
}

/**
 * Roda o loop de tool use até o modelo parar de pedir ferramentas.
 *
 * @param supabase Cliente ANON (nunca service_role) — é o que faz a RLS valer.
 * @param token    JWT do usuário, repassado a cada RPC.
 * @param signal   Aborta o run quando o cliente desiste (`request.signal` da rota). Sem ele o
 *   loop segue gastando tokens numa resposta que ninguém vai receber — ver o comentário de
 *   `throwIfAborted`.
 */
export async function runChat(
  supabase: SupabaseClient,
  token: string,
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const anthropic = getAnthropic();
  const toolCalls: LoggedToolCall[] = [];
  // Acumulador único: com dois pontos de soma (loop e fechamento), somar campo a campo em cada um
  // é o tipo de duplicação que passa a divergir na primeira alteração.
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const accumulate = (u: Anthropic.Usage) => {
    usage.inputTokens += u.input_tokens;
    usage.outputTokens += u.output_tokens;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
  };
  let rowCount = 0;

  // A data corrente vai AQUI (na mensagem), não no system prompt — ver SYSTEM_PROMPT.
  const hoje = new Date().toISOString().slice(0, 10);

  const messages: Anthropic.MessageParam[] = [
    ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: `[Data de hoje: ${hoje}]\n\n${req.question}` },
  ];

  let truncated = false;

  try {
    for (let iteration = 0; ; iteration += 1) {
      // Checagem no LIMITE de cada iteração: é aqui que o run custa dinheiro. Um usuário que
      // clicou em "Parar" (ou fechou a aba) na 1ª de 3 iterações economiza as outras duas — sem
      // isto, o cliente desconecta e o servidor segue conversando com o modelo até o fim, cobrando
      // por uma resposta que ninguém vai ler.
      throwIfAborted(signal);

      if (iteration >= MAX_ITERATIONS) {
        truncated = true;
        break;
      }

      // `.stream()` + `.finalMessage()`, não `.create()` (§17.8): a resposta que chega ao cliente
      // é a mesma (JSON único), mas o socket recebe tokens continuamente em vez de ficar ocioso —
      // é o que evita timeout de request/proxy num turno longo, e é o ponto de onde a Fase 3
      // puxará o texto parcial para a tela.
      const response = await anthropic.messages
        .stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            // cache_control no bloco estável: só o system+tools é cacheado; a pergunta (volátil)
            // vem depois e não invalida o prefixo.
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            tools: toolParams,
            messages,
          },
          // O signal também vai à chamada EM VOO: sem ele o abort só seria notado na próxima
          // iteração, e um turno longo continuaria streamando até terminar.
          { signal },
        )
        .finalMessage();

      accumulate(response.usage);

      // Preserva a resposta INTEIRA (inclui os blocos tool_use) — extrair só o texto quebraria
      // o pareamento tool_use/tool_result na próxima iteração.
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        // `max_tokens` também cai aqui: o turno terminou, mas o texto foi CORTADO no meio. Tratá-lo
        // como resposta completa entregaria uma frase pela metade sem nenhum sinal ao usuário.
        return {
          answer: extractText(response.content) || SEM_RESPOSTA,
          toolCalls,
          rowCount,
          ...usage,
          truncated: response.stop_reason === 'max_tokens',
        };
      }

      // Tool calls PARALELOS voltam em UMA única mensagem user (§17.6). Dividi-los em mensagens
      // separadas ensina o modelo a parar de paralelizar.
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const started = Date.now();

        if (!isToolName(block.name)) {
          results.push(errorResult(block.id, `Ferramenta desconhecida: ${block.name}`));
          toolCalls.push({ name: block.name, params: {}, rows: 0, ms: 0, error: 'desconhecida' });
          continue;
        }

        const parsed = parseToolInput(block.name, block.input);
        if (!parsed.ok) {
          results.push(errorResult(block.id, parsed.message));
          toolCalls.push({
            name: block.name, params: {}, rows: 0,
            ms: Date.now() - started, error: parsed.message,
          });
          continue;
        }

        try {
          const rows = await runTool(supabase, token, block.name, parsed.params);
          rowCount += rows.length;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultText(rows) });
          toolCalls.push({
            name: block.name, params: parsed.params,
            rows: rows.length, ms: Date.now() - started,
          });
        } catch (e) {
          // Falha da tool volta ao modelo como tool_result com is_error (§17.6) — nunca omitir o
          // bloco, que quebraria o pareamento. O detalhe fica no log, não vai ao modelo.
          const detalhe = e instanceof Error ? e.message : String(e);
          console.error(`[ai-chat] tool ${block.name} falhou:`, detalhe);
          results.push(errorResult(block.id, 'A consulta falhou. Tente outra abordagem.'));
          toolCalls.push({
            name: block.name, params: parsed.params, rows: 0,
            ms: Date.now() - started, error: detalhe,
          });
        }
      }

      messages.push({ role: 'user', content: results });
    }

    // Saiu por MAX_ITERATIONS: pede uma resposta final SEM tools, para o usuário receber o que já
    // foi apurado em vez de um erro seco. Fica DENTRO do try — um 429 nesta chamada precisa da
    // mesma tradução das demais, senão vira 500 genérico justamente na pergunta mais cara.
    const fechamento = await anthropic.messages
      .stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        // As tools vão JUNTO, com `tool_choice: none` — não basta omiti-las (não regredir).
        // Remover o array `tools` é uma mudança de DEFINIÇÃO de tool, que invalida os três níveis
        // de cache (tools + system + messages): o fechamento é a chamada com o histórico mais
        // longo, e pagaria prefixo cheio justamente aí. Trocar só o `tool_choice` preserva o
        // cache. De quebra, o histórico contém blocos `tool_use`, que a API espera acompanhados
        // da definição das tools.
        tools: toolParams,
        tool_choice: { type: 'none' },
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Você atingiu o limite de consultas para esta pergunta. Responda agora com o que já '
              + 'apurou, deixando claro o que ficou sem verificar.',
          },
        ],
      }, { signal })
      .finalMessage();
    accumulate(fechamento.usage);

    return {
      answer: extractText(fechamento.content) || SEM_RESPOSTA,
      toolCalls,
      rowCount,
      ...usage,
      truncated,
    };
  } catch (e) {
    // Anexa o que JÁ foi gasto e apurado. Sem isso, uma falha na 5ª iteração é auditada como
    // "0 tokens, 0 tools" — some justamente o registro das perguntas caras que falharam, que é a
    // fonte para descobrir quais tools faltam (§11) e para não subestimar o custo real.
    //
    // Quem decide se foi aborto é o SIGNAL, não o tipo do erro — ver o comentário de
    // `AiChatAbortedError`. Se o cliente já desistiu, o que o SDK levantou é consequência disso, e
    // traduzir viraria 500 genérico ("erro interno"), auditando um cancelamento como falha do
    // assistente e poluindo a fonte que serve para achar o que está realmente quebrado. O estado
    // parcial vai junto: cancelar não devolve os tokens já gastos, e a auditoria de custo os quer.
    const erro = signal?.aborted ? new AiChatAbortedError() : translateAnthropicError(e);
    throw attachPartialRun(erro, { ...usage, toolCalls, rowCount });
  }
}

/**
 * Levanta `AiChatAbortedError` se o cliente já desistiu.
 *
 * NÃO propaga o signal para as RPCs de `runTool` — decisão deliberada: uma consulta abortada
 * apareceria dentro do `catch` por tool, que por contrato converte falha em `tool_result` com
 * `is_error` e SEGUE o loop (§17.6). Distinguir abort ali criaria um segundo caminho de
 * cancelamento, meio-tratado, para uma chamada que leva milissegundos — enquanto esta checagem, no
 * limite da iteração, pega o mesmo abort imediatamente depois e para o loop de verdade.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiChatAbortedError();
}

function errorResult(id: string, message: string): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content: message, is_error: true };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
