import type { NextRequest } from 'next/server';
import { ok, fail, failFromError } from '@/lib/response';
import { requireAuth, getAuthenticatedUser, canSeeConta } from '@/lib/auth';
import { contaAttachmentService } from '@/lib/conta-attachments';

// /api/contas/:id/attachments — GET (lista) + POST (registra o anexo já enviado ao Storage).
// O POST é o passo 3 do fluxo de upload (ver lib/conta-attachments.ts): os BYTES não passam
// por aqui — o browser os envia direto ao Storage com a URL assinada de /attachments/upload-url.
//
// `canSeeConta` em TODA rota: o service lê por service_role (ignora RLS), então sem o guard um
// usuário de grupo restrito receberia os anexos — e os `storage_key` — de conta alheia.
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapError(e: unknown): Response {
  return failFromError(e, 'conta-attachments');
}

export async function GET(req: NextRequest, ctx: Context) {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const id = parseId((await ctx.params).id);
  if (id === null) return fail('Identificador de conta inválido', 400);

  try {
    // 404 (não 403) quando não pode ver: 403 revelaria que a conta existe.
    if (!(await canSeeConta(req, id))) return fail('Conta não encontrada', 404);
    return ok(await contaAttachmentService.list(id));
  } catch (e) {
    return mapError(e);
  }
}

export async function POST(req: NextRequest, ctx: Context) {
  // uploaded_by = autor do anexo (define quem pode removê-lo depois).
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
    return ok(await contaAttachmentService.register(id, body ?? {}, user.id), undefined, 201);
  } catch (e) {
    return mapError(e);
  }
}
