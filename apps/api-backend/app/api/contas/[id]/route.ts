import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, getAuthenticatedUser } from '@/lib/auth';
import { contaService } from '@/lib/contas';

// /api/contas/:id — GET (por id) + PATCH (atualização parcial).
// SEM DELETE: a "remoção" é PATCH { status: 'cancelado' } (sem hard-delete).
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

// id é a PK BIGINT — aceitar só inteiro positivo; caso contrário 400.
function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'contas');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);

  try {
    return ok(await contaService.getById(id));
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  // Autoria (Etapa 2): precisamos do UUID do editor para carimbar updated_by/status_changed_by.
  const user = await getAuthenticatedUser(req);
  if (!user) return fail('Autenticação necessária', 401);

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    return ok(await contaService.update(id, body ?? {}, user.id));
  } catch (e) {
    return mapError(e);
  }
}
