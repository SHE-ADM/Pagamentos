import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { parseSortParams } from '@/lib/sort';
import { supplierService } from '@/lib/suppliers';

// /api/suppliers — GET (lista paginada/filtrada) + POST (criação).
// Protegido pelo middleware; o requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const page = Number(sp.get('page') ?? '1');
  const limit = Number(sp.get('limit') ?? '20');
  const search = sp.get('search') ?? undefined;

  try {
    const result = await supplierService.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search,
      // `sort` aceita o alias `name` (lookup) ou uma coluna do grid + `order`.
      ...parseSortParams(sp),
    });
    return ok(result.data, { total: result.total, page: result.page, limit: result.limit });
  } catch (e) {
    return failFromError(e, 'suppliers');
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
    const data = await supplierService.create(body ?? {});
    return ok(data, undefined, 201);
  } catch (e) {
    return failFromError(e, 'suppliers');
  }
}
