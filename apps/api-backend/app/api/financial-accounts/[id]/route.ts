import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { financialAccountService } from '@/lib/financial-accounts';

// /api/financial-accounts/:id — GET + PATCH + DELETE. financial_account não tem
// sentinela nem FK reversa → exclusão livre (404 se inexistente).
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'financial-accounts');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);
  try {
    return ok(await financialAccountService.getById(id));
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    return ok(await financialAccountService.update(id, body ?? {}));
  } catch (e) {
    return mapError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);
  try {
    return ok(await financialAccountService.remove(id));
  } catch (e) {
    return mapError(e);
  }
}
