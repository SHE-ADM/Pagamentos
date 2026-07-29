import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Guard ADMIN-ONLY mockado: por padrão libera (null); um teste força o 403.
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => null) }));

// Mock do service — UserServiceError precisa ser classe real (a rota usa instanceof),
// compartilhada entre o mock e o SUT por vir do mesmo módulo mockado.
vi.mock('@/lib/users', async () => {
  const { ApiServiceError } = await vi.importActual<typeof import('@/lib/api-error')>('@/lib/api-error');
  class UserServiceError extends ApiServiceError {
    constructor(message: string, status: number) {
      super(message, status, 'UserServiceError');
    }
  }
  return { userService: { register: vi.fn() }, UserServiceError };
});

import { POST } from './route';
import { userService, UserServiceError } from '@/lib/users';
import { requireAdmin } from '@/lib/auth';
import { fail } from '@/lib/response';

const registerMock = vi.mocked(userService.register);
const requireAdminMock = vi.mocked(requireAdmin);

function makeRequest(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}

describe('POST /api/users', () => {
  beforeEach(() => {
    registerMock.mockReset();
    requireAdminMock.mockReset();
    requireAdminMock.mockResolvedValue(null); // por padrão: admin autenticado
  });

  it('403 quando a sessão NÃO é admin — não cria usuário', async () => {
    requireAdminMock.mockResolvedValue(fail('Acesso restrito a administradores', 403));
    const res = await POST(makeRequest(async () => ({ name: 'João', email: 'joao@exemplo.com', password: 'senha1234' })));
    expect(res.status).toBe(403);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('201 com { id, name, email } no sucesso', async () => {
    registerMock.mockResolvedValue({ id: 'u1', name: 'João', email: 'joao@exemplo.com' });
    const res = await POST(makeRequest(async () => ({ name: 'João', email: 'joao@exemplo.com', password: 'senha1234' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { id: 'u1', name: 'João', email: 'joao@exemplo.com' } });
  });

  it('409 quando o e-mail já existe', async () => {
    registerMock.mockRejectedValue(new UserServiceError('E-mail já cadastrado', 409));
    const res = await POST(makeRequest(async () => ({ name: 'João', email: 'dup@exemplo.com', password: 'senha1234' })));
    expect(res.status).toBe(409);
    expect((await res.json()).success).toBe(false);
  });

  it('422 quando o payload é inválido', async () => {
    registerMock.mockRejectedValue(new UserServiceError('Nome deve ter no mínimo 3 caracteres', 422));
    const res = await POST(makeRequest(async () => ({ email: 'x@x.com' })));
    expect(res.status).toBe(422);
  });
});
