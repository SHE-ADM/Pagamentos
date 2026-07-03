import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, requireAdminGroup } from '@/lib/auth';
import { bankService } from '@/lib/banks';

// /api/banks/:id — GET (por id) + PATCH (update) + DELETE (hard delete protegido).
// Protegido pelo middleware; o requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

// bank_id é SMALLINT — só inteiro positivo (id 0 = sentinela, rejeitado aqui).
function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'banks');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de banco inválido', 400);
  try {
    return ok(await bankService.getById(id));
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de banco inválido', 400);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    return ok(await bankService.update(id, body ?? {}));
  } catch (e) {
    return mapError(e);
  }
}

// Hard delete é restrito ao GRUPO ADMINISTRADOR (requireAdminGroup → 403 fora do grupo).
export async function DELETE(req: NextRequest, ctx: Context) {
  const denied = await requireAdminGroup(req);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de banco inválido', 400);
  try {
    return ok(await bankService.remove(id));
  } catch (e) {
    return mapError(e);
  }
}
