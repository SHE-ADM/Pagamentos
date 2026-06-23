import { describe, it, expect, vi, beforeEach } from 'vitest';

// Envs lidas no escopo do módulo (lib/supabase-admin lê no import).
vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');

// Mock do supabase-js: o mesmo client serve admin (createUser) e anon (signIn).
const createUser = vi.fn();
const signInWithPassword = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      admin: { createUser: (...a: unknown[]) => createUser(...a) },
      signInWithPassword: (...a: unknown[]) => signInWithPassword(...a),
    },
  }),
}));

import { userService } from './users';

const validRegister = { name: 'João Silva', email: 'joao@exemplo.com', password: 'senha1234' };

describe('userService.register', () => {
  beforeEach(() => {
    createUser.mockReset();
  });

  it('cria o usuário e devolve { id, name, email } SEM password_hash', async () => {
    createUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'joao@exemplo.com', user_metadata: { name: 'João Silva' } } },
      error: null,
    });

    const result = await userService.register(validRegister);

    expect(result).toEqual({ id: 'u1', name: 'João Silva', email: 'joao@exemplo.com' });
    expect(Object.keys(result)).not.toContain('password_hash');
  });

  it('e-mail já cadastrado → 409', async () => {
    createUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
    });

    await expect(userService.register(validRegister)).rejects.toMatchObject({ status: 409 });
  });

  it('payload inválido (sem nome) → 422', async () => {
    await expect(
      userService.register({ email: 'joao@exemplo.com', password: 'senha1234' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe('userService.login', () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
  });

  it('devolve { access_token, expires_in } da sessão', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'tok-123', expires_in: 3600 } },
      error: null,
    });

    const result = await userService.login({ email: 'joao@exemplo.com', password: 'senha1234' });

    expect(result).toEqual({ access_token: 'tok-123', expires_in: 3600 });
  });

  it('credencial inválida → 401', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid login credentials' },
    });

    await expect(
      userService.login({ email: 'joao@exemplo.com', password: 'errada12' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('userService.getProfile', () => {
  it('mapeia o User para o perfil público sem dados sensíveis', () => {
    const user = {
      id: 'u1',
      email: 'joao@exemplo.com',
      user_metadata: { name: 'João Silva' },
      created_at: '2026-06-23T00:00:00Z',
    } as never;

    const profile = userService.getProfile(user);

    expect(profile).toEqual({
      id: 'u1',
      name: 'João Silva',
      email: 'joao@exemplo.com',
      created_at: '2026-06-23T00:00:00Z',
    });
    expect(Object.keys(profile)).not.toContain('password_hash');
  });
});
