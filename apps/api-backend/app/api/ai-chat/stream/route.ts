// app/api/ai-chat/stream/route.ts
// POST /api/ai-chat/stream — a MESMA pergunta da rota irmã, respondida em Server-Sent Events.
//
// POR QUE EXISTE. Medido em 14/08/2026: a latência de um turno é ~6,8 s fixos + ~7,7 ms por token
// gerado. O custo fixo são os dois round-trips ao modelo, e ele não sai trocando de modelo — a
// migração de Opus 5 para Sonnet 5 cortou apenas 9%. O que sobra é deixar de esperar pelo bloco
// inteiro: com streaming o usuário vê a ferramenta sendo consultada em ~3 s e o texto surgindo em
// seguida, em vez de 12 s de tela parada. O tempo total é o mesmo; a espera percebida, não.
//
// O QUE ESTA ROTA **NÃO** MUDA: o turno é o mesmo `runChat`, com o mesmo teto de iterações, o mesmo
// pareamento tool_use/tool_result e a mesma auditoria. O streaming aqui é observação lateral (ver
// `ChatProgress` no gateway) — não há um segundo loop.
//
// 🔴 A FRONTEIRA DO STATUS HTTP. Tudo o que pode ser recusado ANTES de o corpo abrir (401/400/422
// da sessão, 403 do gate, 429 da cota) é recusado com JSON e status, igual à rota irmã. Depois do
// primeiro byte o status já foi enviado e não há mais como corrigi-lo: dali em diante a falha vira
// um evento `error` no stream. Essa divisão é o motivo de `assertChatAllowed` ficar FORA do
// `ReadableStream` — um 403 de acesso negado precisa chegar como 403, não como um stream de
// sucesso que por dentro diz que falhou.

import type { NextRequest } from 'next/server';
import { getAnonClient } from '@/lib/auth';
import { describeClientError, failFromError } from '@/lib/response';
import { runChat } from '@/lib/ai-chat/gateway';
import { SSE_HEADERS, SseWriter } from '@/lib/ai-chat/sse';
import {
  openChatSession,
  assertChatAllowed,
  auditSuccess,
  auditFailure,
} from '@/lib/ai-chat/session';

/** Mesmo teto da rota irmã — ver o comentário lá. */
export const maxDuration = 300;

/**
 * Intervalo do heartbeat.
 *
 * O primeiro evento útil só sai depois da primeira resposta do modelo, e entre o fim de uma
 * ferramenta e o primeiro texto da chamada seguinte a conexão fica ociosa por segundos. Proxies
 * costumam encerrar conexão ociosa; um comentário SSE periódico mantém o caminho vivo sem
 * significar nada para o cliente (linhas iniciadas por `:` são ignoradas por contrato).
 */
const HEARTBEAT_MS = 15_000;

export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();

  const aberta = await openChatSession(req);
  if (!aberta.ok) return aberta.response;
  const { userId, token, request } = aberta.session;

  // Gate e cota ANTES do stream: enquanto não houver corpo, o status HTTP ainda é utilizável.
  // A auditoria da tentativa barrada é a mesma da rota irmã — uma tentativa negada é sinal de uso.
  try {
    await assertChatAllowed(userId);
  } catch (e) {
    await auditFailure({ userId, question: request.question, startedAt, error: e });
    return failFromError(e, 'ai-chat-stream');
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      // Sai imediatamente: confirma ao cliente que o transporte é mesmo streaming (é o que desarma
      // o fallback dele) e ocupa a conexão antes da primeira resposta do modelo.
      writer.send({ type: 'open' });

      const heartbeat = setInterval(() => writer.comment('keep-alive'), HEARTBEAT_MS);

      try {
        const result = await runChat(getAnonClient(), token, request, req.signal, {
          onToolStart: (c) => writer.send({ type: 'tool', name: c.name, params: c.params }),
          onToolEnd: (c) => writer.send({
            type: 'tool_end', name: c.name, rows: c.rows, ms: c.ms, error: c.error,
          }),
          onTextStart: () => writer.send({ type: 'text_start' }),
          onTextDelta: (text) => writer.send({ type: 'delta', text }),
        });

        // 🔴 Auditoria ANTES do `done` e do `close` (§17.3). Em serverless a function é congelada
        // quando o corpo termina; gravar depois de fechar é gravar em nada. Na rota JSON o marco é
        // o `return`, aqui é o fechamento do stream — o princípio é o mesmo, o ponto é outro.
        await auditSuccess({ userId, question: request.question, startedAt, result });

        // O `answer` canônico vai junto, mesmo com o texto já streamado: é ele que o cliente grava
        // na conversa. Sem isso, o histórico dependeria da concatenação feita no navegador, que
        // pode ter perdido um frame — e o histórico é o que volta ao modelo na próxima pergunta.
        writer.send({
          type: 'done',
          answer: result.answer,
          tool_calls: result.toolCalls.map((t) => ({ name: t.name, params: t.params, rows: t.rows })),
          truncated: result.truncated,
        });
      } catch (e) {
        await auditFailure({ userId, question: request.question, startedAt, error: e });
        // Mesma regra de eco da rota JSON, pelo MESMO helper: um 5xx não-curado vira mensagem
        // genérica aqui também. O `status` viaja no evento para o cliente distinguir o que dá para
        // tentar de novo (429, 503) do que não dá (403).
        const { status, message } = describeClientError(e, 'ai-chat-stream');
        writer.send({ type: 'error', message, status });
      } finally {
        clearInterval(heartbeat);
        writer.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
