// src/services/chartAccountGroups.ts — CRUD de grupos do plano de contas
// (financial_chart_of_account_group) na Next API.
import type {
  ChartAccountGroup,
  ChartAccountGroupCreateInput,
  ChartAccountGroupUpdateInput,
} from '@sheild/shared';
import { dataApiCall, dataApiDelete, dataApiListPaged, type PagedParams, type PagedResult } from './dataApi';

export function listChartAccountGroupsPage(params: PagedParams = {}): Promise<PagedResult<ChartAccountGroup>> {
  return dataApiListPaged<ChartAccountGroup>('/chart-account-groups', params);
}

export async function createChartAccountGroup(input: ChartAccountGroupCreateInput): Promise<ChartAccountGroup> {
  const body = await dataApiCall<ChartAccountGroup>('/chart-account-groups', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.data as ChartAccountGroup;
}

export async function updateChartAccountGroup(
  id: number,
  input: ChartAccountGroupUpdateInput,
): Promise<ChartAccountGroup> {
  const body = await dataApiCall<ChartAccountGroup>(`/chart-account-groups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.data as ChartAccountGroup;
}

// Hard delete — admin-only (403 se não-admin); 409 se o grupo estiver em uso (subgrupos).
export function deleteChartAccountGroup(id: number): Promise<void> {
  return dataApiDelete('/chart-account-groups', id);
}
