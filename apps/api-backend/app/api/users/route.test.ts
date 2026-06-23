import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Mock do service — UserServiceError precisa ser classe real (a rota usa instanceof),
// compartilhada entre o mock e o SUT por vir do mesmo módulo mockado.
vi.mock('@/lib/users', () => {
  class UserServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'UserServiceError';
      this.status = status;
    }
  }
  return { userService: { register: vi.fn() }, UserServiceError };
});

import { POST } from './route';
import { userService, UserServiceError } from '@/lib/users';

const registerMock = vi.mocked(userService.register);

function makeRequest(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}

describe('POST /api/users', () => {
  beforeEach(() => {
    registerMock.mockReset();
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
