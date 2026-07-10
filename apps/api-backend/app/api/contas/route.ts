import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, getAuthenticatedUser } from '@/lib/auth';
import { contaService } from '@/lib/contas';

// /api/contas — GET (lista paginada/filtrada) + POST (criação).
// Protegido pelo middleware; requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const page = Number(sp.get('page') ?? '1');
  const limit = Number(sp.get('limit') ?? '20');
  const search = sp.get('search') ?? undefined;

  try {
    const result = await contaService.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search,
    });
    return ok(result.data, { total: result.total, page: result.page, limit: result.limit });
  } catch (e) {
    return failFromError(e, 'contas');
  }
}

export async function POST(req: NextRequest) {
  // Autoria (visibilidade por dono): precisamos do UUID do usuário logado, não só do gate.
  const user = await getAuthenticatedUser(req);
  if (!user) return fail('Autenticação necessária', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const data = await contaService.create(body ?? {}, user.id);
    return ok(data, undefined, 201);
  } catch (e) {
    return failFromError(e, 'contas');
  }
}
