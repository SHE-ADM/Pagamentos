import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/banks', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class BankServiceError extends ApiServiceError {
    constructor(m: string, s: number) {
      super(m, s, 'BankServiceError');
    }
  }
  return { bankService: { list: vi.fn(), create: vi.fn() }, BankServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { bankService, BankServiceError } from '@/lib/banks';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(bankService.list);
const createMock = vi.mocked(bankService.create);

function getRequest(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}
function postRequest(json: () => Promise<unknown>): NextRequest {
  return { json } as unknown as NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  listMock.mockReset();
  createMock.mockReset();
});

describe('GET /api/banks', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    expect((await GET(getRequest())).status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('lookup (sem page) devolve array sem meta', async () => {
    listMock.mockResolvedValue({ data: [{ bank_id: 1 }] as never, total: 1, page: 1, limit: 1000 });
    const res = await GET(getRequest('search=bb'));
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [{ bank_id: 1 }] });
  });

  it('CRUD (com page) devolve data + meta', async () => {
    listMock.mockResolvedValue({ data: [{ bank_id: 1 }] as never, total: 1, page: 1, limit: 20 });
    const res = await GET(getRequest('page=1&limit=20'));
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [{ bank_id: 1 }], meta: { total: 1, page: 1, limit: 20 } });
  });
});

describe('POST /api/banks', () => {
  it('201 no sucesso', async () => {
    createMock.mockResolvedValue({ bank_id: 23 } as never);
    expect((await POST(postRequest(async () => ({ bank_code: '999', bank_name: 'X' })))).status).toBe(201);
  });

  it('409 código duplicado', async () => {
    createMock.mockRejectedValue(new BankServiceError('Código já cadastrado', 409));
    expect((await POST(postRequest(async () => ({ bank_code: '001', bank_name: 'X' })))).status).toBe(409);
  });
});
