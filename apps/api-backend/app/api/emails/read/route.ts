import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/response';
import { triggerReader, PythonBridgeError } from '@/lib/python-bridge';

// Ação de disparo (não recurso CRUD): POST com corpo de parâmetros.
const readRequestSchema = z.object({
  days: z.number().int().min(0).max(365).optional(),
  markSeen: z.boolean().optional(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    rawBody = {};
  }

  const parsed = readRequestSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    return fail(`Parâmetros inválidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 422);
  }

  try {
    const summary = await triggerReader(parsed.data);
    return ok(summary);
  } catch (e) {
    if (e instanceof PythonBridgeError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : 'Erro inesperado', 500);
  }
}
