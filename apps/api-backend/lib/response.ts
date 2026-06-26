// lib/response.ts
// Envelope padrão de resposta da API (monorepo-crud-spec.md).
// Todos os route handlers retornam { success, data?, error?, meta? }.

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

// Mapeia um erro (de service ou inesperado) para Response sem VAZAR detalhe interno:
// erros 4xx (com `status` numérico < 500 — mensagens curadas em pt-BR) ecoam a mensagem;
// 5xx (ou erro sem status) viram uma mensagem genérica e o detalhe vai só para o LOG do
// servidor (evita expor nomes de tabela/coluna/constraint do Postgres ao cliente).
// `tag` identifica o recurso no log.
export function failFromError(e: unknown, tag = 'api'): Response {
  const rawStatus = (e as { status?: unknown } | null)?.status;
  const status = typeof rawStatus === 'number' ? rawStatus : 500;
  const message = e instanceof Error ? e.message : 'Erro inesperado';
  if (status < 500) return fail(message, status);
  console.error(`[${tag}] ${status}:`, message);
  return fail('Erro interno ao processar a solicitação', status);
}
