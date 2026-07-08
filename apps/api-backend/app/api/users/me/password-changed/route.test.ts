import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Auth e service mockados: a rota resolve o usuário e marca no app_metadata.
vi.mock('@/lib/auth', () => ({ getAuthenticatedUser: vi.fn() }));
vi.mock('@/lib/users', () => ({ userService: { markPasswordChanged: vi.fn() } }));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/auth';
import { userService } from '@/lib/users';

const authMock = vi.mocked(getAuthenticatedUser);
const markMock = vi.mocked(userService.markPasswordChanged);
const req = {} as unknown as NextRequest;

describe('POST /api/users/me/password-changed', () => {
  beforeEach(() => {
    authMock.mockReset();
    markMock.mockReset();
  });

  it('401 quando não há sessão válida — não marca nada', async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(markMock).not.toHaveBeenCalled();
  });

  it('200 marca password_changed do PRÓPRIO usuário autenticado', async () => {
    authMock.mockResolvedValue({ id: 'u1' } as never);
    markMock.mockResolvedValue(undefined);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(markMock).toHaveBeenCalledWith('u1');
    expect(await res.json()).toEqual({ success: true, data: { password_changed: true } });
  });

  it('500 genérico quando a Admin API falha (não vaza detalhe)', async () => {
    authMock.mockResolvedValue({ id: 'u1' } as never);
    markMock.mockRejectedValue(new Error('supabase admin boom'));
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).not.toContain('boom');
  });
});
