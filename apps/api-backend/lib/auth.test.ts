import { describe, it, expect, vi, beforeEach } from 'vitest';

// Envs necessárias antes de importar o módulo (lidas no escopo do módulo).
vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');

// Mock do supabase-js: createClient devolve um client cujo auth.getUser é
// controlado por teste.
const getUser = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: (...a: unknown[]) => getUser(...a) } }),
}));

import { getBearerToken, requireAuth } from './auth';

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
