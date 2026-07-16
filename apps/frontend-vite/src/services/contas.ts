// src/services/contas.ts
// Cliente do CRUD de contas na Next API (apps/api-backend, :3000) — a escrita exige
// service_role (RLS só-leitura para authenticated), que vive no backend. O token da
// sessão do Supabase vai no Authorization; o middleware da Next API o valida.
// Base: VITE_DATA_API_URL (prod) ou '/data-api' (dev — proxy do Vite reescreve p/ /api).

import type {
  FinancialAccountControl,
  FinancialAccountControlCreate,
  FinancialAccountControlUpdate,
} from '@sheild/shared';
import { supabase } from '../lib/supabaseClient';

const DATA_API_BASE = (import.meta.env.VITE_DATA_API_URL as string | undefined) ?? '/data-api';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? '';
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const res = await fetch(`${DATA_API_BASE}${path}`, { ...init, headers: await authHeaders() });
  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || !body.success) {
    throw new Error(body.error ?? `Erro ${res.status} ao acessar a API de dados`);
  }
  return body;
}

export async function createConta(input: FinancialAccountControlCreate): Promise<FinancialAccountControl> {
  const body = await call<FinancialAccountControl>('/contas', { method: 'POST', body: JSON.stringify(input) });
  return body.data as FinancialAccountControl;
}

export async function updateConta(id: number, input: FinancialAccountControlUpdate): Promise<FinancialAccountControl> {
  const body = await call<FinancialAccountControl>(`/contas/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  return body.data as FinancialAccountControl;
}

// HARD DELETE físico — restrito ao GRUPO ADMINISTRADOR (o backend impõe via requireAdminGroup;
// a UI só oferece a ação para esse grupo). Irreversível. Devolve o id removido.
export async function deleteConta(id: number): Promise<number> {
  const body = await call<{ id: number }>(`/contas/${id}`, { method: 'DELETE' });
  return (body.data as { id: number }).id;
}
