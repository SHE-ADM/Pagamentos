import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { chartAccountSubgroupService, ChartAccountSubgroupServiceError } from '@/lib/chart-account-subgroups';

// /api/chart-account-subgroups — GET de duplo modo (com `page` = CRUD paginado; sem
// `page` = lookup p/ o <select> de subgrupo no form de Plano de contas) + POST.
export const dynamic = 'force-dynamic';

const LOOKUP_LIMIT = 1000;

function mapError(e: unknown): Response {
  if (e instanceof ChartAccountSubgroupServiceError) return fail(e.message, e.status);
  return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
}

async function listPaginated(sp: URLSearchParams): Promise<Response> {
  const page = Number(sp.get('page') ?? '1');
  const limit = Number(sp.get('limit') ?? '20');
  try {
    const r = await chartAccountSubgroupService.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search: sp.get('search') ?? undefined,
    });
    return ok(r.data, { total: r.total, page: r.page, limit: r.limit });
  } catch (e) {
    return mapError(e);
  }
}

async function listForLookup(sp: URLSearchParams): Promise<Response> {
  try {
    const r = await chartAccountSubgroupService.list({ limit: LOOKUP_LIMIT, search: sp.get('search') ?? undefined });
    return ok(r.data);
  } catch (e) {
    return mapError(e);
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  return sp.has('page') ? listPaginated(sp) : listForLookup(sp);
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
    return ok(await chartAccountSubgroupService.create(body ?? {}), undefined, 201);
  } catch (e) {
    return mapError(e);
  }
}
