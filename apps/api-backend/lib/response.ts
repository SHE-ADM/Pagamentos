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
