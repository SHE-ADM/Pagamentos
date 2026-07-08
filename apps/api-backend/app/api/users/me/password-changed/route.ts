import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { getAuthenticatedUser } from '@/lib/auth';
import { userService } from '@/lib/users';

// POST /api/users/me/password-changed — marca em APP_METADATA (server-controlled) que o
// usuário definiu a própria senha (S1-1). Só o PRÓPRIO usuário autenticado se marca —
// nunca via campo client-writable (user_metadata). O middleware já exige Bearer; aqui
// resolvemos o User (defesa em profundidade no 401) e escrevemos via Admin API.
//
// BACKFILL: usuários criados antes desta mudança têm a marca em user_metadata (não em
// app_metadata) → precisam de app_metadata.password_changed=true (Admin API / SQL em
// auth.users.raw_app_meta_data), senão serão forçados a trocar a senha uma vez.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return fail('Sessão inválida ou expirada', 401);
    await userService.markPasswordChanged(user.id);
    return ok({ password_changed: true });
  } catch (e) {
    return failFromError(e, 'users');
  }
}
