// lib/response.ts
// Envelope padrão de resposta da API (monorepo-crud-spec.md).
// Todos os route handlers retornam { success, data?, error?, meta? }.

import { ApiServiceError } from './api-error';

// Contratos públicos do envelope — exportados por convenção (consumidos via
// inferência de `ok`/`fail`), por isso marcados ts-prune-ignore.
// ts-prune-ignore-next
export interface ApiResponseMeta {
  total?: number;
  page?: number;
  limit?: number;
}

// ts-prune-ignore-next
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: ApiResponseMeta;
}

// `status` permite 201 (criação) sem quebrar chamadas existentes (default 200).
export function ok<T>(data: T, meta?: ApiResponseMeta, status = 200): Response {
  return Response.json({ success: true, data, meta } satisfies ApiResponse<T>, { status });
}

export function fail(error: string, status = 400): Response {
  return Response.json({ success: false, error } satisfies ApiResponse, { status });
}

// Mapeia um erro (de service ou inesperado) para Response sem VAZAR detalhe interno.
//
// A REGRA É SOBRE A ORIGEM DO ERRO, NÃO SOBRE O SEU FORMATO (não regredir):
// só ecoa a mensagem quando o erro é um `ApiServiceError` — a base que o NOSSO código usa para
// mensagens curadas em pt-BR — e o status é < 500. Qualquer outra coisa vira mensagem genérica,
// com o detalhe indo só para o LOG do servidor.
//
// Antes, o teste era duck-typing (`typeof e.status === 'number' && status < 500`), o que ecoava
// verbatim os erros de bibliotecas de terceiros que também carregam `status` — `AuthError` (400,
// "Invalid login credentials") e `StorageApiError` (404, "Object not found") do Supabase, e os
// erros do `@anthropic-ai/sdk` (429/401/400) que a Fase 2 vai encontrar. Ver o cabeçalho de
// `lib/api-error.ts` para o raciocínio completo e §17.9 do doc de arquitetura do chat.
//
// `tag` identifica o recurso no log.
export function failFromError(e: unknown, tag = 'api'): Response {
  if (e instanceof ApiServiceError) {
    // Mensagem deliberadamente escrita para o usuário: pode ir ao cliente.
    //
    // `clientSafe` estende esse eco a um 5xx marcado explicitamente (ver lib/api-error.ts). Sem
    // ele, as 503 curadas do chat de IA — "o assistente está indisponível", timeout, falha de rede
    // — perdiam o texto e chegavam como "Erro interno", indistinguíveis de um bug nosso. O 5xx
    // NÃO-marcado continua virando mensagem genérica, com o detalhe só no log: a marca é opt-in.
    if (e.status < 500 || e.clientSafe) {
      // 🔴 O eco resolve o que o USUÁRIO lê; não resolve o que o OPERADOR precisa ver. Um 5xx
      // marcado continua sendo falha de servidor, e sem esta linha ele saía daqui sem deixar
      // rastro nenhum no log da function: uma indisponibilidade do provedor atingiria todo mundo
      // em silêncio. Hoje o único consumidor da marca grava a própria trilha (`ai_chat_log`), mas
      // isso é acidente do consumidor, não garantia do helper — e a marca é opt-in justamente
      // para ser reusada. O 4xx segue sem log: ali o "erro" é do pedido, não do servidor.
      if (e.status >= 500) console.error(`[${tag}] ${e.status} (curado, ecoado):`, e.message);
      return fail(e.message, e.status);
    }
    console.error(`[${tag}] ${e.status}:`, e.message);
    return fail('Erro interno ao processar a solicitação', e.status);
  }
  // Erro não curado (bug nosso, ou de terceiro): status honesto é 500 e a mensagem não sai daqui.
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[${tag}] 500 (erro não curado):`, detail);
  return fail('Erro interno ao processar a solicitação', 500);
}
