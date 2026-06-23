// src/services/suppliers.ts
// Cliente do CRUD de fornecedores na Next API (apps/api-backend, porta 3000).
// Diferente de services/supabase.ts (REST direto), aqui falamos com a Next API
// porque a tabela `supplier` tem RLS só-leitura para `authenticated` — a escrita
// exige service_role, que vive no backend. O token da sessão do Supabase vai no
// header Authorization; o middleware da Next API o valida (auth.getUser).
//
// Base: VITE_DATA_API_URL (prod) ou '/data-api' (dev — proxy do Vite reescreve
// para /api no :3000). Envelope da API: { success, data?, error?, meta? }.

import type { Supplier, SupplierCreateInput, SupplierUpdateInput } from '@sheild/shared';
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

interface SupplierListResult {
  data: Supplier[];
  total: number;
  page: number;
  limit: number;
}

interface SupplierListParams {
  page?: number;
  limit?: number;
  search?: string;
}

export async function listSuppliers({ page = 1, limit = 20, search }: SupplierListParams = {}): Promise<SupplierListResult> {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) qs.set('search', search);
  const body = await call<Supplier[]>(`/suppliers?${qs.toString()}`);
  return {
    data: body.data ?? [],
    total: body.meta?.total ?? 0,
    page: body.meta?.page ?? page,
    limit: body.meta?.limit ?? limit,
  };
}

export async function createSupplier(input: SupplierCreateInput): Promise<Supplier> {
  const body = await call<Supplier>('/suppliers', { method: 'POST', body: JSON.stringify(input) });
  return body.data as Supplier;
}

export async function updateSupplier(sk: number, input: SupplierUpdateInput): Promise<Supplier> {
  const body = await call<Supplier>(`/suppliers/${sk}`, { method: 'PATCH', body: JSON.stringify(input) });
  return body.data as Supplier;
}

export async function deleteSupplier(sk: number): Promise<void> {
  await call<{ sk_supplier: number }>(`/suppliers/${sk}`, { method: 'DELETE' });
}
