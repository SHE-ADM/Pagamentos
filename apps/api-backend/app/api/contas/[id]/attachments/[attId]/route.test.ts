import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ getAuthenticatedUser: vi.fn(), canSeeConta: vi.fn() }));
vi.mock('@/lib/conta-attachments', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class ContaAttachmentServiceError extends ApiServiceError {
    constructor(m: string, s: number) {
      super(m, s, 'ContaAttachmentServiceError');
    }
  }
  return { contaAttachmentService: { remove: vi.fn() }, ContaAttachmentServiceError };
});

import { DELETE } from './route';
import { getAuthenticatedUser, canSeeConta } from '@/lib/auth';
import { contaAttachmentService, ContaAttachmentServiceError } from '@/lib/conta-attachments';

const getUserMock = vi.mocked(getAuthenticatedUser);
const canSeeContaMock = vi.mocked(canSeeConta);
const removeMock = vi.mocked(contaAttachmentService.remove);

const USER = { id: '11111111-1111-1111-1111-111111111111' };
const req = () => ({}) as unknown as NextRequest;
const ctx = (id: string, attId: string) => ({ params: Promise.resolve({ id, attId }) });

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue(USER as never);
  canSeeContaMock.mockReset().mockResolvedValue(true); // padrão: conta visível
  removeMock.mockReset();
});

describe('DELETE /api/contas/:id/attachments/:attId', () => {
  it('401 sem sessão — a remoção depende de saber QUEM remove', async () => {
    getUserMock.mockResolvedValue(null);
    expect((await DELETE(req(), ctx('5', '3'))).status).toBe(401);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('400 para id de conta inválido', async () => {
    expect((await DELETE(req(), ctx('0', '3'))).status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('400 para id de anexo inválido', async () => {
    expect((await DELETE(req(), ctx('5', 'abc'))).status).toBe(400);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('200 no soft delete, passando o usuário para a checagem de autoria', async () => {
    removeMock.mockResolvedValue(undefined);
    const res = await DELETE(req(), ctx('5', '3'));
    expect(res.status).toBe(200);
    expect(removeMock).toHaveBeenCalledWith(5, 3, USER.id);
  });

  it('403 no anexo vindo do e-mail (auditoria)', async () => {
    removeMock.mockRejectedValue(
      new ContaAttachmentServiceError('O anexo recebido por e-mail não pode ser removido', 403),
    );
    expect((await DELETE(req(), ctx('5', '3'))).status).toBe(403);
  });

  it('403 no anexo manual de outro usuário', async () => {
    removeMock.mockRejectedValue(new ContaAttachmentServiceError('Só quem enviou o anexo pode removê-lo', 403));
    expect((await DELETE(req(), ctx('5', '3'))).status).toBe(403);
  });

  it('404 quando não existe / é de outra conta', async () => {
    removeMock.mockRejectedValue(new ContaAttachmentServiceError('Anexo não encontrado', 404));
    expect((await DELETE(req(), ctx('5', '3'))).status).toBe(404);
  });

  // Sem o guard, um usuário de grupo restrito removeria anexo de conta alheia (o service
  // opera por service_role, que ignora a RLS).
  it('404 quando a conta não é visível para o usuário — não toca o service', async () => {
    canSeeContaMock.mockResolvedValue(false);
    expect((await DELETE(req(), ctx('999', '3'))).status).toBe(404);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
