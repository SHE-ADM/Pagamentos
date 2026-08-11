import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  canSeeConta: vi.fn(),
  requireAdminGroup: vi.fn(),
}));
vi.mock('@/lib/contas', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class ContaServiceError extends ApiServiceError {
    constructor(message: string, status: number) {
      super(message, status, 'ContaServiceError');
    }
  }
  return { contaService: { getById: vi.fn(), update: vi.fn(), remove: vi.fn() }, ContaServiceError };
});

import { GET, PATCH, DELETE } from './route';
import { requireAuth, getAuthenticatedUser, canSeeConta, requireAdminGroup } from '@/lib/auth';
import { contaService, ContaServiceError } from '@/lib/contas';

const requireAuthMock = vi.mocked(requireAuth);
const getUserMock = vi.mocked(getAuthenticatedUser);
const canSeeContaMock = vi.mocked(canSeeConta);
const requireAdminGroupMock = vi.mocked(requireAdminGroup);
const getByIdMock = vi.mocked(contaService.getById);
const updateMock = vi.mocked(contaService.update);
const removeMock = vi.mocked(contaService.remove);

const USER = { id: 'fe8d268d-2bc3-4418-8cae-65e426c3fb4e' };
const req = {} as NextRequest;
const patchReq = (jsonImpl: () => Promise<unknown>) => ({ json: jsonImpl }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset();
  getUserMock.mockReset();
  canSeeContaMock.mockReset();
  requireAdminGroupMock.mockReset();
  getByIdMock.mockReset();
  updateMock.mockReset();
  removeMock.mockReset();
  requireAuthMock.mockResolvedValue(null);
  getUserMock.mockResolvedValue(USER as never);
  canSeeContaMock.mockResolvedValue(true); // padrão: a conta é visível para quem pediu
  requireAdminGroupMock.mockResolvedValue(null); // padrão: usuário É do grupo Administrador
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

  // O service lê por service_role (ignora a RLS da 076): sem este guard, um usuário de grupo
  // restrito que forçasse um id alheio receberia a conta — e o `source_file` dela.
  it('404 quando a conta NÃO é visível para o usuário — não toca o service', async () => {
    canSeeContaMock.mockResolvedValue(false);
    const res = await GET(req, ctx('999'));
    expect(res.status).toBe(404); // 404, não 403: 403 revelaria que a conta existe
    expect(getByIdMock).not.toHaveBeenCalled();
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

  // Quem não pode VER também não pode EDITAR: a escrita passa por service_role, que ignora
  // a RLS — sem o guard, um PATCH forjado por id alteraria conta alheia.
  it('404 ao EDITAR conta que não é visível para o usuário — não toca o service', async () => {
    canSeeContaMock.mockResolvedValue(false);
    const res = await PATCH(patchReq(async () => ({ status: 'cancelado' })), ctx('999'));
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/contas/:id (hard delete — grupo Administrador)', () => {
  it('403 quando NÃO é do grupo Administrador — não toca o service', async () => {
    requireAdminGroupMock.mockResolvedValue(new Response(null, { status: 403 }));
    const res = await DELETE(req, ctx('5'));
    expect(res.status).toBe(403);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('400 quando o id é inválido — não toca o service', async () => {
    const res = await DELETE(req, ctx('abc'));
    expect(res.status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('200 e remove quando é do grupo Administrador', async () => {
    removeMock.mockResolvedValue({ id: 5 } as never);
    const res = await DELETE(req, ctx('5'));
    expect(res.status).toBe(200);
    // O id do usuário viaja junto: é ele que a trilha de auditoria (migration 117) grava como
    // autor do hard delete. Sem isso o evento mais destrutivo do sistema ficaria sem dono.
    expect(removeMock).toHaveBeenCalledWith(5, USER.id);
  });

  it('404 quando a conta não existe', async () => {
    removeMock.mockRejectedValue(new ContaServiceError('Conta não encontrada', 404));
    const res = await DELETE(req, ctx('9'));
    expect(res.status).toBe(404);
  });
});
