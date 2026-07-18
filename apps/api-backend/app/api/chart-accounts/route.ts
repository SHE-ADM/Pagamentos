import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { parseSortParams } from '@/lib/sort';
import { chartAccountService as chartAccountLookup } from '@/lib/lookups';
import { chartAccountService as chartAccountCrud } from '@/lib/chart-accounts';

// /api/chart-accounts — consumos do mesmo recurso, discriminados por query:
//  - COM `page`: listagem paginada + busca do CRUD "Plano de contas" (envelope com
//    `meta`, exclui o sentinela id 0 — lib/chart-accounts). Também alimenta o grid
//    mestre-detalhe (`cost_center_id` + `postable`).
//  - COM `description`: 2º select da CASCATA INVERTIDA — os centros de custo que compõem
//    o plano (descrição) escolhido (lib/lookups.listCentersForPlano).
//  - SEM `page`/`description`: 1º select da cascata — descrições distintas de planos
//    postáveis (lib/lookups.listPlanoDescriptions; aceita `search`).
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

// Cascata invertida — 1º select: descrições distintas de planos postáveis (aceita `search`).
async function listPlanoDescriptions(sp: URLSearchParams): Promise<Response> {
  const limitRaw = Number(sp.get('limit'));
  try {
    const data = await chartAccountLookup.listPlanoDescriptions({
      search: sp.get('search') ?? undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    return ok(data);
  } catch (e) {
    return failFromError(e, 'chart-accounts');
  }
}

// Cascata invertida — 2º select: centros de custo que compõem o plano (descrição) escolhido.
async function listCentersForPlano(sp: URLSearchParams): Promise<Response> {
  try {
    const data = await chartAccountLookup.listCentersForPlano({ description: sp.get('description') ?? undefined });
    return ok(data);
  } catch (e) {
    return failFromError(e, 'chart-accounts');
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  // `page` → CRUD paginado; `description` → centros do plano; senão → descrições de planos.
  if (sp.has('page')) return listPaginated(sp);
  if (sp.has('description')) return listCentersForPlano(sp);
  return listPlanoDescriptions(sp);
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
