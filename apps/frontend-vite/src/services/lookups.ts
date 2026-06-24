// src/services/lookups.ts
// Cliente dos lookups de classificação contábil (centro de custo / plano de
// contas) na Next API (apps/api-backend, :3000). Mesmo motivo do CRUD de
// fornecedores: as tabelas têm RLS, a leitura via service_role vive no backend.
// O token da sessão do Supabase vai no Authorization; o middleware o valida.

import type { CostCenter, ChartAccount } from '@sheild/shared';
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

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`${DATA_API_BASE}${path}`, { headers: await authHeaders() });
  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!res.ok || !body.success) {
    throw new Error(body.error ?? `Erro ${res.status} ao acessar a API de dados`);
  }
  return body.data as T;
}

export async function listCostCenters(search?: string): Promise<CostCenter[]> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  return call<CostCenter[]>(`/cost-centers${qs}`);
}

// Cascata: o plano de contas depende do centro de custo. Sem centro (`null`), não há
// o que listar → retorna [] sem ir à rede (reduz carga e mantém o select vazio).
export async function listChartAccounts(costCenterId: number | null, search?: string): Promise<ChartAccount[]> {
  if (costCenterId == null) return [];
  const qs = new URLSearchParams({ cost_center_id: String(costCenterId) });
  if (search) qs.set('search', search);
  return call<ChartAccount[]>(`/chart-accounts?${qs.toString()}`);
}
