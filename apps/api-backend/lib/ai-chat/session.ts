// lib/ai-chat/session.ts
// Tudo o que as DUAS rotas do chat (JSON e SSE) fazem em volta do turno: autenticar, validar,
// autorizar e auditar.
//
// 🔴 POR QUE EXISTE. São dois endpoints para o mesmo recurso, e a diferença entre eles é apenas o
// TRANSPORTE da resposta. Com a preparação copiada, o modo de falha não é código feio — é a rota
// nova nascer sem o gate de acesso, ou sem a auditoria da tentativa barrada, e ninguém notar:
// nenhuma das duas ausências produz erro, e o endpoint responde perfeitamente bem enquanto deixa
// de cobrar o que precisa ser cobrado. Reunindo aqui, esquecer passa a ser impossível — não há o
// que copiar.
//
// A rota JSON foi migrada para este módulo com a suíte dela (28 casos) como oráculo: se o
// comportamento tivesse mudado em qualquer ponto — status, mensagem, ordem, campo do log — algum
// deles ficaria vermelho.

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser, getBearerToken } from '@/lib/auth';
import { fail } from '@/lib/response';
import { logInteraction } from '@/lib/ai-chat/log';
import { AiChatAbortedError, readPartialRun } from '@/lib/ai-chat/errors';
import { assertWithinRateLimit } from '@/lib/ai-chat/rate-limit';
import { assertAiChatAllowed } from '@/lib/ai-chat/gate';
import { CONFIGURED_MODEL } from '@/lib/ai-chat/model';
import type { ChatRequest, ChatResult } from '@/lib/ai-chat/gateway';

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

// Contratos consumidos por INFERÊNCIA nas rotas (que desestruturam `aberta.session`), não por
// import nominal — o padrão já usado em `ApiResponse`/`ReaderSummary`.
// ts-prune-ignore-next
export interface ChatSession {
  userId: string;
  /** JWT do usuário — é ele que faz a RLS decidir o recorte, nunca service_role. */
  token: string;
  request: ChatRequest;
}

/**
 * União discriminada em vez de exceção: estes são os erros que acontecem ANTES de qualquer trabalho
 * (401/400/422) e, por isso, ainda podem virar resposta HTTP com status — inclusive na rota SSE,
 * que depois de abrir o stream perde essa possibilidade para sempre.
 */
// ts-prune-ignore-next
export type OpenSessionResult =
  | { ok: true; session: ChatSession }
  | { ok: false; response: Response };

/**
 * Autentica e valida o corpo. Não toca no gate nem na cota: aqueles são auditáveis e pertencem ao
 * `try` de cada rota (ver `assertChatAllowed`).
 */
export async function openChatSession(req: NextRequest): Promise<OpenSessionResult> {
  // getAuthenticatedUser (não requireAuth): precisamos do id para a trilha de auditoria.
  const user = await getAuthenticatedUser(req);
  const token = getBearerToken(req);
  if (!user || !token) return { ok: false, response: fail('Autenticação necessária', 401) };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: fail('Corpo da requisição inválido', 400) };
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail(parsed.error.issues[0]?.message ?? 'Pergunta inválida', 422),
    };
  }

  return { ok: true, session: { userId: user.id, token, request: parsed.data } };
}

/**
 * Os dois porteiros, na ordem — chamados DENTRO do `try` de cada rota, de propósito: o 403 e o 429
 * que eles lançam são `AiChatError` e precisam passar pelo mesmo caminho de auditoria dos demais.
 * Uma tentativa barrada também é sinal de uso (e, no caso do gate, é o sinal de "quem está pedindo
 * acesso"), e sumiria do `ai_chat_log` se escapasse do catch.
 *
 * 🔴 A ORDEM É ESTRUTURAL, não convenção: `assertWithinRateLimit` CONSOME o retorno do gate, então
 * trocar as duas linhas não compila. Autorização primeiro também é o mais barato: uma busca por PK
 * numa tabela de 13 linhas antes de duas contagens sobre uma tabela que cresce para sempre.
 *
 * ⚠️ Consequência aceita: as tentativas de um usuário NEGADO não passam pela cota, então ele poderia
 * inflar o `ai_chat_log`. Limitado na prática (usuários internos autenticados, e o widget nem é
 * renderizado para ele). Se um dia incomodar, a saída é mover o gate para depois do rate limit — ao
 * custo de o usuário negado receber um 429 enganoso na 31ª tentativa.
 */
