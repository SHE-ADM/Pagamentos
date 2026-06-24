import type { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { chartAccountService, LookupServiceError } from '@/lib/lookups';

// /api/chart-accounts — GET (lista para o lookup de classificação contábil).
// Protegido pelo middleware; o requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const search = sp.get('search') ?? undefined;
  const limitRaw = Number(sp.get('limit'));
  const ccRaw = Number(sp.get('cost_center_id'));
  // Cascata: sem um centro de custo válido o service devolve [] (plano depende do centro).
  const costCenterId = Number.isInteger(ccRaw) && ccRaw > 0 ? ccRaw : undefined;

  try {
    const data = await chartAccountService.list({
      search,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      costCenterId,
    });
    return ok(data);
  } catch (e) {
    if (e instanceof LookupServiceError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}
