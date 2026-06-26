import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { requireAdmin } from '@/lib/auth';
import { userService, UserServiceError } from '@/lib/users';

// POST /api/users — cadastro ADMIN-ONLY: exige sessão com papel admin (app_metadata.role),
// não apenas estar logado. Sem auto-registro — a criação é operação de admin (auth-specs.md).
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const data = await userService.register(body ?? {});
    return ok(data, undefined, 201);
  } catch (e) {
    if (e instanceof UserServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}
