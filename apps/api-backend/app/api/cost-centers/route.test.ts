import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/lookups', () => {
  class LookupServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'LookupServiceError';
      this.status = status;
    }
  }
  return { costCenterService: { list: vi.fn() }, LookupServiceError };
});

import { GET } from './route';
import { requireAuth } from '@/lib/auth';
import { costCenterService, LookupServiceError } from '@/lib/lookups';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(costCenterService.list);

function getRequest(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  listMock.mockReset();
});

describe('GET /api/cost-centers', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 com a lista', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue([{ cost_center_id: 1, cost_center_code: 'ADM', cost_center_description: 'Administrativo' }]);
    const res = await GET(getRequest('search=adm'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: [{ cost_center_id: 1, cost_center_code: 'ADM', cost_center_description: 'Administrativo' }],
    });
    expect(listMock).toHaveBeenCalledWith({ search: 'adm', limit: undefined });
  });

  it('500 quando o service falha', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockRejectedValue(new LookupServiceError('boom', 500));
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
  });
});
