import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, requireAdmin } from '@/lib/auth';
import { chartAccountService } from '@/lib/chart-accounts';

// /api/chart-accounts/:id — GET + PATCH + DELETE (hard delete protegido). CRUD do
// plano de contas (lib/chart-accounts) — a cascata legada fica no GET sem `page`.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'chart-accounts');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de plano de contas inválido', 400);
  try {
    return ok(await chartAccountService.getById(id));
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de plano de contas inválido', 400);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    return ok(await chartAccountService.update(id, body ?? {}));
  } catch (e) {
    return mapError(e);
  }
}

// Hard delete é ADMIN-ONLY (requireAdmin → 403 para sessão não-admin).
export async function DELETE(req: NextRequest, ctx: Context) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de plano de contas inválido', 400);
  try {
    return ok(await chartAccountService.remove(id));
  } catch (e) {
    return mapError(e);
  }
}
