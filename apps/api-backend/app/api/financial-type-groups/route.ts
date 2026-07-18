import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { financialTypeGroupService } from '@/lib/lookups';

// /api/financial-type-groups — GET (catálogo `financial_type_group` para o lookup de
// NATUREZA contábil no CRUD de Grupos). Read-only. Protegido pelo middleware;
// requireAuth = defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  try {
    return ok(await financialTypeGroupService.list());
  } catch (e) {
    return failFromError(e, 'financial-type-groups');
  }
}
