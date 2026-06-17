// lib/auth.ts
// Autenticação stateless das rotas da API (monorepo-crud-spec, Regra 3 do CLAUDE.md):
// sessão via header `Authorization: Bearer <token>`. O token é o access_token do
// Supabase Auth, validado contra o provedor (auth.getUser) com a chave anon —
// NUNCA a service_role. Usado pelo middleware para proteger /api/* (exceto health).

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { fail } from './response';

let anonClient: SupabaseClient | null = null;

// Lazy: as envs são lidas só no primeiro uso (não no import), para não lançar
// durante o build quando ainda não estão presentes.
function getAnonClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY não configuradas no ambiente do servidor');
  }
  anonClient ??= createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return anonClient;
}

// Extrai o token do header Authorization: Bearer <token> (case-insensitive no esquema).
export function getBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

// Valida o token contra o Supabase Auth. Retorna o usuário ou null.
async function verifyBearerToken(token: string): Promise<User | null> {
  const { data, error } = await getAnonClient().auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

// Porteiro das rotas: devolve uma Response de erro (envelope padrão) quando a
// requisição não está autenticada, ou null quando pode prosseguir.
export async function requireAuth(req: Request): Promise<Response | null> {
  const token = getBearerToken(req);
  if (!token) return fail('Autenticação necessária', 401);

  try {
    const user = await verifyBearerToken(token);
    if (!user) return fail('Sessão inválida ou expirada', 401);
    return null;
  } catch {
    return fail('Falha ao validar a sessão', 500);
  }
}
