// src/services/costCenters.ts
// Cliente do CRUD de centros de custo na Next API (apps/api-backend, porta 3000).
// Como `supplier`, a tabela `financial_cost_center` tem RLS só-leitura para
// `authenticated` — a escrita exige service_role, que vive no backend. O token da
// sessão do Supabase vai no header Authorization; o middleware da Next API o valida.
//
// Base: VITE_DATA_API_URL (prod) ou '/data-api' (dev — proxy do Vite reescreve
// para /api no :3000). Envelope da API: { success, data?, error?, meta? }.

import type { CostCenter, CostCenterCreateInput, CostCenterUpdateInput } from '@sheild/shared';
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

// Chamada genérica à Next API: desembrulha o envelope e lança o erro em pt-BR
// devolvido pelo backend (mensagens já são leigas — 409/422/404 etc.).
async function call<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const res = await fetch(`${DATA_API_BASE}${path}`, { ...init, headers: await authHeaders() });
  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || !body.success) {
    throw new Error(body.error ?? `Erro ${res.status} ao acessar a API de dados`);
  }
  return body;
}

interface CostCenterListResult {
  data: CostCenter[];
  total: number;
  page: number;
  limit: number;
}

interface CostCenterListParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

export async function listCostCentersPage({
  page = 1,
  limit = 20,
  search,
  sort,
  order,
}: CostCenterListParams = {}): Promise<CostCenterListResult> {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) qs.set('search', search);
  if (sort) {
    qs.set('sort', sort);
    if (order) qs.set('order', order);
  }
  const body = await call<CostCenter[]>(`/cost-centers?${qs.toString()}`);
  return {
    data: body.data ?? [],
    total: body.meta?.total ?? 0,
    page: body.meta?.page ?? page,
    limit: body.meta?.limit ?? limit,
  };
}

export async function createCostCenter(input: CostCenterCreateInput): Promise<CostCenter> {
  const body = await call<CostCenter>('/cost-centers', { method: 'POST', body: JSON.stringify(input) });
  return body.data as CostCenter;
}

export async function updateCostCenter(id: number, input: CostCenterUpdateInput): Promise<CostCenter> {
  const body = await call<CostCenter>(`/cost-centers/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  return body.data as CostCenter;
}

// Hard delete — admin-only (403 se não-admin); 409 se o centro estiver em uso.
export async function deleteCostCenter(id: number): Promise<void> {
  await call(`/cost-centers/${id}`, { method: 'DELETE' });
}
