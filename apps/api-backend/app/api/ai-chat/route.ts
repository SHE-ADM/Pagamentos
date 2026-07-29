// app/api/ai-chat/route.ts
// POST /api/ai-chat — pergunta em linguagem natural sobre contas a pagar.
//
// Envelope { success, data, error } como o resto da Next API. A leitura dos dados usa o JWT do
// PRÓPRIO usuário (getAnonClient + setHeader), nunca service_role: é o que faz a RLS decidir o
// recorte, exatamente como em `canSeeConta`.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getAnonClient, getAuthenticatedUser, getBearerToken } from '@/lib/auth';
import { ok, fail, failFromError } from '@/lib/response';
import { runChat } from '@/lib/ai-chat/gateway';
import { logInteraction } from '@/lib/ai-chat/log';
import { readPartialRun } from '@/lib/ai-chat/errors';

/**
 * Teto de duração da function (§17.1 — não remover).
 *
 * O default da Vercel para Node functions é de 10–15 s, e um loop de tool use com 2–3 iterações
 * — cada uma um round-trip ao modelo mais um RPC ao Postgres — passa disso na primeira pergunta
 * que combine agregado e drill-down. Sem esta linha, o gateway dá timeout em produção mesmo
 * funcionando perfeitamente em dev.
 */
export const maxDuration = 300;

const bodySchema = z.object({
  question: z.string().trim().min(3, 'Pergunta muito curta').max(2000, 'Pergunta muito longa'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(10_000),
      }),
    )
    .max(20, 'Histórico muito longo')
    // A Claude API exige alternância user/assistant. Um histórico ímpar (terminando em `user`)
    // colaria dois `user` seguidos com a pergunta nova — 400 do provedor, que o nosso contrato de
    // erro converte em 500 genérico. Melhor recusar aqui, com a causa dita.
    .refine(
      (h) => h.length % 2 === 0 && h.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')),
      'Histórico deve alternar user/assistant e terminar com a resposta do assistente',
    )
    .optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const started = Date.now();

  // getAuthenticatedUser (não requireAuth): precisamos do id para a trilha de auditoria.
  const user = await getAuthenticatedUser(req);
  const token = getBearerToken(req);
  if (!user || !token) return fail('Autenticação necessária', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('Corpo da requisição inválido', 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'Pergunta inválida', 422);
  }

  try {
    const result = await runChat(getAnonClient(), token, parsed.data);

    // Log ANTES de responder e aguardado (§17.3): em serverless a function congela no `return`,
    // então fire-and-forget perderia a auditoria silenciosamente.
    await logInteraction({
      userId: user.id,
      question: parsed.data.question,
      toolCalls: result.toolCalls,
      rowCount: result.rowCount,
      latencyMs: Date.now() - started,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheCreationTokens: result.cacheCreationTokens,
    });

    return ok({
      answer: result.answer,
      tool_calls: result.toolCalls.map((t) => ({ name: t.name, params: t.params, rows: t.rows })),
      truncated: result.truncated,
    });
  } catch (e) {
    // A pergunta que falhou também é auditada — é dela que sai "quais tools faltam" (§11).
    // O gateway anexa ao erro o que já havia gasto e apurado; zerar aqui faria a falha de uma
    // pergunta cara (5 iterações antes do 429) ser auditada como "0 tokens, 0 tools".
    const partial = readPartialRun(e);
    await logInteraction({
      userId: user.id,
      question: parsed.data.question,
      toolCalls: partial?.toolCalls ?? [],
      rowCount: partial?.rowCount ?? 0,
      latencyMs: Date.now() - started,
      inputTokens: partial?.inputTokens ?? 0,
      outputTokens: partial?.outputTokens ?? 0,
      cacheReadTokens: partial?.cacheReadTokens ?? 0,
      cacheCreationTokens: partial?.cacheCreationTokens ?? 0,
      error: e instanceof Error ? e.message : String(e),
    });
    return failFromError(e, 'ai-chat');
  }
}
