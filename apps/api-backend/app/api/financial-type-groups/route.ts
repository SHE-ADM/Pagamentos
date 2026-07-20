import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { financialTypeGroupService } from '@/lib/lookups';

// /api/financial-type-groups — GET (catálogo `financial_type_group` para os lookups de
// "Natureza" (Grupos) e "Tipo" (Sub grupos)). ESCOPADO por `?scope=group|subgroup`
// (migration 094) — cada cadastro só recebe as opções que fazem sentido; sem `scope`,
// retorna todas (retrocompat). Read-only. Protegido pelo middleware; requireAuth =
// defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const scopeParam = req.nextUrl.searchParams.get('scope');
  const scope = scopeParam === 'group' || scopeParam === 'subgroup' ? scopeParam : undefined;
  try {
    return ok(await financialTypeGroupService.list({ scope }));
  } catch (e) {
    return failFromError(e, 'financial-type-groups');
  }
}
