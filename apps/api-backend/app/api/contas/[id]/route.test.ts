import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), getAuthenticatedUser: vi.fn() }));
vi.mock('@/lib/contas', () => {
  class ContaServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ContaServiceError';
      this.status = status;
    }
  }
  return { contaService: { getById: vi.fn(), update: vi.fn() }, ContaServiceError };
});

import { GET, PATCH } from './route';
import { requireAuth, getAuthenticatedUser } from '@/lib/auth';
import { contaService, ContaServiceError } from '@/lib/contas';

const requireAuthMock = vi.mocked(requireAuth);
const getUserMock = vi.mocked(getAuthenticatedUser);
const getByIdMock = vi.mocked(contaService.getById);
const updateMock = vi.mocked(contaService.update);

const USER = { id: 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e' };
const req = {} as NextRequest;
const patchReq = (jsonImpl: () => Promise<unknown>) => ({ json: jsonImpl }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset();
  getUserMock.mockReset();
  getByIdMock.mockReset();
  updateMock.mockReset();
  requireAuthMock.mockResolvedValue(null);
  getUserMock.mockResolvedValue(USER as never);
});

describe('GET /api/contas/:id', () => {
  it('400 quando o id é inválido', async () => {
    const res = await GET(req, ctx('abc'));
    expect(res.status).toBe(400);
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it('404 quando a conta não existe', async () => {
    getByIdMock.mockRejectedValue(new ContaServiceError('Conta não encontrada', 404));
    const res = await GET(req, ctx('9'));
    expect(res.status).toBe(404);
  });

  it('200 quando encontrada', async () => {
    getByIdMock.mockResolvedValue({ id: 5 } as never);
    const res = await GET(req, ctx('5'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/contas/:id', () => {
  it('200 ao cancelar e propaga o user.id (autoria) ao service', async () => {
    updateMock.mockResolvedValue({ id: 5, status: 'cancelado' } as never);
    const res = await PATCH(patchReq(async () => ({ status: 'cancelado' })), ctx('5'));
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(5, { status: 'cancelado' }, USER.id);
  });

  it('401 quando não autenticado — não toca o service', async () => {
    getUserMock.mockResolvedValue(null);
    const res = await PATCH(patchReq(async () => ({ status: 'cancelado' })), ctx('5'));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('404 quando a conta não existe', async () => {
    updateMock.mockRejectedValue(new ContaServiceError('Conta não encontrada', 404));
    const res = await PATCH(patchReq(async () => ({ status: 'cancelado' })), ctx('9'));
    expect(res.status).toBe(404);
  });
});
