import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/chart-account-subgroups', () => {
  class ChartAccountSubgroupServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return { chartAccountSubgroupService: { list: vi.fn(), create: vi.fn() }, ChartAccountSubgroupServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { chartAccountSubgroupService, ChartAccountSubgroupServiceError } from '@/lib/chart-account-subgroups';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(chartAccountSubgroupService.list);
const createMock = vi.mocked(chartAccountSubgroupService.create);

const getRequest = (q = '') => ({ nextUrl: { searchParams: new URLSearchParams(q) } }) as unknown as NextRequest;
const postRequest = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  listMock.mockReset();
  createMock.mockReset();
});

describe('/api/chart-account-subgroups', () => {
  it('GET lookup (sem page) → array sem meta', async () => {
    listMock.mockResolvedValue({ data: [{ chart_account_subgroup_id: 1 }] as never, total: 1, page: 1, limit: 1000 });
    const body = await (await GET(getRequest())).json();
    expect(body).toEqual({ success: true, data: [{ chart_account_subgroup_id: 1 }] });
  });

  it('GET CRUD (com page) → meta', async () => {
    listMock.mockResolvedValue({ data: [] as never, total: 0, page: 1, limit: 20 });
    const body = await (await GET(getRequest('page=1'))).json();
    expect(body.meta).toEqual({ total: 0, page: 1, limit: 20 });
  });

  it('POST 201 / 422 (grupo inexistente)', async () => {
    createMock.mockResolvedValue({ chart_account_subgroup_id: 9 } as never);
    expect((await POST(postRequest(async () => ({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 1 })))).status).toBe(201);
    createMock.mockRejectedValue(new ChartAccountSubgroupServiceError('Grupo informado não existe', 422));
    expect((await POST(postRequest(async () => ({ subgroup_code: '1.1', subgroup_description: 'X', chart_account_group_id: 999 })))).status).toBe(422);
  });
});
