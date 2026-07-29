import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/lookups', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class LookupServiceError extends ApiServiceError {
    constructor(m: string, s: number) {
      super(m, s, 'LookupServiceError');
    }
  }
  return { statusService: { list: vi.fn() }, LookupServiceError };
});

import { GET } from './route';
import { requireAuth } from '@/lib/auth';
import { statusService, LookupServiceError } from '@/lib/lookups';

const requireAuthMock = vi.mocked(requireAuth);
const listMock = vi.mocked(statusService.list);

const req = () => ({}) as unknown as NextRequest;

beforeEach(() => {
  requireAuthMock.mockReset();
  listMock.mockReset();
});

describe('GET /api/statuses', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    expect((await GET(req())).status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 com a lista', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockResolvedValue([{ status_id: 1, status_name: 'pendente' }]);
    const body = await (await GET(req())).json();
    expect(body).toEqual({ success: true, data: [{ status_id: 1, status_name: 'pendente' }] });
  });

  it('500 quando o service falha', async () => {
    requireAuthMock.mockResolvedValue(null);
    listMock.mockRejectedValue(new LookupServiceError('boom', 500));
    expect((await GET(req())).status).toBe(500);
  });
});
