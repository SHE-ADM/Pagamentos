// lib/auth.ts
// Autenticação stateless das rotas da API (monorepo-crud-spec, Regra 3 do CLAUDE.md):
// sessão via header `Authorization: Bearer <token>`. O token é o access_token do
// Supabase Auth, validado contra o provedor (auth.getUser) com a chave anon —
// NUNCA a service_role. Usado pelo middleware para proteger /api/* (exceto health).

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { fail } from './response';
import { getSupabaseAdmin } from './supabase-admin';

// Grupo cuja associação libera operações restritas (hard delete dos cadastros).
// Fonte de verdade do vínculo usuário → grupo: public.user_profile (migration 065).
// `const` local (sem export): usado só neste módulo (requireAdminGroup). O frontend
// mantém a MESMA constante de forma independente (AuthContext.tsx) — é espelhamento de
// VALOR, não import cross-package. Ver achado A6-2.
const ADMIN_GROUP_ID = 1;

let anonClient: SupabaseClient | null = null;

// Lazy: as envs são lidas só no primeiro uso (não no import), para não lançar
// durante o build quando ainda não estão presentes. Exportado para reuso pelo
// login (lib/users.ts) — o mesmo client anon valida e autentica.
export function getAnonClient(): SupabaseClient {
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

// Resolve o usuário autenticado a partir do header Authorization, ou null quando
// não há token / o token é inválido. Diferente de requireAuth, devolve o próprio
// User (usado por GET /api/users/me). Pode lançar em falha de rede — o caller trata.
export async function getAuthenticatedUser(req: Request): Promise<User | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  return verifyBearerToken(token);
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

// Papel de admin lido de `app_metadata` — campo controlado pelo SERVIDOR (só gravável
// via Admin API / service_role; o usuário NÃO consegue alterá-lo, ao contrário de
// `user_metadata`). É a fonte confiável da claim de papel.
function isAdmin(user: User): boolean {
  const meta = user.app_metadata as { role?: string; roles?: string[] } | undefined;
  return meta?.role === 'admin' || (Array.isArray(meta?.roles) && meta.roles.includes('admin'));
}

// Porteiro ADMIN-ONLY: 401 sem sessão válida, 403 quando autenticado mas não-admin,
// null quando pode prosseguir. Usado na criação de usuário (sem auto-registro).
export async function requireAdmin(req: Request): Promise<Response | null> {
  const token = getBearerToken(req);
  if (!token) return fail('Autenticação necessária', 401);

  try {
    const user = await verifyBearerToken(token);
    if (!user) return fail('Sessão inválida ou expirada', 401);
    if (!isAdmin(user)) return fail('Acesso restrito a administradores', 403);
    return null;
  } catch {
    return fail('Falha ao validar a sessão', 500);
  }
}

// Resolve o group_id do usuário a partir de public.user_profile (fonte de verdade do
// vínculo — migration 065). Lê com service_role (ignora RLS): a autorização não pode
// depender da policy de leitura do próprio usuário. Perfil ausente → group_id 0
// (sentinela "não informado"). Lança em falha real de query (o caller devolve 500).
async function getUserGroupId(userId: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from('user_profile')
    .select('group_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.group_id ?? 0;
}

// Porteiro do GRUPO ADMINISTRADOR (user_profile.group_id = 1): 401 sem sessão válida,
// 403 quando autenticado mas fora do grupo, null quando pode prosseguir. É a trava REAL
// do hard delete dos cadastros — o gate de UI (isAdminGroup) é só cosmético.
export async function requireAdminGroup(req: Request): Promise<Response | null> {
  const token = getBearerToken(req);
  if (!token) return fail('Autenticação necessária', 401);

  try {
    const user = await verifyBearerToken(token);
    if (!user) return fail('Sessão inválida ou expirada', 401);
    const groupId = await getUserGroupId(user.id);
    if (groupId !== ADMIN_GROUP_ID) {
      return fail('Acesso restrito ao grupo Administrador', 403);
    }
    return null;
  } catch {
    return fail('Falha ao validar a sessão', 500);
  }
}
