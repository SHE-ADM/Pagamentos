import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), requireAdminGroup: vi.fn() }));
vi.mock('@/lib/cost-centers', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class CostCenterServiceError extends ApiServiceError {
    constructor(message: string, status: number) {
      super(message, status, 'CostCenterServiceError');
    }
  }
  return {
    costCenterService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() },
    CostCenterServiceError,
  };
});

import { GET, PATCH, DELETE } from './route';
import { requireAuth, requireAdminGroup } from '@/lib/auth';
import { costCenterService, CostCenterServiceError } from '@/lib/cost-centers';

const requireAuthMock = vi.mocked(requireAuth);
const requireAdminGroupMock = vi.mocked(requireAdminGroup);
const getByIdMock = vi.mocked(costCenterService.getById);
const updateMock = vi.mocked(costCenterService.update);
const removeMock = vi.mocked(costCenterService.remove);

function req(): NextRequest {
  return {} as unknown as NextRequest;
}
function jsonReq(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  requireAdminGroupMock.mockReset().mockResolvedValue(null);
  getByIdMock.mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
});

describe('GET /api/cost-centers/:id', () => {
  it('400 para id inválido (0/sentinela)', async () => {
    const res = await GET(req(), ctx('0'));
    expect(res.status).toBe(400);
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it('200 com o centro encontrado', async () => {
    getByIdMock.mockResolvedValue({ cost_center_id: 5, cost_center_code: 'TI', cost_center_description: 'TI' });
    const res = await GET(req(), ctx('5'));
    expect(res.status).toBe(200);
  });

  it('404 quando não existe', async () => {
    getByIdMock.mockRejectedValue(new CostCenterServiceError('Centro de custo não encontrado', 404));
    const res = await GET(req(), ctx('9'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/cost-centers/:id', () => {
  it('200 no sucesso', async () => {
    updateMock.mockResolvedValue({ cost_center_id: 5, cost_center_code: 'TI', cost_center_description: 'Novo' });
    const res = await PATCH(jsonReq(async () => ({ cost_center_description: 'Novo' })), ctx('5'));
    expect(res.status).toBe(200);
  });

  it('409 quando o código colide', async () => {
    updateMock.mockRejectedValue(new CostCenterServiceError('Código já cadastrado', 409));
    const res = await PATCH(jsonReq(async () => ({ cost_center_code: 'ADM' })), ctx('5'));
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/cost-centers/:id', () => {
  it('200 no sucesso', async () => {
    removeMock.mockResolvedValue({ cost_center_id: 5 });
    const res = await DELETE(req(), ctx('5'));
    expect(res.status).toBe(200);
  });

  it('409 quando está em uso', async () => {
    removeMock.mockRejectedValue(new CostCenterServiceError('Centro de custo em uso e não pode ser excluído', 409));
    const res = await DELETE(req(), ctx('5'));
    expect(res.status).toBe(409);
  });

  it('403 quando não é admin (requireAdminGroup nega) — não toca o service', async () => {
    requireAdminGroupMock.mockResolvedValue(new Response(null, { status: 403 }));
    const res = await DELETE(req(), ctx('5'));
    expect(res.status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
