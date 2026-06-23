import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/contas', () => {
  class ContaServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ContaServiceError';
      this.status = status;
    }
  }
  return { contaService: { list: vi.fn(), create: vi.fn() }, ContaServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { contaService, ContaServiceError } from '@/lib/contas';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(contaService.list);
const createMock = vi.mocked(contaService.create);

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

describe('GET /api/contas', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 com data + meta', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue({ data: [{ id: 1 }] as never, total: 1, page: 1, limit: 20 });
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [{ id: 1 }], meta: { total: 1, page: 1, limit: 20 } });
  });
});

describe('POST /api/contas', () => {
  beforeEach(() => requireAuthMock.mockResolvedValue(null));

  it('201 no sucesso', async () => {
    createMock.mockResolvedValue({ id: 7, sk_supplier: 1, amount: 100 } as never);
    const res = await POST(postRequest(async () => ({ sk_supplier: 1, amount: 100 })));
    expect(res.status).toBe(201);
  });

  it('422 quando o payload é inválido', async () => {
    createMock.mockRejectedValue(new ContaServiceError('Selecione um fornecedor', 422));
    const res = await POST(postRequest(async () => ({ amount: 100 })));
    expect(res.status).toBe(422);
  });
});
