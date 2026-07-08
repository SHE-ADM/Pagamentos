import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAdmin } from '@/lib/auth';
import { userService } from '@/lib/users';

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
    // failFromError ecoa a mensagem curada de UserServiceError (4xx) e mascara
    // qualquer 5xx inesperado (config/SDK) como genérico — §3 M-2 (não vazar detalhe).
    return failFromError(e, 'users');
  }
}
