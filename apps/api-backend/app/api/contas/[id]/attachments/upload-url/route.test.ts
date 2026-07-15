import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(), canSeeConta: vi.fn() }));
vi.mock('@/lib/conta-attachments', () => {
  class ContaAttachmentServiceError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  }
  return { contaAttachmentService: { createUploadUrl: vi.fn() }, ContaAttachmentServiceError };
});

import { POST } from './route';
import { requireAuth, canSeeConta } from '@/lib/auth';
import { contaAttachmentService, ContaAttachmentServiceError } from '@/lib/conta-attachments';

const requireAuthMock = vi.mocked(requireAuth);
const canSeeContaMock = vi.mocked(canSeeConta);
const createUploadUrlMock = vi.mocked(contaAttachmentService.createUploadUrl);

const jsonReq = (json: () => Promise<unknown>) => ({ json }) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const PDF = { file_name: 'b.pdf', mime_type: 'application/pdf', size_bytes: 10 };

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(null);
  canSeeContaMock.mockReset().mockResolvedValue(true); // padrão: conta visível
  createUploadUrlMock.mockReset();
});

describe('POST /api/contas/:id/attachments/upload-url', () => {
  it('401 sem sessão — não emite credencial de escrita no Storage', async () => {
    requireAuthMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await POST(jsonReq(async () => PDF), ctx('5'))).status).toBe(401);
    expect(createUploadUrlMock).not.toHaveBeenCalled();
  });

  it('400 para id inválido', async () => {
    expect((await POST(jsonReq(async () => PDF), ctx('-1'))).status).toBe(400);
    expect(createUploadUrlMock).not.toHaveBeenCalled();
  });

  it('200 devolvendo a chave do servidor + url assinada', async () => {
    createUploadUrlMock.mockResolvedValue({
      storage_key: 'manual/5/x.pdf',
      signed_url: 'https://storage.test/s',
      token: 'tok',
    });
    const res = await POST(jsonReq(async () => PDF), ctx('5'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { storage_key: 'manual/5/x.pdf' } });
  });

  it('422 para tipo/tamanho não permitido', async () => {
    createUploadUrlMock.mockRejectedValue(new ContaAttachmentServiceError('Arquivo maior que o limite de 10 MB', 422));
    expect((await POST(jsonReq(async () => PDF), ctx('5'))).status).toBe(422);
  });

  it('404 quando a conta não existe', async () => {
    createUploadUrlMock.mockRejectedValue(new ContaAttachmentServiceError('Conta não encontrada', 404));
    expect((await POST(jsonReq(async () => PDF), ctx('9'))).status).toBe(404);
  });

  // Sem o guard, um usuário de grupo restrito obteria uma credencial de ESCRITA no Storage
  // para a conta de outro (o service valida por service_role, que ignora a RLS).
  it('404 quando a conta não é visível — NÃO emite credencial de escrita', async () => {
    canSeeContaMock.mockResolvedValue(false);
    expect((await POST(jsonReq(async () => PDF), ctx('999'))).status).toBe(404);
    expect(createUploadUrlMock).not.toHaveBeenCalled();
  });
});
