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
  return { chartAccountService: { list: vi.fn() }, LookupServiceError };
});

import { GET } from './route';
import { requireAuth } from '@/lib/auth';
import { chartAccountService, LookupServiceError } from '@/lib/lookups';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(chartAccountService.list);

function getRequest(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  listMock.mockReset();
});

describe('GET /api/chart-accounts', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 com a lista', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue([{ chart_account_id: 1, account_code: '1.1.01', account_description: 'Clientes' }]);
    const res = await GET(getRequest('limit=50&cost_center_id=3'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: [{ chart_account_id: 1, account_code: '1.1.01', account_description: 'Clientes' }],
    });
    expect(listMock).toHaveBeenCalledWith({ search: undefined, limit: 50, costCenterId: 3 });
  });

  it('encaminha cost_center_id ao service (cascata)', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue([]);
    await GET(getRequest('cost_center_id=7'));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ costCenterId: 7 }));
  });

  it('sem cost_center_id válido encaminha costCenterId=undefined (service devolve [])', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue([]);
    await GET(getRequest('cost_center_id=0'));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ costCenterId: undefined }));
  });

  it('500 quando o service falha', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockRejectedValue(new LookupServiceError('boom', 500));
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
  });
});
