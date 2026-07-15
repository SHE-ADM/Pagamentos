import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, canSeeConta } from '@/lib/auth';
import { contaAttachmentService } from '@/lib/conta-attachments';

// /api/contas/:id/attachments/upload-url — passo 1 do upload: autoriza o envio e devolve a
// URL assinada + a chave gerada PELO SERVIDOR. POST (não GET) porque o corpo descreve o
// arquivo (nome/mime/tamanho) e a chamada tem efeito: emite uma credencial de escrita.
//
// Rota ESTÁTICA convivendo com a dinâmica [attId] no mesmo nível: o Next dá precedência à
// estática, e os métodos nem colidem (POST aqui, DELETE lá).
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(req: NextRequest, ctx: Context) {
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
    // Sem isto, um usuário de grupo restrito receberia uma credencial de ESCRITA no Storage
    // para a conta de outro (o service lê por service_role, que ignora a RLS).
    if (!(await canSeeConta(req, id))) return fail('Conta não encontrada', 404);
    return ok(await contaAttachmentService.createUploadUrl(id, body ?? {}));
  } catch (e) {
    return failFromError(e, 'conta-attachments');
  }
}
