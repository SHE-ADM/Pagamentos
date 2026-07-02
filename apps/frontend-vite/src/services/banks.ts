// src/services/banks.ts — cliente do CRUD de bancos (financial_bank) na Next API.
import type { Bank, BankCreateInput, BankUpdateInput } from '@sheild/shared';
import { dataApiCall, dataApiDelete, dataApiListPaged, type PagedParams, type PagedResult } from './dataApi';

export function listBanksPage(params: PagedParams = {}): Promise<PagedResult<Bank>> {
  return dataApiListPaged<Bank>('/banks', params);
}

export async function createBank(input: BankCreateInput): Promise<Bank> {
  const body = await dataApiCall<Bank>('/banks', { method: 'POST', body: JSON.stringify(input) });
  return body.data as Bank;
}

export async function updateBank(id: number, input: BankUpdateInput): Promise<Bank> {
  const body = await dataApiCall<Bank>(`/banks/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  return body.data as Bank;
}

// Hard delete — admin-only (403 se não-admin); 409 se o banco estiver em uso.
export function deleteBank(id: number): Promise<void> {
  return dataApiDelete('/banks', id);
}
