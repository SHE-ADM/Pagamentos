import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Mock do guard e do service — a rota só orquestra getAuthenticatedUser + getProfile.
vi.mock('@/lib/auth', () => ({ getAuthenticatedUser: vi.fn() }));
vi.mock('@/lib/users', () => ({ userService: { getProfile: vi.fn() } }));

import { GET } from './route';
import { getAuthenticatedUser } from '@/lib/auth';
import { userService } from '@/lib/users';

const getUserMock = vi.mocked(getAuthenticatedUser);
const getProfileMock = vi.mocked(userService.getProfile);

function makeRequest(): NextRequest {
  return new Request('http://localhost/api/users/me') as unknown as NextRequest;
}

describe('GET /api/users/me', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getProfileMock.mockReset();
  });

  it('200 com o perfil quando autenticado', async () => {
    getUserMock.mockResolvedValue({ id: 'u1' } as never);
    getProfileMock.mockReturnValue({ id: 'u1', name: 'João', email: 'joao@exemplo.com', created_at: null });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: 'u1', name: 'João', email: 'joao@exemplo.com', created_at: null });
  });

  it('401 quando o token é inválido/expirado (usuário nulo)', async () => {
    getUserMock.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  it('500 quando a validação lança (ex.: rede)', async () => {
    getUserMock.mockRejectedValue(new Error('network'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
