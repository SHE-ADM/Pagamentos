// src/services/financialAccounts.ts — cliente do CRUD de contas bancárias/caixa
// (financial_account) na Next API. URL /financial-accounts (distinta de /contas,
// que é financial_account_control).
import type { FinancialAccount, FinancialAccountCreateInput, FinancialAccountUpdateInput } from '@sheild/shared';
import { dataApiCall, dataApiDelete, dataApiListPaged, type PagedParams, type PagedResult } from './dataApi';

export function listFinancialAccountsPage(params: PagedParams = {}): Promise<PagedResult<FinancialAccount>> {
  return dataApiListPaged<FinancialAccount>('/financial-accounts', params);
}

export async function createFinancialAccount(input: FinancialAccountCreateInput): Promise<FinancialAccount> {
  const body = await dataApiCall<FinancialAccount>('/financial-accounts', { method: 'POST', body: JSON.stringify(input) });
  return body.data as FinancialAccount;
}

export async function updateFinancialAccount(id: number, input: FinancialAccountUpdateInput): Promise<FinancialAccount> {
  const body = await dataApiCall<FinancialAccount>(`/financial-accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.data as FinancialAccount;
}

// Hard delete — admin-only (403 se não-admin). Contas bancárias não têm FK reversa.
export function deleteFinancialAccount(id: number): Promise<void> {
  return dataApiDelete('/financial-accounts', id);
}
