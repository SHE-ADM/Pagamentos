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
vi.mock('@/lib/cost-centers', () => {
  class CostCenterServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'CostCenterServiceError';
      this.status = status;
    }
  }
  return { costCenterService: { list: vi.fn(), create: vi.fn() }, CostCenterServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { costCenterService as lookup, LookupServiceError } from '@/lib/lookups';
import { costCenterService as crud, CostCenterServiceError } from '@/lib/cost-centers';

const requireAuthMock = vi.mocked(requireAuth);
const lookupListMock = vi.mocked(lookup.list);
const crudListMock = vi.mocked(crud.list);
const crudCreateMock = vi.mocked(crud.create);

function getRequest(query = ''): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}
function postRequest(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  lookupListMock.mockReset();
  crudListMock.mockReset();
  crudCreateMock.mockReset();
});

describe('GET /api/cost-centers (lookup — sem page)', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(lookupListMock).not.toHaveBeenCalled();
  });

  it('200 com a lista (modo lookup) e não toca o CRUD', async () => {
    requireAuthMock.mockResolvedValue(null);
    lookupListMock.mockResolvedValue([{ cost_center_id: 1, cost_center_code: 'ADM', cost_center_description: 'Administrativo' }]);
    const res = await GET(getRequest('search=adm'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: [{ cost_center_id: 1, cost_center_code: 'ADM', cost_center_description: 'Administrativo' }],
    });
    expect(lookupListMock).toHaveBeenCalledWith({ search: 'adm', limit: undefined });
    expect(crudListMock).not.toHaveBeenCalled();
  });

  it('500 quando o lookup falha', async () => {
    requireAuthMock.mockResolvedValue(null);
    lookupListMock.mockRejectedValue(new LookupServiceError('boom', 500));
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
  });
});

describe('GET /api/cost-centers (CRUD paginado — com page)', () => {
  it('200 com data + meta e não toca o lookup', async () => {
    requireAuthMock.mockResolvedValue(null);
    crudListMock.mockResolvedValue({ data: [{ cost_center_id: 1 }] as never, total: 1, page: 1, limit: 20 });
    const res = await GET(getRequest('page=1&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [{ cost_center_id: 1 }], meta: { total: 1, page: 1, limit: 20 } });
    expect(lookupListMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/cost-centers', () => {
  beforeEach(() => requireAuthMock.mockResolvedValue(null));

  it('201 no sucesso', async () => {
    crudCreateMock.mockResolvedValue({ cost_center_id: 7, cost_center_code: 'NEW' } as never);
    const res = await POST(postRequest(async () => ({ cost_center_code: 'NEW', cost_center_description: 'Novo' })));
    expect(res.status).toBe(201);
  });

  it('409 quando o código já existe', async () => {
    crudCreateMock.mockRejectedValue(new CostCenterServiceError('Código já cadastrado', 409));
    const res = await POST(postRequest(async () => ({ cost_center_code: 'ADM', cost_center_description: 'X' })));
    expect(res.status).toBe(409);
  });

  it('422 quando o payload é inválido', async () => {
    crudCreateMock.mockRejectedValue(new CostCenterServiceError('Código é obrigatório', 422));
    const res = await POST(postRequest(async () => ({})));
    expect(res.status).toBe(422);
  });
});
