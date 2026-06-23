import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sessão mockada — token vai no header Authorization.
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'tok-123' } } }) },
  },
}));

import { listSuppliers, createSupplier } from './suppliers';

function mockFetch(ok: boolean, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('listSuppliers', () => {
  it('desembrulha data + meta do envelope', async () => {
    mockFetch(true, { success: true, data: [{ sk_supplier: 1 }], meta: { total: 3, page: 1, limit: 20 } });
    const r = await listSuppliers({ page: 1, limit: 20 });
    expect(r).toEqual({ data: [{ sk_supplier: 1 }], total: 3, page: 1, limit: 20 });
  });

  it('envia o token no header Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, data: [], meta: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    await listSuppliers();
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });
});

describe('createSupplier', () => {
  it('lança a mensagem de erro do backend (ex.: 409)', async () => {
    mockFetch(false, { success: false, error: 'CNPJ já cadastrado' });
    await expect(createSupplier({ cnpj: '12345678000199' })).rejects.toThrow('CNPJ já cadastrado');
  });
});
