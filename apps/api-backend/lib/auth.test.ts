import { describe, it, expect, vi, beforeEach } from 'vitest';

// Envs necessárias antes de importar o módulo (lidas no escopo do módulo).
vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');

// Mock do supabase-js: createClient devolve um client cujo auth.getUser (validação do
// token) e from().select().eq().maybeSingle() (leitura de user_profile.group_id) são
// controlados por teste.
const getUser = vi.fn();
const maybeSingle = vi.fn();
// Query builder achatado (select/eq encadeáveis) para evitar aninhamento profundo.
const profileQuery = {
  select: () => profileQuery,
  eq: () => profileQuery,
  maybeSingle: () => maybeSingle(),
};
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: (...a: unknown[]) => getUser(...a) },
    from: () => profileQuery,
  }),
}));

import { getBearerToken, requireAuth, requireAdminGroup } from './auth';

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/contas', { headers });
}

describe('getBearerToken', () => {
  it('extrai o token de "Bearer <token>"', () => {
    expect(getBearerToken(reqWith({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
  });

  it('é case-insensitive no esquema', () => {
    expect(getBearerToken(reqWith({ authorization: 'bearer xyz' }))).toBe('xyz');
  });

  it('retorna null sem header ou com esquema errado', () => {
    expect(getBearerToken(reqWith({}))).toBeNull();
    expect(getBearerToken(reqWith({ authorization: 'Basic abc' }))).toBeNull();
    expect(getBearerToken(reqWith({ authorization: 'Bearer ' }))).toBeNull();
  });
});

describe('requireAuth', () => {
  beforeEach(() => {
    getUser.mockReset();
  });

  it('401 quando não há token', async () => {
    const res = await requireAuth(reqWith({}));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect((await res!.json()).success).toBe(false);
  });

  it('null (segue) quando o token é válido', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    const res = await requireAuth(reqWith({ authorization: 'Bearer good' }));
    expect(res).toBeNull();
    expect(getUser).toHaveBeenCalledWith('good');
  });

  it('401 quando o Supabase rejeita o token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    const res = await requireAuth(reqWith({ authorization: 'Bearer bad' }));
    expect(res!.status).toBe(401);
  });

  it('500 quando a validação lança (ex.: rede)', async () => {
    getUser.mockRejectedValue(new Error('network'));
    const res = await requireAuth(reqWith({ authorization: 'Bearer x' }));
    expect(res!.status).toBe(500);
  });
});

describe('requireAdminGroup', () => {
  beforeEach(() => {
    getUser.mockReset();
    maybeSingle.mockReset();
  });

  it('401 quando não há token', async () => {
    const res = await requireAdminGroup(reqWith({}));
    expect(res!.status).toBe(401);
  });

  it('401 quando o Supabase rejeita o token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    const res = await requireAdminGroup(reqWith({ authorization: 'Bearer bad' }));
    expect(res!.status).toBe(401);
  });

  it('null (segue) quando o usuário está no grupo Administrador (group_id=1)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    maybeSingle.mockResolvedValue({ data: { group_id: 1 }, error: null });
    const res = await requireAdminGroup(reqWith({ authorization: 'Bearer good' }));
    expect(res).toBeNull();
  });

  it('403 quando o usuário está em outro grupo', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u2' } }, error: null });
    maybeSingle.mockResolvedValue({ data: { group_id: 7 }, error: null });
    const res = await requireAdminGroup(reqWith({ authorization: 'Bearer good' }));
    expect(res!.status).toBe(403);
  });

  it('403 quando não há perfil (group_id ausente → 0)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u3' } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await requireAdminGroup(reqWith({ authorization: 'Bearer good' }));
    expect(res!.status).toBe(403);
  });

  it('500 quando a leitura do perfil falha', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u4' } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const res = await requireAdminGroup(reqWith({ authorization: 'Bearer good' }));
    expect(res!.status).toBe(500);
  });
});
