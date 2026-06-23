import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok-123' } } }) },
  },
}));

import { createConta, updateConta } from './contas';

function mockFetch(ok: boolean, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('createConta', () => {
  it('desembrulha data do envelope', async () => {
    mockFetch(true, { success: true, data: { id: 7 } });
    expect(await createConta({ sk_supplier: 1, amount: 100 })).toEqual({ id: 7 });
  });

  it('envia o token no header Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, data: { id: 1 } }) });
    vi.stubGlobal('fetch', fetchMock);
    await createConta({ sk_supplier: 1, amount: 100 });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('lança a mensagem de erro do backend', async () => {
    mockFetch(false, { success: false, error: 'Selecione um fornecedor' });
    await expect(createConta({ sk_supplier: 1, amount: 100 })).rejects.toThrow('Selecione um fornecedor');
  });
});

describe('updateConta', () => {
  it('faz PATCH e desembrulha data', async () => {
    mockFetch(true, { success: true, data: { id: 5, status: 'cancelado' } });
    expect(await updateConta(5, { status: 'cancelado' })).toEqual({ id: 5, status: 'cancelado' });
  });
});
