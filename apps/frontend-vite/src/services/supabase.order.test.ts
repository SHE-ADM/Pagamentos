// services/supabase.order.test.ts
// Guarda de COMPORTAMENTO: as listagens paginadas do frontend enviam o desempate por
// PK no parâmetro `order` do PostgREST.
//
// O teste de `stableOrder` prova que o helper monta a string certa; este prova que a
// requisição que sai do serviço realmente a carrega — que era o defeito (o `order` era
// montado inline, sem desempate, e a mesma conta aparecia duas vezes no scroll infinito
// enquanto outra sumia da tela).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } },
}));

import { getFinancialAccountControl, getProcessingErrors } from './supabase';

/** URLs capturadas do fetch, na ordem em que foram requisitadas. */
let urls: string[] = [];

beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    // `Request` não tem toString útil ('[object Object]') — a URL vem da própria propriedade.
    urls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(
      new Response('[]', { status: 200, headers: { 'Content-Range': '0-0/0' } }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Valor do parâmetro `order` da última requisição feita à tabela informada. */
function orderOf(tabela: string): string {
  const url = urls.find((u) => u.includes(`/rest/v1/${tabela}`));
  expect(url, `nenhuma requisição a ${tabela}`).toBeDefined();
  const order = new URL(url as string).searchParams.get('order');
  expect(order, `requisição a ${tabela} sem parâmetro order`).not.toBeNull();
  return order as string;
}

describe('order das listagens paginadas carrega o desempate por PK', () => {
  it('/consulta na ordenação PADRÃO (sem clique no cabeçalho)', async () => {
    await getFinancialAccountControl({ page: 1, pageSize: 50 });
    expect(orderOf('financial_account_control')).toBe('created_at.desc,id.desc');
  });

  // O caso que quebrou: ordenar por vencimento empata 647 das 682 linhas.
  it('/consulta ordenando por uma coluna com muitos empates', async () => {
    await getFinancialAccountControl({ page: 2, pageSize: 50, sortCol: 'due_date', sortDir: 'desc' });
    expect(orderOf('financial_account_control')).toBe('due_date.desc,id.desc');
  });

  // A coluna "Situação" ordena pelo nome da dimensão (recurso embutido do PostgREST) e
  // é a que mais empata: 682 de 682 linhas, num grupo de até 493.
  it('/consulta ordenando por Situação (embed) mantém o desempate', async () => {
    await getFinancialAccountControl({ page: 1, pageSize: 50, sortCol: 'status', sortDir: 'asc' });
    expect(orderOf('financial_account_control')).toBe('status_dim(status_name).asc,id.asc');
  });

  it('/erros (também paginado por offset)', async () => {
    await getProcessingErrors({ page: 3, pageSize: 25 });
    expect(orderOf('email_processing_errors')).toBe('logged_at.desc,id.desc');
  });
});
