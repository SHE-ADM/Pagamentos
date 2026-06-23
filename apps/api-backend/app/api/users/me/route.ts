import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { getAuthenticatedUser } from '@/lib/auth';
import { userService } from '@/lib/users';

// GET /api/users/me — perfil do usuário autenticado. O middleware já protege a rota;
// aqui resolvemos o User para montar o perfil (defesa em profundidade no 401).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return fail('Sessão inválida ou expirada', 401);
    return ok(userService.getProfile(user));
  } catch {
    return fail('Falha ao validar a sessão', 500);
  }
}
