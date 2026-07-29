import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), getAuthenticatedUser: vi.fn(), canSeeConta: vi.fn() }));
vi.mock('@/lib/conta-attachments', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class ContaAttachmentServiceError extends ApiServiceError {
    constructor(m: string, s: number) {
      super(m, s, 'ContaAttachmentServiceError');
    }
  }
  return {
    contaAttachmentService: { list: vi.fn(), register: vi.fn() },
    ContaAttachmentServiceError,
  };
});

import { GET, POST } from './route';
import { requireAuth, getAuthenticatedUser, canSeeConta } from '@/lib/auth';
import { contaAttachmentService, ContaAttachmentServiceError } from '@/lib/conta-attachments';

const requireAuthMock = vi.mocked(requireAuth);
const getUserMock = vi.mocked(getAuthenticatedUser);
const canSeeContaMock = vi.mocked(canSeeConta);
const listMock = vi.mocked(contaAttachmentService.list);
const registerMock = vi.mocked(contaAttachmentService.register);

const USER = { id: '11111111-1111-1111-1111-111111111111' };
const req = () => ({}) as unknown as NextRequest;
const jsonReq = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  getUserMock.mockReset().mockResolvedValue(USER as never);
  canSeeContaMock.mockReset().mockResolvedValue(true); // padrão: conta visível
  listMock.mockReset();
  registerMock.mockReset();
});

describe('GET /api/contas/:id/attachments', () => {
  it('401 sem sessão — não toca o service', async () => {
    requireAuthMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await GET(req(), ctx('5'))).status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('400 para id inválido', async () => {
    expect((await GET(req(), ctx('abc'))).status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('200 com a lista', async () => {
    listMock.mockResolvedValue([{ id: 1 }] as never);
    expect((await GET(req(), ctx('5'))).status).toBe(200);
  });

  it('404 quando a conta não existe', async () => {
    listMock.mockRejectedValue(new ContaAttachmentServiceError('Conta não encontrada', 404));
    expect((await GET(req(), ctx('9'))).status).toBe(404);
  });

  // O service lê por service_role (ignora a RLS da 076): sem o guard, um usuário de grupo
  // restrito receberia os anexos de conta alheia — e os `storage_key`, que dão o download.
  it('404 quando a conta NÃO é visível para o usuário — não toca o service', async () => {
    canSeeContaMock.mockResolvedValue(false);
    expect((await GET(req(), ctx('999'))).status).toBe(404);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/contas/:id/attachments', () => {
  it('401 sem sessão — o autor precisa ser identificado (uploaded_by)', async () => {
    getUserMock.mockResolvedValue(null);
    expect((await POST(jsonReq(async () => ({})), ctx('5'))).status).toBe(401);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('201 no registro, passando o id do usuário como autor', async () => {
    registerMock.mockResolvedValue({ id: 3 } as never);
    const res = await POST(jsonReq(async () => ({ storage_key: 'manual/5/x.pdf' })), ctx('5'));
    expect(res.status).toBe(201);
    expect(registerMock).toHaveBeenCalledWith(5, { storage_key: 'manual/5/x.pdf' }, USER.id);
  });

  it('422 quando a chave é de outra conta / objeto inexistente', async () => {
    registerMock.mockRejectedValue(new ContaAttachmentServiceError('Chave de anexo inválida para esta conta', 422));
    expect((await POST(jsonReq(async () => ({})), ctx('5'))).status).toBe(422);
  });

  it('404 ao registrar anexo em conta que não é visível — não toca o service', async () => {
    canSeeContaMock.mockResolvedValue(false);
    const res = await POST(jsonReq(async () => ({ storage_key: 'manual/999/x.pdf' })), ctx('999'));
    expect(res.status).toBe(404);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('corpo não-JSON não derruba o handler (vira {} e o service valida)', async () => {
    registerMock.mockRejectedValue(new ContaAttachmentServiceError('Chave do objeto ausente', 422));
    const res = await POST(
      jsonReq(() => Promise.reject(new Error('invalid json'))),
      ctx('5'),
    );
    expect(res.status).toBe(422);
    expect(registerMock).toHaveBeenCalledWith(5, {}, USER.id);
  });
});
