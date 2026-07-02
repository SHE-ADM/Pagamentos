// src/services/chartAccountSubgroups.ts — CRUD de subgrupos do plano de contas
// (financial_chart_of_account_subgroup) na Next API.
import type {
  ChartAccountSubgroup,
  ChartAccountSubgroupCreateInput,
  ChartAccountSubgroupUpdateInput,
} from '@sheild/shared';
import { dataApiCall, dataApiDelete, dataApiListPaged, type PagedParams, type PagedResult } from './dataApi';

export function listChartAccountSubgroupsPage(
  params: PagedParams = {},
): Promise<PagedResult<ChartAccountSubgroup>> {
  return dataApiListPaged<ChartAccountSubgroup>('/chart-account-subgroups', params);
}

export async function createChartAccountSubgroup(
  input: ChartAccountSubgroupCreateInput,
): Promise<ChartAccountSubgroup> {
  const body = await dataApiCall<ChartAccountSubgroup>('/chart-account-subgroups', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.data as ChartAccountSubgroup;
}

export async function updateChartAccountSubgroup(
  id: number,
  input: ChartAccountSubgroupUpdateInput,
): Promise<ChartAccountSubgroup> {
  const body = await dataApiCall<ChartAccountSubgroup>(`/chart-account-subgroups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.data as ChartAccountSubgroup;
}

// Hard delete — admin-only (403 se não-admin); 409 se o subgrupo estiver em uso (planos).
export function deleteChartAccountSubgroup(id: number): Promise<void> {
  return dataApiDelete('/chart-account-subgroups', id);
}
