// lib/ai-chat/log.ts
// Trilha de auditoria do chat (analytics.ai_chat_log, migration 098).
//
// POR QUE NÃO É "ASSÍNCRONO" (§17.3 — não regredir)
// O desenho original dizia "logar de forma assíncrona". Em serverless isso NÃO FUNCIONA: a
// function é CONGELADA assim que a resposta é retornada, então um `void gravarLog()` disparado
// depois do `return` simplesmente não roda. O log é o pilar 3 do desenho (auditoria) e a fonte
// para descobrir quais tools faltam (§11) — perdê-lo silenciosamente seria o pior dos mundos,
// porque nada acusaria a perda.
//
// Aqui o log é gravado ANTES de responder e aguardado. O custo é uma ida ao banco (~30-80 ms)
// numa requisição que já levou segundos conversando com o modelo — irrelevante. Se um dia isso
// pesar, a alternativa correta é `waitUntil` da Vercel, nunca fire-and-forget.
//
// POR QUE service_role AQUI, se o resto do chat usa o JWT do usuário
// Exceção deliberada e estreita (§4.6): o princípio "sem service_role" veda o acesso a DADO DE
// NEGÓCIO. Deixar o usuário auditado escrever a própria trilha de auditoria seria pior — ele
// poderia omitir a própria pergunta. A policy da 098 permite que ele LEIA apenas as próprias
// linhas; escrever, só o servidor.

import { getSupabaseAdmin } from '../supabase-admin';
import { ANALYTICS_SCHEMA } from './tools';

/** Uma tool executada no turno, como gravada em `tool_calls` (jsonb). */
export interface LoggedToolCall {
  name: string;
  params: Record<string, unknown>;
  rows: number;
  ms: number;
  error?: string;
}

// Contrato de entrada de logInteraction — consumido pela rota via inferência.
// ts-prune-ignore-next
export interface ChatLogEntry {
  userId: string;
  question: string;
  toolCalls: LoggedToolCall[];
  rowCount: number;
  latencyMs: number;
  /** Só o resto NÃO-cacheado (semântica da API) — ver `cacheReadTokens`. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens servidos do cache. É o único sinal de que o prompt caching está funcionando: um
   * invalidador silencioso (ex.: mudar a definição das tools entre chamadas do mesmo turno) não
   * gera erro nenhum — zera este número e a conta sobe. Sem registrá-lo, não há como notar.
   */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  error?: string;
}

/**
 * Grava a interação. **Nunca lança**: uma falha ao auditar não pode derrubar uma resposta que já
 * foi produzida com sucesso — seria trocar um problema de observabilidade por um de
 * disponibilidade. A falha vai para o `console.error`, onde a plataforma a coleta.
 */
export async function logInteraction(entry: ChatLogEntry): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .schema(ANALYTICS_SCHEMA)
      .from('ai_chat_log')
      .insert({
        user_id: entry.userId,
        question: entry.question,
        tool_calls: entry.toolCalls,
        row_count: entry.rowCount,
        latency_ms: entry.latencyMs,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cache_read_input_tokens: entry.cacheReadTokens,
        cache_creation_input_tokens: entry.cacheCreationTokens,
        error: entry.error ?? null,
      });
    if (error) console.error('[ai-chat] falha ao gravar ai_chat_log:', error.message);
  } catch (e) {
    console.error(
      '[ai-chat] falha ao gravar ai_chat_log:',
      e instanceof Error ? e.message : String(e),
    );
  }
}
