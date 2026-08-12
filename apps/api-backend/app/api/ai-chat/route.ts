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
import { AiChatAbortedError, readPartialRun } from '@/lib/ai-chat/errors';
import { assertWithinRateLimit } from '@/lib/ai-chat/rate-limit';
import { assertAiChatAllowed } from '@/lib/ai-chat/gate';

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
    // Os dois porteiros ficam ANTES de qualquer chamada paga ao modelo, e dentro do `try` de
    // propósito: o 403 e o 429 que eles lançam são AiChatError e precisam passar pelo mesmo
    // caminho de auditoria dos demais — uma tentativa barrada também é sinal de uso (e, no caso do
    // gate, é o sinal de "quem está pedindo acesso"), e some do `ai_chat_log` se escapar do catch.
    //
    // 🔴 A ORDEM É ESTRUTURAL, não convenção: `assertWithinRateLimit` CONSOME o retorno do gate,
    // então trocar as duas linhas não compila. Vale a mesma observação do AiChatWidget sobre a
    // exclusão mútua — quando a garantia é estrutural, não se acrescenta uma verificação em runtime
    // para repeti-la. Autorização primeiro também é o mais barato: uma busca por PK numa tabela de
    // 13 linhas antes de duas contagens sobre uma tabela que cresce para sempre.
    //
    // ⚠️ Consequência aceita: as tentativas de um usuário NEGADO não passam pela cota, então ele
    // poderia inflar o `ai_chat_log`. Limitado na prática (usuários internos autenticados, e o
    // widget nem é renderizado para ele). Se um dia incomodar, a saída é mover o gate para depois
    // do rate limit — ao custo de o usuário negado receber um 429 enganoso na 31ª tentativa.
    const gate = await assertAiChatAllowed(user.id); // AUTORIZAÇÃO — fail-closed
    await assertWithinRateLimit(user.id, gate); // VOLUME — fail-open, com a cota do grupo

    // `req.signal` aborta quando o cliente desconecta (usuário clicou em "Parar", fechou a aba,
    // caiu a rede). Repassá-lo é o que faz o loop parar de gastar tokens numa resposta que ninguém
    // vai receber — ver `throwIfAborted` no gateway.
    const result = await runChat(getAnonClient(), token, parsed.data, req.signal);

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
      truncated: result.truncated,
      iterations: result.iterations,
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
    //
    // Cancelamento é auditado COMO CANCELAMENTO, e continua sendo auditado: os tokens já gastos não
    // voltam, e sumir com eles do log subestimaria o custo real (e faria um "Parar" frequente
    // parecer economia total). O texto é distinto de uma falha para não contaminar a busca por
    // problemas reais no `ai_chat_log`.
    // Consts antes do objeto: ternário aninhado dentro do payload é o smell S3358 do Sonar.
    const detalhe = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof AiChatAbortedError;
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
      // `truncated: false` no caminho de erro é a leitura honesta: não existe resposta para estar
      // cortada. Quem distingue a linha é o `error`, sempre preenchido aqui. Já `iterations` importa
      // muito: é ele que mostra ONDE a pergunta cara parou.
      truncated: false,
      iterations: partial?.iterations ?? 0,
      error: aborted ? 'cancelado pelo cliente' : detalhe,
    });
    // `failFromError` cuida do 499: `AiChatAbortedError` estende ApiServiceError com status < 500,
    // então a mensagem curada ("Consulta cancelada.") é ecoada. Na prática ninguém a lê — o cliente
    // já foi —, mas a resposta permanece coerente com o resto da API.
    return failFromError(e, 'ai-chat');
  }
}
