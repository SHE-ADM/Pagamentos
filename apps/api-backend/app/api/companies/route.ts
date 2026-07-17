import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { companyService } from '@/lib/lookups';

// /api/companies — GET (lista do cadastro `company` para o lookup de EMPRESA PAGADORA no
// ContaForm — financial_account_control.sk_company). Read-only: a empresa é cadastrada no
// Supabase, não pelo app. Protegido pelo middleware; requireAuth = defesa em profundidade.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  try {
    return ok(await companyService.list());
  } catch (e) {
    return failFromError(e, 'companies');
  }
}
