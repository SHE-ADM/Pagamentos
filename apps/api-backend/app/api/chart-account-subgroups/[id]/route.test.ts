import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), requireAdminGroup: vi.fn() }));
vi.mock('@/lib/chart-account-subgroups', () => {
  class ChartAccountSubgroupServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return {
    chartAccountSubgroupService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() },
    ChartAccountSubgroupServiceError,
  };
});

import { GET, PATCH, DELETE } from './route';
import { requireAuth, requireAdminGroup } from '@/lib/auth';
import { chartAccountSubgroupService, ChartAccountSubgroupServiceError } from '@/lib/chart-account-subgroups';

const requireAuthMock = vi.mocked(requireAuth);
const requireAdminGroupMock = vi.mocked(requireAdminGroup);
const removeMock = vi.mocked(chartAccountSubgroupService.remove);
const updateMock = vi.mocked(chartAccountSubgroupService.update);

const req = () => ({}) as unknown as NextRequest;
const jsonReq = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  requireAdminGroupMock.mockReset().mockResolvedValue(null);
  vi.mocked(chartAccountSubgroupService.getById).mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
});

describe('/api/chart-account-subgroups/:id', () => {
  it('GET 400 id inválido', async () => {
    expect((await GET(req(), ctx('-1'))).status).toBe(400);
  });
  it('PATCH 200', async () => {
    updateMock.mockResolvedValue({
      chart_account_subgroup_id: 5,
      chart_account_group_id: 1,
      subgroup_code: '1.1',
      subgroup_description: 'X',
    });
    expect((await PATCH(jsonReq(async () => ({ subgroup_description: 'X' })), ctx('5'))).status).toBe(200);
  });
  it('DELETE 409 em uso', async () => {
    removeMock.mockRejectedValue(new ChartAccountSubgroupServiceError('Subgrupo em uso e não pode ser excluído', 409));
    expect((await DELETE(req(), ctx('5'))).status).toBe(409);
  });
  it('DELETE 403 quando não é admin — não toca o service', async () => {
    requireAdminGroupMock.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await DELETE(req(), ctx('5'))).status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
