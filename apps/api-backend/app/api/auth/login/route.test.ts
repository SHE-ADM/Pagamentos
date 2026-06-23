import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/users', () => {
  class UserServiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'UserServiceError';
      this.status = status;
    }
  }
  return { userService: { login: vi.fn() }, UserServiceError };
});

import { POST } from './route';
import { userService, UserServiceError } from '@/lib/users';

const loginMock = vi.mocked(userService.login);

function makeRequest(jsonImpl: () => Promise<unknown>): NextRequest {
  return { json: jsonImpl } as unknown as NextRequest;
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it('200 com { access_token, expires_in } no sucesso', async () => {
    loginMock.mockResolvedValue({ access_token: 'tok-123', expires_in: 3600 });
    const res = await POST(makeRequest(async () => ({ email: 'joao@exemplo.com', password: 'senha1234' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { access_token: 'tok-123', expires_in: 3600 } });
  });

  it('401 quando a credencial é inválida', async () => {
    loginMock.mockRejectedValue(new UserServiceError('E-mail ou senha incorretos', 401));
    const res = await POST(makeRequest(async () => ({ email: 'joao@exemplo.com', password: 'errada12' })));
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });
});
