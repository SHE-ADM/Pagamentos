import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), requireAdminGroup: vi.fn() }));
vi.mock('@/lib/financial-accounts', () => {
  class FinancialAccountServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return {
    financialAccountService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() },
    FinancialAccountServiceError,
  };
});

import { GET, DELETE } from './route';
import { requireAuth, requireAdminGroup } from '@/lib/auth';
import { financialAccountService, FinancialAccountServiceError } from '@/lib/financial-accounts';

const requireAuthMock = vi.mocked(requireAuth);
const requireAdminGroupMock = vi.mocked(requireAdminGroup);
const getByIdMock = vi.mocked(financialAccountService.getById);
const removeMock = vi.mocked(financialAccountService.remove);

const req = () => ({}) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  requireAdminGroupMock.mockReset().mockResolvedValue(null);
  getByIdMock.mockReset();
  removeMock.mockReset();
});

describe('/api/financial-accounts/:id', () => {
  it('GET 400 id inválido', async () => {
    expect((await GET(req(), ctx('0'))).status).toBe(400);
  });
  it('GET 404 inexistente', async () => {
    getByIdMock.mockRejectedValue(new FinancialAccountServiceError('Conta não encontrada', 404));
    expect((await GET(req(), ctx('9'))).status).toBe(404);
  });
  it('DELETE 200 (exclusão livre)', async () => {
    removeMock.mockResolvedValue({ financial_account_id: 5 });
    expect((await DELETE(req(), ctx('5'))).status).toBe(200);
  });
  it('DELETE 403 quando não é admin — não toca o service', async () => {
    requireAdminGroupMock.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await DELETE(req(), ctx('5'))).status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
