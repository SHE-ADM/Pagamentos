import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { costCenterService } from '@/lib/cost-centers';

// /api/cost-centers/:id — GET (por id) + PATCH (update) + DELETE (hard delete).
// Protegido pelo middleware; o requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

// cost_center_id é SMALLINT IDENTITY — aceitar só inteiro positivo (id 0 = sentinela,
// rejeitado aqui antes de chegar ao service); caso contrário 400.
function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'cost-centers');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de centro de custo inválido', 400);

  try {
    return ok(await costCenterService.getById(id));
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de centro de custo inválido', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    return ok(await costCenterService.update(id, body ?? {}));
  } catch (e) {
    return mapError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de centro de custo inválido', 400);

  try {
    return ok(await costCenterService.remove(id));
  } catch (e) {
    return mapError(e);
  }
}
