import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { userService } from '@/lib/users';

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
    return failFromError(e, 'auth/login');
  }
}
