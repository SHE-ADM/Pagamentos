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
  return {
    chartAccountService: { listPlanoDescriptions: vi.fn(), listCentersForPlano: vi.fn() },
    LookupServiceError,
  };
});
vi.mock('@/lib/chart-accounts', () => {
  class ChartAccountServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ChartAccountServiceError';
      this.status = status;
    }
  }
  return { chartAccountService: { list: vi.fn(), create: vi.fn() }, ChartAccountServiceError };
});

import { GET, POST } from './route';
import { requireAuth } from '@/lib/auth';
import { chartAccountService as lookup, LookupServiceError } from '@/lib/lookups';
import { chartAccountService as crud, ChartAccountServiceError } from '@/lib/chart-accounts';

const requireAuthMock = vi.mocked(requireAuth);
const planoDescMock = vi.mocked(lookup.listPlanoDescriptions);
const centersMock = vi.mocked(lookup.listCentersForPlano);
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
  planoDescMock.mockReset();
  centersMock.mockReset();
  crudListMock.mockReset();
  crudCreateMock.mockReset();
});

describe('GET /api/chart-accounts (cascata invertida — lookup)', () => {
  it('401 quando não autenticado', async () => {
    requireAuthMock.mockResolvedValue(Response.json({ success: false, error: 'x' }, { status: 401 }));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect(planoDescMock).not.toHaveBeenCalled();
  });

  it('sem page/description → 1º select: descrições de planos (encaminha search)', async () => {
    requireAuthMock.mockResolvedValue(null);
    planoDescMock.mockResolvedValue([] as never);
    await GET(getRequest('search=serv'));
    expect(planoDescMock).toHaveBeenCalledWith(expect.objectContaining({ search: 'serv' }));
    expect(centersMock).not.toHaveBeenCalled();
    expect(crudListMock).not.toHaveBeenCalled();
  });

  it('com description → 2º select: centros do plano (não toca o CRUD)', async () => {
    requireAuthMock.mockResolvedValue(null);
    centersMock.mockResolvedValue([] as never);
    await GET(getRequest('description=Hospedagens'));
    expect(centersMock).toHaveBeenCalledWith({ description: 'Hospedagens' });
    expect(planoDescMock).not.toHaveBeenCalled();
    expect(crudListMock).not.toHaveBeenCalled();
  });

  it('500 quando o lookup falha', async () => {
    requireAuthMock.mockResolvedValue(null);
    planoDescMock.mockRejectedValue(new LookupServiceError('boom', 500));
    const res = await GET(getRequest());
    expect(res.status).toBe(500);
  });
});

describe('GET /api/chart-accounts (CRUD paginado — com page)', () => {
  it('200 com data + meta e não toca o lookup', async () => {
    requireAuthMock.mockResolvedValue(null);
    crudListMock.mockResolvedValue({ data: [{ chart_account_id: 1 }] as never, total: 1, page: 1, limit: 20 });
    const res = await GET(getRequest('page=1&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: [{ chart_account_id: 1 }], meta: { total: 1, page: 1, limit: 20 } });
    expect(planoDescMock).not.toHaveBeenCalled();
  });

  it('encaminha cost_center_id + postable ao CRUD (grid complementar)', async () => {
    requireAuthMock.mockResolvedValue(null);
    crudListMock.mockResolvedValue({ data: [] as never, total: 0, page: 1, limit: 20 });
    await GET(getRequest('page=1&limit=20&cost_center_id=42&postable=true'));
    expect(crudListMock).toHaveBeenCalledWith(
      expect.objectContaining({ costCenterId: 42, postableOnly: true }),
    );
    expect(planoDescMock).not.toHaveBeenCalled();
  });

  it('cost_center_id inválido no CRUD → costCenterId=undefined e postableOnly=false', async () => {
    requireAuthMock.mockResolvedValue(null);
    crudListMock.mockResolvedValue({ data: [] as never, total: 0, page: 1, limit: 20 });
    await GET(getRequest('page=1&cost_center_id=0'));
    expect(crudListMock).toHaveBeenCalledWith(
      expect.objectContaining({ costCenterId: undefined, postableOnly: false }),
    );
  });
});

describe('POST /api/chart-accounts', () => {
  beforeEach(() => requireAuthMock.mockResolvedValue(null));

  it('201 no sucesso', async () => {
    crudCreateMock.mockResolvedValue({ chart_account_id: 9 } as never);
    const res = await POST(postRequest(async () => ({ account_code: '1.1', account_description: 'X' })));
    expect(res.status).toBe(201);
  });

  it('409 quando o código já existe', async () => {
    crudCreateMock.mockRejectedValue(new ChartAccountServiceError('Código já cadastrado', 409));
    const res = await POST(postRequest(async () => ({ account_code: '1.1', account_description: 'X' })));
    expect(res.status).toBe(409);
  });
});