export async function assertChatAllowed(userId: string): Promise<void> {
  const gate = await assertAiChatAllowed(userId); // AUTORIZAÇÃO — fail-closed
  await assertWithinRateLimit(userId, gate); // VOLUME — fail-open, com a cota do grupo
}

/**
 * Auditoria do turno que deu certo.
 *
 * Gravada ANTES de a resposta terminar e AGUARDADA (§17.3): em serverless a function congela no
 * fim, então fire-and-forget perderia a auditoria silenciosamente. Na rota SSE isso significa
 * gravar antes de `controller.close()`, não antes do `return`.
 */
export async function auditSuccess(p: {
  userId: string;
  question: string;
  startedAt: number;
  result: ChatResult;
}): Promise<void> {
  await logInteraction({
    userId: p.userId,
    question: p.question,
    toolCalls: p.result.toolCalls,
    rowCount: p.result.rowCount,
    latencyMs: Date.now() - p.startedAt,
    inputTokens: p.result.inputTokens,
    outputTokens: p.result.outputTokens,
    cacheReadTokens: p.result.cacheReadTokens,
    cacheCreationTokens: p.result.cacheCreationTokens,
    truncated: p.result.truncated,
    iterations: p.result.iterations,
    model: p.result.model,
  });
}

/**
 * Auditoria do turno que falhou — inclusive o cancelado.
 *
 * A pergunta que falhou também é auditada: é dela que sai "quais tools faltam" (§11). O gateway
 * anexa ao erro o que já havia gasto e apurado; zerar aqui faria a falha de uma pergunta cara
 * (5 iterações antes do 429) ser auditada como "0 tokens, 0 tools".
 *
 * Cancelamento é auditado COMO CANCELAMENTO, e continua sendo auditado: os tokens já gastos não
 * voltam, e sumir com eles do log subestimaria o custo real (e faria um "Parar" frequente parecer
 * economia total). O texto é distinto de uma falha para não contaminar a busca por problemas reais
 * no `ai_chat_log`.
 */
export async function auditFailure(p: {
  userId: string;
  question: string;
  startedAt: number;
  error: unknown;
}): Promise<void> {
  // Consts antes do objeto: ternário aninhado dentro do payload é o smell S3358 do Sonar.
  const detalhe = p.error instanceof Error ? p.error.message : String(p.error);
  const aborted = p.error instanceof AiChatAbortedError;
  const partial = readPartialRun(p.error);

  await logInteraction({
    userId: p.userId,
    question: p.question,
    toolCalls: partial?.toolCalls ?? [],
    rowCount: partial?.rowCount ?? 0,
    latencyMs: Date.now() - p.startedAt,
    inputTokens: partial?.inputTokens ?? 0,
    outputTokens: partial?.outputTokens ?? 0,
    cacheReadTokens: partial?.cacheReadTokens ?? 0,
    cacheCreationTokens: partial?.cacheCreationTokens ?? 0,
    // `truncated: false` no caminho de erro é a leitura honesta: não existe resposta para estar
    // cortada. Quem distingue a linha é o `error`, sempre preenchido aqui. Já `iterations` importa
    // muito: é ele que mostra ONDE a pergunta cara parou.
    truncated: false,
    iterations: partial?.iterations ?? 0,
    // Sem estado parcial (falha ANTES de o gateway chegar a anexá-lo), o configurado é a melhor
    // informação disponível — e é o que impede a linha de erro de sair sem modelo, o que a tiraria
    // de qualquer agregado por modelo justamente onde a atribuição mais importa.
    model: partial?.model ?? CONFIGURED_MODEL,
    error: aborted ? 'cancelado pelo cliente' : detalhe,
  });
}
