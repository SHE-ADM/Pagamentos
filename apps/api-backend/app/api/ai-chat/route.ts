// app/api/ai-chat/route.ts
// POST /api/ai-chat — pergunta em linguagem natural sobre contas a pagar, resposta em UMA peça.
//
// Envelope { success, data, error } como o resto da Next API. A leitura dos dados usa o JWT do
// PRÓPRIO usuário (getAnonClient + setHeader), nunca service_role: é o que faz a RLS decidir o
// recorte, exatamente como em `canSeeConta`.
//
// A rota IRMÃ `/api/ai-chat/stream` responde a mesma pergunta em SSE, mostrando o texto conforme
// ele é gerado. Esta aqui permanece como o caminho canônico e como FALLBACK do cliente: um
// intermediário que bufferize `text/event-stream` (proxy corporativo, extensão de navegador)
// quebra o streaming sem quebrar isto. As duas compartilham `lib/ai-chat/session.ts` — autenticar,
// validar, autorizar e auditar acontece em um lugar só.

import type { NextRequest } from 'next/server';
import { getAnonClient } from '@/lib/auth';
import { ok, failFromError } from '@/lib/response';
import { runChat } from '@/lib/ai-chat/gateway';
import {
  openChatSession,
  assertChatAllowed,
  auditSuccess,
  auditFailure,
} from '@/lib/ai-chat/session';

/**
 * Teto de duração da function (§17.1 — não remover).
 *
 * O default da Vercel para Node functions é de 10–15 s, e um loop de tool use com 2–3 iterações
 * — cada uma um round-trip ao modelo mais um RPC ao Postgres — passa disso na primeira pergunta
 * que combine agregado e drill-down. Sem esta linha, o gateway dá timeout em produção mesmo
 * funcionando perfeitamente em dev.
 */
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();

  const aberta = await openChatSession(req);
  if (!aberta.ok) return aberta.response;
  const { userId, token, request } = aberta.session;

  try {
    await assertChatAllowed(userId);

    // `req.signal` aborta quando o cliente desconecta (usuário clicou em "Parar", fechou a aba,
    // caiu a rede). Repassá-lo é o que faz o loop parar de gastar tokens numa resposta que ninguém
    // vai receber — ver `throwIfAborted` no gateway.
    const result = await runChat(getAnonClient(), token, request, req.signal);

    // Log ANTES de responder e aguardado (§17.3): em serverless a function congela no `return`,
    // então fire-and-forget perderia a auditoria silenciosamente.
    await auditSuccess({ userId, question: request.question, startedAt, result });

    return ok({
      answer: result.answer,
      tool_calls: result.toolCalls.map((t) => ({ name: t.name, params: t.params, rows: t.rows })),
      truncated: result.truncated,
    });
  } catch (e) {
    await auditFailure({ userId, question: request.question, startedAt, error: e });
    // `failFromError` cuida do 499: `AiChatAbortedError` estende ApiServiceError com status < 500,
    // então a mensagem curada ("Consulta cancelada.") é ecoada. Na prática ninguém a lê — o cliente
    // já foi —, mas a resposta permanece coerente com o resto da API.
    return failFromError(e, 'ai-chat');
  }
}
