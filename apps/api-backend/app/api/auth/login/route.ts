import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { userService, UserServiceError } from '@/lib/users';

// POST /api/auth/login — autenticação pública (exceção no matcher do middleware).
// Devolve o access_token do Supabase; a expiração é controlada pelo provedor.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const data = await userService.login(body ?? {});
    return ok(data);
  } catch (e) {
    if (e instanceof UserServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}
