import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { costCenterService as costCenterLookup } from '@/lib/lookups';
import { costCenterService as costCenterCrud } from '@/lib/cost-centers';

// /api/cost-centers — dois consumos do mesmo recurso:
//  - SEM `page`: lookup do formulário de contas (lista completa p/ o react-select,
//    array em `data`, comportamento legado — lib/lookups). Inclui o sentinela? Não:
//    o lookup já filtra description IS NOT NULL.
//  - COM `page`: listagem paginada + busca do CRUD "Centro de custos" (envelope com
//    `meta`, exclui o sentinela id 0 — lib/cost-centers).
//  - POST: criação (CRUD).
// Protegido pelo middleware; o requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

// Modo CRUD paginado: envelope com `meta`, exclui o sentinela id 0.
async function listPaginated(sp: URLSearchParams): Promise<Response> {
  const page = Number(sp.get('page') ?? '1');
  const limit = Number(sp.get('limit') ?? '20');
  try {
    const result = await costCenterCrud.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search: sp.get('search') ?? undefined,
    });
    return ok(result.data, { total: result.total, page: result.page, limit: result.limit });
  } catch (e) {
    return failFromError(e, 'cost-centers');
  }
}

// Modo lookup (legado): lista completa para o select de classificação contábil.
async function listForLookup(sp: URLSearchParams): Promise<Response> {
  const limitRaw = Number(sp.get('limit'));
  try {
    const data = await costCenterLookup.list({
      search: sp.get('search') ?? undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    return ok(data);
  } catch (e) {
    return failFromError(e, 'cost-centers');
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  // `page` presente → CRUD paginado; ausente → lookup (o lookup nunca envia `page`).
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
    const data = await costCenterCrud.create(body ?? {});
    return ok(data, undefined, 201);
  } catch (e) {
    return failFromError(e, 'cost-centers');
  }
}
