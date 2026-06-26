import type { NextRequest } from 'next/server';
import { ok, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { financialAccountService } from '@/lib/financial-accounts';

// /api/financial-accounts — GET (lista paginada/busca) + POST (criação). CRUD do
// cadastro `financial_account` (contas bancárias/caixa). Sem modo lookup: nenhuma
// outra tela usa este cadastro como <select>. URL distinta de /api/contas
// (financial_account_control, lançamentos).
export const dynamic = 'force-dynamic';

function mapError(e: unknown): Response {
  return failFromError(e, 'financial-accounts');
}

export async function GET(req: NextRequest) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const page = Number(sp.get('page') ?? '1');
  const limit = Number(sp.get('limit') ?? '20');
  try {
    const r = await financialAccountService.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 20,
      search: sp.get('search') ?? undefined,
    });
    return ok(r.data, { total: r.total, page: r.page, limit: r.limit });
  } catch (e) {
    return mapError(e);
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
    return ok(await financialAccountService.create(body ?? {}), undefined, 201);
  } catch (e) {
    return mapError(e);
  }
}
