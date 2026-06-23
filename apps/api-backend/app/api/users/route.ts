import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { userService, UserServiceError } from '@/lib/users';

// POST /api/users — cadastro ADMIN-ONLY (o middleware já exige Bearer válido).
// Não há auto-registro: a criação é uma operação de admin (auth-specs.md).
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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
