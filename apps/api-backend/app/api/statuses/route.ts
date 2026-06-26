import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { statusService } from '@/lib/lookups';

// /api/statuses — GET (lista da dimensão `status` para o lookup de situação no CRUD
// de contas). Read-only. Protegido pelo middleware; requireAuth = defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  try {
    return ok(await statusService.list());
  } catch (e) {
    return failFromError(e, 'statuses');
  }
}
