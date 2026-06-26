import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth } from '@/lib/auth';
import { supplierService } from '@/lib/suppliers';

// /api/suppliers/:sk — GET (por sk) + PATCH (update) + DELETE (soft delete).
// Protegido pelo middleware; o requireAuth no handler é defesa em profundidade.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ sk: string }> };

// sk_supplier é BIGINT — aceitar só inteiro positivo; caso contrário 400.
function parseSk(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'suppliers');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sk = parseSk((await ctx.params).sk);
  if (sk === null) return fail('Identificador de fornecedor inválido', 400);

  try {
    return ok(await supplierService.getBySk(sk));
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sk = parseSk((await ctx.params).sk);
  if (sk === null) return fail('Identificador de fornecedor inválido', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    return ok(await supplierService.update(sk, body ?? {}));
  } catch (e) {
    return mapError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const sk = parseSk((await ctx.params).sk);
  if (sk === null) return fail('Identificador de fornecedor inválido', 400);

  try {
    return ok(await supplierService.remove(sk, new Date().toISOString()));
  } catch (e) {
    return mapError(e);
  }
}
