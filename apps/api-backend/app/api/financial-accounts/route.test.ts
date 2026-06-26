import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/financial-accounts', () => {
  class FinancialAccountServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return { financialAccountService: { list: vi.fn(), create: vi.fn() }, FinancialAccountServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { financialAccountService, FinancialAccountServiceError } from '@/lib/financial-accounts';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(financialAccountService.list);
const createMock = vi.mocked(financialAccountService.create);

const getRequest = (q = 'page=1') => ({ nextUrl: { searchParams: new URLSearchParams(q) } }) as unknown as NextRequest;
const postRequest = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  listMock.mockReset();
  createMock.mockReset();
});

describe('/api/financial-accounts', () => {
  it('GET 401', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    expect((await GET(getRequest())).status).toBe(401);
  });
  it('GET 200 com meta', async () => {
    listMock.mockResolvedValue({ data: [{ financial_account_id: 1 }] as never, total: 1, page: 1, limit: 20 });
    const body = await (await GET(getRequest())).json();
    expect(body.meta).toEqual({ total: 1, page: 1, limit: 20 });
  });
  it('POST 201 / 422', async () => {
    createMock.mockResolvedValue({ financial_account_id: 7 } as never);
    expect((await POST(postRequest(async () => ({ account_description: 'Caixa', bank_id: 0, payment_type_id: 8, status_id: 1 })))).status).toBe(201);
    createMock.mockRejectedValue(new FinancialAccountServiceError('Descrição é obrigatória', 422));
    expect((await POST(postRequest(async () => ({})))).status).toBe(422);
  });
});
