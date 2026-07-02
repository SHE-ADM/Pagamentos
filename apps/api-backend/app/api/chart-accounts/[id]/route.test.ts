import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('@/lib/chart-accounts', () => {
  class ChartAccountServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return { chartAccountService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() }, ChartAccountServiceError };
});

import { GET, PATCH, DELETE } from './route';
import { requireAuth, requireAdmin } from '@/lib/auth';
import { chartAccountService, ChartAccountServiceError } from '@/lib/chart-accounts';

const requireAuthMock = vi.mocked(requireAuth);
const requireAdminMock = vi.mocked(requireAdmin);
const updateMock = vi.mocked(chartAccountService.update);
const removeMock = vi.mocked(chartAccountService.remove);

const req = () => ({}) as unknown as NextRequest;
const jsonReq = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  requireAdminMock.mockReset().mockResolvedValue(null);
  vi.mocked(chartAccountService.getById).mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
});

describe('/api/chart-accounts/:id', () => {
  it('GET 400 id inválido', async () => {
    expect((await GET(req(), ctx('0'))).status).toBe(400);
  });
  it('PATCH 409 código duplicado', async () => {
    updateMock.mockRejectedValue(new ChartAccountServiceError('Código já cadastrado', 409));
    expect((await PATCH(jsonReq(async () => ({ account_code: '1.1' })), ctx('5'))).status).toBe(409);
  });
  it('DELETE 409 em uso', async () => {
    removeMock.mockRejectedValue(new ChartAccountServiceError('Plano de contas em uso e não pode ser excluído', 409));
    expect((await DELETE(req(), ctx('5'))).status).toBe(409);
  });
  it('DELETE 403 quando não é admin — não toca o service', async () => {
    requireAdminMock.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await DELETE(req(), ctx('5'))).status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
