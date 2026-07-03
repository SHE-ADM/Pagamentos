import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { parseSortParams } from '@/lib/sort';
import { chartAccountService as chartAccountLookup } from '@/lib/lookups';
import { chartAccountService as chartAccountCrud } from '@/lib/chart-accounts';

// /api/chart-accounts — dois consumos do mesmo recurso:
//  - SEM `page`: lookup da CASCATA de classificação contábil (filtra por
//    `cost_center_id`, só postáveis — lib/lookups). Comportamento legado, INTOCADO.
//  - COM `page`: listagem paginada + busca do CRUD "Plano de contas" (envelope com
//    `meta`, exclui o sentinela id 0 — lib/chart-accounts).
//  - POST: criação (CRUD).
export const dynamic = 'force-dynamic';

// Modo CRUD paginado: envelope com `meta`, exclui o sentinela id 0.
async function listPaginated(sp: URLSearchParams): Promise<Response> {
  const page = Number(sp.get('page') ?? '1');
  const limit = Number(sp.get('limit') ?? '20');
  // Filtros do grid complementar (plano de contas de um centro de custo): centro válido > 0.
  const ccRaw = Number(sp.get('cost_center_id'));
  const costCenterId = Number.isInteger(ccRaw) && ccRaw > 0 ? ccRaw : undefined;
  try {
    const r = await chartAccountCrud.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search: sp.get('search') ?? undefined,
      costCenterId,
      postableOnly: sp.get('postable') === 'true',
      ...parseSortParams(sp),
    });
    return ok(r.data, { total: r.total, page: r.page, limit: r.limit });
  } catch (e) {
    return failFromError(e, 'chart-accounts');
  }
}

// Modo lookup (legado): cascata por centro de custo, só postáveis.
async function listForLookup(sp: URLSearchParams): Promise<Response> {
  const limitRaw = Number(sp.get('limit'));
  const ccRaw = Number(sp.get('cost_center_id'));
  // Cascata: sem um centro de custo válido o service devolve [] (plano depende do centro).
  const costCenterId = Number.isInteger(ccRaw) && ccRaw > 0 ? ccRaw : undefined;
  try {
    const data = await chartAccountLookup.list({
      search: sp.get('search') ?? undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      costCenterId,
    });
    return ok(data);
  } catch (e) {
    return failFromError(e, 'chart-accounts');
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  // `page` presente → CRUD paginado; ausente → lookup da cascata (nunca envia `page`).
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
    return ok(await chartAccountCrud.create(body ?? {}), undefined, 201);
  } catch (e) {
    return failFromError(e, 'chart-accounts');
  }
}
