import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { getAuthenticatedUser, canSeeConta } from '@/lib/auth';
import { contaAttachmentService } from '@/lib/conta-attachments';

// /api/contas/:id/attachments/:attId — DELETE (soft delete do anexo).
// É o ÚNICO delete do domínio de contas: a conta em si não tem hard nem soft delete
// ("remoção" = PATCH status_id=cancelado). Aqui o objeto PERMANECE no bucket; só a linha
// é marcada. Anexo vindo do e-mail (origin='pipeline') é auditoria → 403.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; attId: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function DELETE(req: NextRequest, ctx: Context) {
  // Quem remove precisa ser identificado: só o AUTOR do anexo ou o grupo Administrador.
  const user = await getAuthenticatedUser(req);
  if (!user) return fail('Autenticação necessária', 401);

  const { id: rawId, attId: rawAttId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) return fail('Identificador de conta inválido', 400);
  const attId = parseId(rawAttId);
  if (attId === null) return fail('Identificador de anexo inválido', 400);

  try {
    if (!(await canSeeConta(req, id))) return fail('Anexo não encontrado', 404);
    await contaAttachmentService.remove(id, attId, user.id);
    return ok({ id: attId });
  } catch (e) {
    return failFromError(e, 'conta-attachments');
  }
}
