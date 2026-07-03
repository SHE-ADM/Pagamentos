import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), requireAdminGroup: vi.fn() }));
vi.mock('@/lib/chart-account-groups', () => {
  class ChartAccountGroupServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return {
    chartAccountGroupService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() },
    ChartAccountGroupServiceError,
  };
});

import { GET, PATCH, DELETE } from './route';
import { requireAuth, requireAdminGroup } from '@/lib/auth';
import { chartAccountGroupService, ChartAccountGroupServiceError } from '@/lib/chart-account-groups';

const requireAuthMock = vi.mocked(requireAuth);
const requireAdminGroupMock = vi.mocked(requireAdminGroup);
const getByIdMock = vi.mocked(chartAccountGroupService.getById);
const updateMock = vi.mocked(chartAccountGroupService.update);
const removeMock = vi.mocked(chartAccountGroupService.remove);

const req = () => ({}) as unknown as NextRequest;
const jsonReq = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  requireAdminGroupMock.mockReset().mockResolvedValue(null);
  getByIdMock.mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
});

describe('/api/chart-account-groups/:id', () => {
  it('GET 400 id inválido', async () => {
    expect((await GET(req(), ctx('0'))).status).toBe(400);
  });
  it('GET 404 inexistente', async () => {
    getByIdMock.mockRejectedValue(new ChartAccountGroupServiceError('Grupo não encontrado', 404));
    expect((await GET(req(), ctx('9'))).status).toBe(404);
  });
  it('PATCH 200', async () => {
    updateMock.mockResolvedValue({ chart_account_group_id: 5, group_code: '5', group_description: 'X', group_type: null });
    expect((await PATCH(jsonReq(async () => ({ group_description: 'X' })), ctx('5'))).status).toBe(200);
  });
  it('DELETE 409 em uso', async () => {
    removeMock.mockRejectedValue(new ChartAccountGroupServiceError('Grupo em uso e não pode ser excluído', 409));
    expect((await DELETE(req(), ctx('5'))).status).toBe(409);
  });
  it('DELETE 403 quando não é admin — não toca o service', async () => {
    requireAdminGroupMock.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await DELETE(req(), ctx('5'))).status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
