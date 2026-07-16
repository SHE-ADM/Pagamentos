import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, getAuthenticatedUser, canSeeConta, requireAdminGroup } from '@/lib/auth';
import { contaService } from '@/lib/contas';

// /api/contas/:id — GET (por id) + PATCH (atualização parcial) + DELETE (hard delete).
// A "remoção" PADRÃO é PATCH { status_id: <cancelado> }; o HARD DELETE físico é uma
// exceção restrita ao GRUPO ADMINISTRADOR (requireAdminGroup → 403 fora do grupo).
//
// `canSeeConta` nas duas: o service lê/escreve por service_role, que IGNORA a RLS da 076 —
// sem o guard, um usuário de grupo restrito que forçasse um id alheio leria (e editaria) a
// conta de outro, apesar de a tela já a esconder. Quem não pode VER também não pode EDITAR.
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
    // 404 (não 403) quando não pode ver: 403 revelaria que a conta existe.
    if (!(await canSeeConta(req, id))) return fail('Conta não encontrada', 404);
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
    if (!(await canSeeConta(req, id))) return fail('Conta não encontrada', 404);
    return ok(await contaService.update(id, body ?? {}, user.id));
  } catch (e) {
    return mapError(e);
  }
}

// HARD DELETE físico — restrito ao GRUPO ADMINISTRADOR (requireAdminGroup → 403 fora do
// grupo). O grupo Administrador não tem restrição de visibilidade (vê tudo), então o gate
// de grupo já é suficiente — não precisa de canSeeConta. Exceção à regra de preservação;
// o caminho padrão de "remoção" continua sendo PATCH { status_id: <cancelado> }.
export async function DELETE(req: NextRequest, ctx: Context) {
  const denied = await requireAdminGroup(req);
  if (denied) return denied;

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);

  try {
    return ok(await contaService.remove(id));
  } catch (e) {
    return mapError(e);
  }
}
