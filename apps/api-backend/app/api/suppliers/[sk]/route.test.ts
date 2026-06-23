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
  return {
    supplierService: { getBySk: vi.fn(), update: vi.fn(), remove: vi.fn() },
    SupplierServiceError,
  };
});

import { GET, DELETE } from './route';
import { requireAuth } from '@/lib/auth';
import { supplierService, SupplierServiceError } from '@/lib/suppliers';

const requireAuthMock = vi.mocked(requireAuth);
const getBySkMock = vi.mocked(supplierService.getBySk);
const removeMock = vi.mocked(supplierService.remove);

const req = {} as NextRequest;
const ctx = (sk: string) => ({ params: Promise.resolve({ sk }) });

beforeEach(() => {
  requireAuthMock.mockReset();
  getBySkMock.mockReset();
  removeMock.mockReset();
  requireAuthMock.mockResolvedValue(null);
});

describe('GET /api/suppliers/:sk', () => {
  it('400 quando o sk é inválido', async () => {
    const res = await GET(req, ctx('abc'));
    expect(res.status).toBe(400);
    expect(getBySkMock).not.toHaveBeenCalled();
  });

  it('404 quando o fornecedor não existe', async () => {
    getBySkMock.mockRejectedValue(new SupplierServiceError('Fornecedor não encontrado', 404));
    const res = await GET(req, ctx('9'));
    expect(res.status).toBe(404);
  });

  it('200 quando encontrado', async () => {
    getBySkMock.mockResolvedValue({ sk_supplier: 5 } as never);
    const res = await GET(req, ctx('5'));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/suppliers/:sk', () => {
  it('409 quando há contas vinculadas', async () => {
    removeMock.mockRejectedValue(
      new SupplierServiceError('Fornecedor possui contas vinculadas e não pode ser removido', 409),
    );
    const res = await DELETE(req, ctx('5'));
    expect(res.status).toBe(409);
  });

  it('200 na baixa lógica', async () => {
    removeMock.mockResolvedValue({ sk_supplier: 5 });
    const res = await DELETE(req, ctx('5'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { sk_supplier: 5 } });
  });
});
