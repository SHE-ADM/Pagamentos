import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/suppliers', () => {
  class SupplierServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'SupplierServiceError';
      this.status = status;
    }
  }
  return { supplierService: { list: vi.fn(), create: vi.fn() }, SupplierServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { supplierService, SupplierServiceError } from '@/lib/suppliers';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(supplierService.list);
const createMock = vi.mocked(supplierService.create);

function getRequest(query = 'page=1&limit=20'): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}
function postRequest(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  listMock.mockReset();
  createMock.mockReset();
});

describe('GET /api/suppliers', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 com data + meta', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue({ data: [{ sk_supplier: 1 }] as never, total: 1, page: 1, limit: 20 });
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [{ sk_supplier: 1 }], meta: { total: 1, page: 1, limit: 20 } });
  });

  it('encaminha sort=name ao service (ordenação do lookup)', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue({ data: [] as never, total: 0, page: 1, limit: 20 });
    await GET(getRequest('page=1&limit=20&sort=name'));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ sort: 'name' }));
  });

  it('ignora sort inválido (default = mais recentes)', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue({ data: [] as never, total: 0, page: 1, limit: 20 });
    await GET(getRequest('sort=xyz'));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ sort: undefined }));
  });
});

describe('POST /api/suppliers', () => {
  beforeEach(() => requireAuthMock.mockResolvedValue(null));

  it('201 no sucesso', async () => {
    createMock.mockResolvedValue({ sk_supplier: 7, trade_name: 'ACME' } as never);
    const res = await POST(postRequest(async () => ({ trade_name: 'ACME' })));
    expect(res.status).toBe(201);
  });

  it('422 quando o payload é inválido', async () => {
    createMock.mockRejectedValue(new SupplierServiceError('Informe ao menos um identificador', 422));
    const res = await POST(postRequest(async () => ({})));
    expect(res.status).toBe(422);
  });

  it('409 quando o CNPJ já existe', async () => {
    createMock.mockRejectedValue(new SupplierServiceError('CNPJ já cadastrado', 409));
    const res = await POST(postRequest(async () => ({ cnpj: '12345678000199' })));
    expect(res.status).toBe(409);
  });
});
