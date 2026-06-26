import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/chart-account-groups', () => {
  class ChartAccountGroupServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return { chartAccountGroupService: { list: vi.fn(), create: vi.fn() }, ChartAccountGroupServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { chartAccountGroupService, ChartAccountGroupServiceError } from '@/lib/chart-account-groups';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(chartAccountGroupService.list);
const createMock = vi.mocked(chartAccountGroupService.create);

const getRequest = (q = '') => ({ nextUrl: { searchParams: new URLSearchParams(q) } }) as unknown as NextRequest;
const postRequest = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  listMock.mockReset();
  createMock.mockReset();
});

describe('/api/chart-account-groups', () => {
  it('GET 401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    expect((await GET(getRequest())).status).toBe(401);
  });

  it('GET lookup (sem page) → array sem meta', async () => {
    listMock.mockResolvedValue({ data: [{ chart_account_group_id: 1 }] as never, total: 1, page: 1, limit: 1000 });
    const body = await (await GET(getRequest())).json();
    expect(body).toEqual({ success: true, data: [{ chart_account_group_id: 1 }] });
  });

  it('GET CRUD (com page) → data + meta', async () => {
    listMock.mockResolvedValue({ data: [] as never, total: 0, page: 1, limit: 20 });
    const body = await (await GET(getRequest('page=1'))).json();
    expect(body.meta).toEqual({ total: 0, page: 1, limit: 20 });
  });

  it('POST 201 / 409', async () => {
    createMock.mockResolvedValue({ chart_account_group_id: 9 } as never);
    expect((await POST(postRequest(async () => ({ group_code: '9', group_description: 'X' })))).status).toBe(201);
    createMock.mockRejectedValue(new ChartAccountGroupServiceError('Código já cadastrado', 409));
    expect((await POST(postRequest(async () => ({ group_code: '1', group_description: 'X' })))).status).toBe(409);
  });
});
