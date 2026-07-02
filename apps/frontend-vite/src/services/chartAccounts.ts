// src/services/chartAccounts.ts — cliente do CRUD do plano de contas
// (financial_chart_of_account) na Next API. A rota /chart-accounts é dual: aqui
// usamos sempre `page` (modo CRUD); o lookup da cascata vive em services/lookups.ts.
import type { ChartAccount, ChartAccountCreateInput, ChartAccountUpdateInput } from '@sheild/shared';
import { dataApiCall, dataApiDelete, dataApiListPaged, type PagedParams, type PagedResult } from './dataApi';

export function listChartAccountsPage(params: PagedParams = {}): Promise<PagedResult<ChartAccount>> {
  return dataApiListPaged<ChartAccount>('/chart-accounts', params);
}

export async function createChartAccount(input: ChartAccountCreateInput): Promise<ChartAccount> {
  const body = await dataApiCall<ChartAccount>('/chart-accounts', { method: 'POST', body: JSON.stringify(input) });
  return body.data as ChartAccount;
}

export async function updateChartAccount(id: number, input: ChartAccountUpdateInput): Promise<ChartAccount> {
  const body = await dataApiCall<ChartAccount>(`/chart-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  return body.data as ChartAccount;
}

// Hard delete — admin-only (403 se não-admin); 409 se o plano estiver em uso.
export function deleteChartAccount(id: number): Promise<void> {
  return dataApiDelete('/chart-accounts', id);
}
