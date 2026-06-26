import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { chartAccountService as chartAccountLookup, LookupServiceError } from '@/lib/lookups';
import { chartAccountService as chartAccountCrud, ChartAccountServiceError } from '@/lib/chart-accounts';

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
  try {
    const r = await chartAccountCrud.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search: sp.get('search') ?? undefined,
    });
    return ok(r.data, { total: r.total, page: r.page, limit: r.limit });
  } catch (e) {
    if (e instanceof ChartAccountServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
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
    if (e instanceof LookupServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
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
    if (e instanceof ChartAccountServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}
