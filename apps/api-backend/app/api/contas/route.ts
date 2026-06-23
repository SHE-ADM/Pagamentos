import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { contaService, ContaServiceError } from '@/lib/contas';

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
    if (e instanceof ContaServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const data = await contaService.create(body ?? {});
    return ok(data, undefined, 201);
  } catch (e) {
    if (e instanceof ContaServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}
