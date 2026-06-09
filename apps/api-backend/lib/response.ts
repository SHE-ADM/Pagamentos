// lib/response.ts
// Envelope padrão de resposta da API (monorepo-crud-spec.md).
// Todos os route handlers retornam { success, data?, error?, meta? }.

export interface ApiResponseMeta {
  total?: number;
  page?: number;
  limit?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: ApiResponseMeta;
}

export function ok<T>(data: T, meta?: ApiResponseMeta): Response {
  return Response.json({ success: true, data, meta } satisfies ApiResponse<T>);
}

export function fail(error: string, status = 400): Response {
  return Response.json({ success: false, error } satisfies ApiResponse, { status });
}
