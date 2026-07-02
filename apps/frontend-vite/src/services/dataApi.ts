// src/services/dataApi.ts
// Helper compartilhado dos clientes de CRUD da Next API (cadastros do grupo Tabelas).
// Centraliza base URL, header de auth (token da sessão Supabase) e o desembrulho do
// envelope { success, data?, error?, meta? }. Os services antigos (suppliers/costCenters)
// têm a própria cópia desse boilerplate; os cadastros novos reusam este módulo.
//
// Base: VITE_DATA_API_URL (prod) ou '/data-api' (dev — proxy do Vite reescreve para
// /api no :3000). O middleware da Next API valida o Bearer token (auth.getUser).

import { supabase } from '../lib/supabaseClient';

const DATA_API_BASE = (import.meta.env.VITE_DATA_API_URL as string | undefined) ?? '/data-api';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: { total?: number; page?: number; limit?: number };
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? '';
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// Chamada genérica: desembrulha o envelope e lança o erro em pt-BR do backend
// (mensagens já leigas — 409/422/404 etc.).
export async function dataApiCall<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const res = await fetch(`${DATA_API_BASE}${path}`, { ...init, headers: await authHeaders() });
  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || !body.success) {
    // Mensagem curada do backend (4xx leigo) tem precedência. Sem envelope (resposta
    // não-JSON: API fora do ar / erro transitório 5xx), dá uma mensagem ACIONÁVEL
    // ("tente novamente") em vez do críptico "Erro 500 ao acessar a API de dados".
    if (body.error) throw new Error(body.error);
    throw new Error(
      res.status >= 500
        ? `A API de dados está indisponível no momento (erro ${res.status}). Tente novamente em instantes.`
        : `Erro ${res.status} ao acessar a API de dados`,
    );
  }
  return body;
}

// Hard delete genérico (DELETE /:resource/:id). A rota é ADMIN-ONLY no backend
// (requireAdmin → 403 se não-admin) e pode devolver 409 quando o registro está em uso
// (integridade referencial) — a mensagem curada do backend sobe pelo dataApiCall.
export async function dataApiDelete(resource: string, id: number | string): Promise<void> {
  await dataApiCall(`${resource}/${id}`, { method: 'DELETE' });
}

// Lista paginada genérica (envelope com meta) — reusada pelos CRUDs do grupo Tabelas.
export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PagedParams {
  page?: number;
  limit?: number;
  search?: string;
  /** Coluna de ordenação server-side (validada por allowlist no backend). */
  sort?: string;
  /** Direção da ordenação; padrão `asc` quando há `sort`. */
  order?: 'asc' | 'desc';
}

export async function dataApiListPaged<T>(resource: string, params: PagedParams = {}): Promise<PagedResult<T>> {
  const { page = 1, limit = 20, search, sort, order } = params;
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) qs.set('search', search);
  if (sort) {
    qs.set('sort', sort);
    if (order) qs.set('order', order);
  }
  const body = await dataApiCall<T[]>(`${resource}?${qs.toString()}`);
  return {
    data: body.data ?? [],
    total: body.meta?.total ?? 0,
    page: body.meta?.page ?? page,
    limit: body.meta?.limit ?? limit,
  };
}
